/**
 * Caption and subtitle tracks of a video (#871). A track links a video file
 * to a WebVTT file in the library for one locale and `<track kind>`. The
 * caption file stays an ordinary asset: its own permissions, versions and
 * replace-in-place, so fixing a typo in a subtitle keeps every link.
 *
 * Rules enforced here (the route only maps errors):
 * - the target is a `video/*` file, the track a `text/vtt` file, same site;
 * - the locale is one of the site's locales (`settings.locales.supported`);
 * - one track per (video, locale, kind); at most one default per video and kind.
 */
import { and, asc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { fileCaptions, type Database } from '@lumibase/database';
import { FileAssetError } from './file-asset-service';
import type { FileRecord, FileRepository } from './file-repository';

export const CAPTION_KINDS = ['subtitles', 'captions', 'descriptions', 'chapters'] as const;
export type CaptionKind = (typeof CAPTION_KINDS)[number];
export const CAPTION_MIME = 'text/vtt';

export type CaptionRecord = typeof fileCaptions.$inferSelect;
export type CaptionPatch = Partial<Pick<CaptionRecord, 'locale' | 'kind' | 'label' | 'isDefault' | 'captionFileId'>>;

const localeSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'Locale must be a BCP 47 tag, e.g. `en` or `pt-BR`.');

export const captionCreateSchema = z
  .object({
    captionFileId: z.string().min(1),
    locale: localeSchema,
    kind: z.enum(CAPTION_KINDS).default('subtitles'),
    label: z.string().trim().min(1).max(100).nullable().optional(),
    isDefault: z.boolean().default(false),
  })
  .strict();

export const captionPatchSchema = z
  .object({
    captionFileId: z.string().min(1),
    locale: localeSchema,
    kind: z.enum(CAPTION_KINDS),
    label: z.string().trim().min(1).max(100).nullable(),
    isDefault: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update.' });

export interface CaptionRepository {
  readonly siteId: string;
  list(fileId: string): Promise<CaptionRecord[]>;
  get(fileId: string, id: string): Promise<CaptionRecord | null>;
  insert(row: Omit<CaptionRecord, 'id' | 'siteId' | 'createdAt' | 'updatedAt'>): Promise<CaptionRecord>;
  update(fileId: string, id: string, patch: CaptionPatch): Promise<CaptionRecord | null>;
  remove(fileId: string, id: string): Promise<CaptionRecord | null>;
  /** Clear `isDefault` on every other track of this video and kind. */
  clearDefault(fileId: string, kind: string, exceptId: string): Promise<void>;
}

export class DrizzleCaptionRepository implements CaptionRepository {
  constructor(
    private readonly db: Database,
    readonly siteId: string,
  ) {}

  private scope(fileId: string) {
    return and(eq(fileCaptions.siteId, this.siteId), eq(fileCaptions.fileId, fileId));
  }

  list(fileId: string): Promise<CaptionRecord[]> {
    return this.db.select().from(fileCaptions).where(this.scope(fileId)).orderBy(asc(fileCaptions.locale), asc(fileCaptions.kind));
  }

  async get(fileId: string, id: string): Promise<CaptionRecord | null> {
    const [row] = await this.db.select().from(fileCaptions).where(and(this.scope(fileId), eq(fileCaptions.id, id))).limit(1);
    return row ?? null;
  }

  async insert(row: Omit<CaptionRecord, 'id' | 'siteId' | 'createdAt' | 'updatedAt'>): Promise<CaptionRecord> {
    const [created] = await this.db.insert(fileCaptions).values({ ...row, siteId: this.siteId }).returning();
    return created!;
  }

  async update(fileId: string, id: string, patch: CaptionPatch): Promise<CaptionRecord | null> {
    const [row] = await this.db
      .update(fileCaptions)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(this.scope(fileId), eq(fileCaptions.id, id)))
      .returning();
    return row ?? null;
  }

  async remove(fileId: string, id: string): Promise<CaptionRecord | null> {
    const [row] = await this.db.delete(fileCaptions).where(and(this.scope(fileId), eq(fileCaptions.id, id))).returning();
    return row ?? null;
  }

  async clearDefault(fileId: string, kind: string, exceptId: string): Promise<void> {
    await this.db
      .update(fileCaptions)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(this.scope(fileId), eq(fileCaptions.kind, kind), ne(fileCaptions.id, exceptId), eq(fileCaptions.isDefault, true)));
  }
}

/** Unique-violation from Postgres (one track per video, locale and kind). */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export interface CaptionServiceDeps {
  repo: FileRepository;
  captions: CaptionRepository;
  /** The site's locales; a track for any other locale is refused. */
  locales: () => Promise<string[]>;
  /** May the caller attach this caption file? (read access to it). */
  canUseFile: (file: FileRecord) => boolean;
}

export class CaptionService {
  constructor(private readonly deps: CaptionServiceDeps) {}

  private async requireVideo(video: FileRecord): Promise<void> {
    if (!video.mime.toLowerCase().startsWith('video/')) {
      throw new FileAssetError('NOT_A_VIDEO', 'Captions can only be attached to video/* files.', 422);
    }
  }

  private async requireCaptionFile(id: string): Promise<FileRecord> {
    const file = await this.deps.repo.get(id);
    if (!file || !this.deps.canUseFile(file)) throw new FileAssetError('CAPTION_FILE_NOT_FOUND', 'Caption file not found.', 404);
    if (file.mime.toLowerCase() !== CAPTION_MIME) {
      throw new FileAssetError('CAPTION_NOT_VTT', `Caption files must be WebVTT (${CAPTION_MIME}).`, 415, { mime: file.mime });
    }
    return file;
  }

  private async requireLocale(locale: string): Promise<void> {
    const locales = await this.deps.locales();
    if (!locales.includes(locale)) {
      throw new FileAssetError('LOCALE_NOT_ENABLED', `Locale "${locale}" is not one of the site's locales.`, 422, { locales });
    }
  }

  list(video: FileRecord): Promise<CaptionRecord[]> {
    return this.deps.captions.list(video.id);
  }

  async add(video: FileRecord, input: z.infer<typeof captionCreateSchema>, userId: string | null): Promise<CaptionRecord> {
    await this.requireVideo(video);
    await this.requireCaptionFile(input.captionFileId);
    await this.requireLocale(input.locale);
    let row: CaptionRecord;
    try {
      row = await this.deps.captions.insert({
        fileId: video.id,
        captionFileId: input.captionFileId,
        locale: input.locale,
        kind: input.kind,
        label: input.label ?? null,
        isDefault: input.isDefault,
        createdBy: userId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new FileAssetError('CAPTION_EXISTS', `This video already has a ${input.kind} track for "${input.locale}".`, 409);
      }
      throw err;
    }
    if (row.isDefault) await this.deps.captions.clearDefault(video.id, row.kind, row.id);
    return row;
  }

  async update(video: FileRecord, id: string, patch: z.infer<typeof captionPatchSchema>): Promise<CaptionRecord> {
    const current = await this.deps.captions.get(video.id, id);
    if (!current) throw new FileAssetError('NOT_FOUND', 'Caption track not found.', 404);
    if (patch.captionFileId !== undefined) await this.requireCaptionFile(patch.captionFileId);
    if (patch.locale !== undefined && patch.locale !== current.locale) await this.requireLocale(patch.locale);
    let row: CaptionRecord | null;
    try {
      row = await this.deps.captions.update(video.id, id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) throw new FileAssetError('CAPTION_EXISTS', 'Another track already uses that locale and kind.', 409);
      throw err;
    }
    if (!row) throw new FileAssetError('NOT_FOUND', 'Caption track not found.', 404);
    if (row.isDefault) await this.deps.captions.clearDefault(video.id, row.kind, row.id);
    return row;
  }

  async remove(video: FileRecord, id: string): Promise<void> {
    const removed = await this.deps.captions.remove(video.id, id);
    if (!removed) throw new FileAssetError('NOT_FOUND', 'Caption track not found.', 404);
  }
}

/** Public shape: the link plus what a `<track>` element needs. */
export function presentCaption(row: CaptionRecord, captionFile: FileRecord | null, src: (fileId: string, version: number) => string) {
  return {
    id: row.id,
    fileId: row.fileId,
    captionFileId: row.captionFileId,
    locale: row.locale,
    kind: row.kind,
    label: row.label ?? captionFile?.filenameDownload ?? row.locale,
    isDefault: row.isDefault,
    src: captionFile ? src(captionFile.id, captionFile.version) : null,
    captionVersion: captionFile?.version ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
