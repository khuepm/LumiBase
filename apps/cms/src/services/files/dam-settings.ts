/**
 * Per-site digital-asset-management settings, stored in `settings` under key
 * `files.dam`. Every field is optional; absent → the defaults below, which
 * reproduce the pre-#670 behaviour as closely as the new features allow.
 */
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { scopeSite, settings, type Database } from '@lumibase/database';
import { patchSchema } from '../../utils/patch-schema';

export const DAM_SETTINGS_KEY = 'files.dam';

export const damSettingsSchema = z
  .object({
    /**
     * What `DELETE /files/:id` does with a file that content still references
     * (#706): `confirm` (default) refuses with the reference list unless the
     * caller repeats the request with `?confirm=true`; `block` never deletes
     * a referenced file — clear the references first.
     */
    deletePolicy: z.enum(['confirm', 'block']).default('confirm'),
    /** Days a replaced binary is kept for undo (#703). 0 = keep no history. */
    versionRetentionDays: z.number().int().min(0).max(3650).default(30),
    /**
     * Strip GPS positions from the bytes the public delivery route serves
     * (#705). The stored original keeps them; editors still see them in the
     * extracted metadata.
     */
    stripGpsOnPublic: z.boolean().default(false),
    /** Extract EXIF/IPTC/XMP on registration and replace (#705). */
    extractMetadata: z.boolean().default(true),
    /**
     * Malware scanning (#707). Off by default. When on, new and replaced
     * binaries start `pending` and are not served until a scan says `clean`.
     */
    scan: z
      .object({
        enabled: z.boolean().default(false),
        /** Scanner adapter: `http` (any REST scanner, incl. a ClamAV sidecar). */
        provider: z.enum(['http']).default('http'),
        /**
         * What to do when the scanner is unreachable or errors: `quarantine`
         * (default, fail closed) keeps the file unserved as `error`; `allow`
         * marks it `clean`.
         */
        onError: z.enum(['quarantine', 'allow']).default('quarantine'),
      })
      .default({ enabled: false, provider: 'http', onError: 'quarantine' }),
    /**
     * Video pipeline (#871). Off by default. When on and the deployment has a
     * video provider (`VIDEO_PROVIDER`), uploaded `video/*` files are sent to
     * it for transcoding (renditions + HLS + poster).
     */
    video: z
      .object({
        enabled: z.boolean().default(false),
        /** Playback URLs are provider-signed and expire (`playbackTtlSeconds`). */
        signedPlayback: z.boolean().default(true),
        playbackTtlSeconds: z.number().int().min(60).max(86_400).default(3600),
      })
      .default({ enabled: false, signedPlayback: true, playbackTtlSeconds: 3600 }),
  })
  .strict();

export type DamSettings = z.infer<typeof damSettingsSchema>;

export const DEFAULT_DAM_SETTINGS: DamSettings = damSettingsSchema.parse({});

/** Partial update accepted by `PUT /files/settings` (keys the caller omits are kept). */
export const damSettingsUpdateSchema = patchSchema(damSettingsSchema);

/** Merge a stored value onto the defaults; an invalid stored value → defaults. */
export function parseDamSettings(raw: unknown): DamSettings {
  const parsed = damSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_DAM_SETTINGS;
}

export async function loadDamSettings(db: Database, siteId: string): Promise<DamSettings> {
  try {
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.key, DAM_SETTINGS_KEY), scopeSite(settings.siteId, siteId)))
      .limit(1);
    return parseDamSettings(row?.value);
  } catch {
    return DEFAULT_DAM_SETTINGS;
  }
}

export async function saveDamSettings(db: Database, siteId: string, next: DamSettings): Promise<DamSettings> {
  const value = damSettingsSchema.parse(next);
  await db
    .insert(settings)
    .values({ siteId, key: DAM_SETTINGS_KEY, value, scope: 'site' })
    .onConflictDoUpdate({
      target: [settings.siteId, settings.key],
      set: { value, scope: 'site', updatedAt: new Date() },
    });
  return value;
}
