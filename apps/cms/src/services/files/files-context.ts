/**
 * Request wiring for the files module: builds the site-scoped repository,
 * usage source, settings, scanner and access decision from a Hono context.
 * Kept in one module so route tests can substitute in-memory doubles.
 */
import type { Context } from 'hono';
import type { StorageProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { isSiteAdmin } from '../../middleware/site-admin';
import { AuditLogger } from '../../modules/audit/logger';
import { scannerFromEnv, type MalwareScanner, type ScanAuditEntry } from '../../modules/malware-scan';
import { buildRequestPermissionContext, permissionServiceForRequest } from '../item-service-factory';
import { and, eq } from 'drizzle-orm';
import { scopeSite, settings as settingsTable, type Database } from '@lumibase/database';
import { DrizzleCaptionRepository, type CaptionRepository } from './captions';
import { loadDamSettings, type DamSettings } from './dam-settings';
import type { FilesAccess, FilesAction } from './file-access';
import { DrizzleFileRepository, type FileRepository } from './file-repository';
import { DrizzleFileUsageSource, type FileUsageSource } from './file-usage';

export interface FilesContext {
  siteId: string;
  repo: FileRepository;
  usage: FileUsageSource;
  storage: StorageProvider;
  settings: DamSettings;
  scanner: MalwareScanner | null;
  audit: (entry: ScanAuditEntry) => Promise<void>;
  /** Caption/subtitle tracks of videos (#871). */
  captions?: CaptionRepository;
  /** The site's locales (`settings.locales.supported`). */
  locales?: () => Promise<string[]>;
}

export async function filesContext(c: Context<AppEnv>): Promise<FilesContext> {
  const db = c.get('db');
  const siteId = c.get('siteId');
  return {
    siteId,
    repo: new DrizzleFileRepository(db, siteId),
    usage: new DrizzleFileUsageSource(db, siteId),
    storage: c.get('runtime').storage,
    settings: await loadDamSettings(db, siteId),
    scanner: scannerFromEnv(c.env as unknown as Record<string, unknown> | undefined),
    captions: new DrizzleCaptionRepository(db, siteId),
    locales: () => siteLocales(db, siteId),
    audit: async (entry) => {
      await new AuditLogger({ db, siteId }).write({
        event: entry.event,
        metadata: { ...entry },
      });
    },
  };
}

/** Site locales from the `locales` setting (`value.supported`), as Studio reads them. */
export async function siteLocales(db: Database, siteId: string): Promise<string[]> {
  const [row] = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(and(eq(settingsTable.key, 'locales'), scopeSite(settingsTable.siteId, siteId)))
    .limit(1);
  const supported = (row?.value as { supported?: unknown } | undefined)?.supported;
  return Array.isArray(supported) ? supported.filter((l): l is string => typeof l === 'string') : ['en', 'vi'];
}

function requestHeaders(c: Context<AppEnv>): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/**
 * Resolve the caller's access to the files module for `action`, or null when
 * it has none. Site admins bypass folder rules; everyone else needs a
 * `files::<action>` grant whose rule is then evaluated per file.
 */
export async function resolveFilesAccess(c: Context<AppEnv>, action: FilesAction): Promise<FilesAccess | null> {
  const ctx = buildRequestPermissionContext({
    auth: c.get('auth'),
    siteId: c.get('siteId'),
    headers: requestHeaders(c),
    ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
  });
  if (await isSiteAdmin(c)) return { admin: true, rule: null, ctx };
  const perm = await permissionServiceForRequest(c).canAccess('files', action);
  if (!perm) return null;
  return { admin: false, rule: perm.rule, ctx };
}

export { isSiteAdmin };
