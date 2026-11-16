/**
 * Site-scoped persistence port for the files module. The asset service talks
 * to this interface, so its replace / restore / delete logic is unit-tested
 * against an in-memory store while the Drizzle implementation below stays a
 * thin, typechecked mapping. Every Drizzle query carries `site_id`.
 */
import { and, asc, count, desc, eq, ilike, inArray, isNull, like, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { fileVersions, files, folders, type Database } from '@lumibase/database';
import { containsPattern, startsWithPattern } from '../like-pattern';
import type { FolderRow } from './folder-tree';

export type FileRecord = typeof files.$inferSelect;
export type FileVersionRecord = typeof fileVersions.$inferSelect;
export type FileVersionInsert = Omit<FileVersionRecord, 'id' | 'createdAt' | 'siteId'>;

/** Fields an in-place replace (or a scan verdict) may change on the file row. */
export type FileContentPatch = Partial<
  Pick<
    FileRecord,
    | 'filenameDownload'
    | 'mime'
    | 'filesize'
    | 'width'
    | 'height'
    | 'metadata'
    | 'contentHash'
    | 'version'
    | 'scanStatus'
    | 'folder'
  >
>;

export type FileInsert = Pick<FileRecord, 'filenameDisk' | 'filenameDownload' | 'mime' | 'filesize'> &
  Partial<Pick<FileRecord, 'width' | 'height' | 'folder' | 'metadata' | 'uploadedBy' | 'scanStatus' | 'storage'>>;

export interface FileListFilter {
  /** `undefined` = every folder; `null` = root only; otherwise that folder id(s). */
  folders?: Array<string | null>;
  /** Case-insensitive match on filename, alt/title/caption/tags and extracted metadata. */
  search?: string;
  /** Exact MIME (`image/png`) or a type prefix (`image/*`). Several = OR. */
  mime?: string[];
  ids?: string[];
  limit: number;
  offset: number;
}

export interface FileRepository {
  readonly siteId: string;
  get(id: string): Promise<FileRecord | null>;
  getMany(ids: string[]): Promise<FileRecord[]>;
  /**
   * Conditional update: applies only while the row is still at
   * `expectedVersion` (optimistic concurrency for replace). Omit it for an
   * unconditional update. Returns null when nothing matched.
   */
  update(id: string, patch: FileContentPatch, expectedVersion?: number): Promise<FileRecord | null>;
  remove(id: string): Promise<FileRecord | null>;
  findByHash(contentHash: string, excludeId?: string): Promise<FileRecord[]>;
  insertVersion(row: FileVersionInsert): Promise<FileVersionRecord>;
  listVersions(fileId: string): Promise<FileVersionRecord[]>;
  getVersion(fileId: string, versionId: string): Promise<FileVersionRecord | null>;
  deleteVersion(versionId: string): Promise<void>;
  /** Versions whose retention ended before `now`, oldest first. */
  expiredVersions(now: Date, limit: number): Promise<FileVersionRecord[]>;
  listFolders(): Promise<FolderRow[]>;
  list(filter: FileListFilter): Promise<{ rows: FileRecord[]; total: number }>;
  insert(row: FileInsert): Promise<FileRecord>;
  /** Re-home files; returns the rows that moved. */
  move(ids: string[], folder: string | null): Promise<FileRecord[]>;
  /** Shallow-merge `metadata` into each file's metadata (bulk alt/caption/tags). */
  mergeMetadata(ids: string[], metadata: Record<string, unknown>): Promise<FileRecord[]>;
  createFolder(input: { name: string; parent: string | null }): Promise<FolderRow>;
  updateFolder(id: string, patch: { name?: string; parent?: string | null }): Promise<FolderRow | null>;
  deleteFolder(id: string): Promise<FolderRow | null>;
  /** How many files and direct sub-folders a folder holds. */
  folderContents(id: string): Promise<{ files: number; folders: number }>;
}

export class DrizzleFileRepository implements FileRepository {
  constructor(
    private readonly db: Database,
    readonly siteId: string,
  ) {}

  async get(id: string): Promise<FileRecord | null> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.siteId, this.siteId), eq(files.id, id)))
      .limit(1);
    return row ?? null;
  }

  async getMany(ids: string[]): Promise<FileRecord[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(files)
      .where(and(eq(files.siteId, this.siteId), inArray(files.id, ids)));
  }

  async update(id: string, patch: FileContentPatch, expectedVersion?: number): Promise<FileRecord | null> {
    const conditions = [eq(files.siteId, this.siteId), eq(files.id, id)];
    if (expectedVersion !== undefined) conditions.push(eq(files.version, expectedVersion));
    const [row] = await this.db
      .update(files)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  }

  async remove(id: string): Promise<FileRecord | null> {
    const [row] = await this.db
      .delete(files)
      .where(and(eq(files.siteId, this.siteId), eq(files.id, id)))
      .returning();
    return row ?? null;
  }

  async findByHash(contentHash: string, excludeId?: string): Promise<FileRecord[]> {
    const conditions = [eq(files.siteId, this.siteId), eq(files.contentHash, contentHash)];
    if (excludeId) conditions.push(ne(files.id, excludeId));
    return this.db
      .select()
      .from(files)
      .where(and(...conditions))
      .orderBy(asc(files.createdAt))
      .limit(20);
  }

  async insertVersion(row: FileVersionInsert): Promise<FileVersionRecord> {
    const [inserted] = await this.db
      .insert(fileVersions)
      .values({ ...row, siteId: this.siteId })
      .returning();
    if (!inserted) throw new Error('file version insert returned no row');
    return inserted;
  }

  async listVersions(fileId: string): Promise<FileVersionRecord[]> {
    return this.db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.siteId, this.siteId), eq(fileVersions.fileId, fileId)))
      .orderBy(desc(fileVersions.version));
  }

  async getVersion(fileId: string, versionId: string): Promise<FileVersionRecord | null> {
    const [row] = await this.db
      .select()
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.siteId, this.siteId),
          eq(fileVersions.fileId, fileId),
          eq(fileVersions.id, versionId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async deleteVersion(versionId: string): Promise<void> {
    await this.db
      .delete(fileVersions)
      .where(and(eq(fileVersions.siteId, this.siteId), eq(fileVersions.id, versionId)));
  }

  async expiredVersions(now: Date, limit: number): Promise<FileVersionRecord[]> {
    return this.db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.siteId, this.siteId), lt(fileVersions.expiresAt, now)))
      .orderBy(asc(fileVersions.expiresAt))
      .limit(limit);
  }

  async listFolders(): Promise<FolderRow[]> {
    return this.db
      .select({ id: folders.id, name: folders.name, parent: folders.parent })
      .from(folders)
      .where(eq(folders.siteId, this.siteId))
      .orderBy(sql`lower(${folders.name})`);
  }

  private filterConditions(filter: Omit<FileListFilter, 'limit' | 'offset'>): SQL[] {
    const conditions: SQL[] = [eq(files.siteId, this.siteId)];
    if (filter.folders) {
      const ids = filter.folders.filter((f): f is string => f !== null);
      const parts: SQL[] = [];
      if (ids.length) parts.push(inArray(files.folder, ids));
      if (filter.folders.includes(null)) parts.push(isNull(files.folder));
      conditions.push(parts.length ? or(...parts)! : sql`false`);
    }
    if (filter.ids) conditions.push(filter.ids.length ? inArray(files.id, filter.ids) : sql`false`);
    if (filter.mime?.length) {
      conditions.push(
        or(
          ...filter.mime.map((m) =>
            m.endsWith('/*') ? like(files.mime, startsWithPattern(m.slice(0, -1))) : eq(files.mime, m),
          ),
        )!,
      );
    }
    if (filter.search) {
      const p = containsPattern(filter.search);
      conditions.push(
        or(
          ilike(files.filenameDownload, p),
          sql`coalesce(${files.metadata}->>'searchText', '') ILIKE ${p}`,
          sql`coalesce(${files.metadata}->>'title', '') ILIKE ${p}`,
          sql`coalesce(${files.metadata}->>'alt', '') ILIKE ${p}`,
          sql`coalesce(${files.metadata}->>'caption', '') ILIKE ${p}`,
          sql`coalesce((${files.metadata}->'tags')::text, '') ILIKE ${p}`,
        )!,
      );
    }
    return conditions;
  }

  async list(filter: FileListFilter): Promise<{ rows: FileRecord[]; total: number }> {
    const where = and(...this.filterConditions(filter));
    const rows = await this.db
      .select()
      .from(files)
      .where(where)
      .orderBy(desc(files.createdAt), asc(files.id))
      .limit(filter.limit)
      .offset(filter.offset);
    const [totalRow] = await this.db.select({ n: count() }).from(files).where(where);
    return { rows, total: Number(totalRow?.n ?? rows.length) };
  }

  async insert(row: FileInsert): Promise<FileRecord> {
    const [inserted] = await this.db
      .insert(files)
      .values({ storage: 'r2', ...row, siteId: this.siteId })
      .returning();
    if (!inserted) throw new Error('file insert returned no row');
    return inserted;
  }

  async move(ids: string[], folder: string | null): Promise<FileRecord[]> {
    if (ids.length === 0) return [];
    return this.db
      .update(files)
      .set({ folder, updatedAt: new Date() })
      .where(and(eq(files.siteId, this.siteId), inArray(files.id, ids)))
      .returning();
  }

  async mergeMetadata(ids: string[], metadata: Record<string, unknown>): Promise<FileRecord[]> {
    if (ids.length === 0) return [];
    return this.db
      .update(files)
      .set({ metadata: sql`${files.metadata} || ${JSON.stringify(metadata)}::jsonb`, updatedAt: new Date() })
      .where(and(eq(files.siteId, this.siteId), inArray(files.id, ids)))
      .returning();
  }

  async createFolder(input: { name: string; parent: string | null }): Promise<FolderRow> {
    const [row] = await this.db
      .insert(folders)
      .values({ ...input, siteId: this.siteId })
      .returning({ id: folders.id, name: folders.name, parent: folders.parent });
    if (!row) throw new Error('folder insert returned no row');
    return row;
  }

  async updateFolder(id: string, patch: { name?: string; parent?: string | null }): Promise<FolderRow | null> {
    const [row] = await this.db
      .update(folders)
      .set(patch)
      .where(and(eq(folders.siteId, this.siteId), eq(folders.id, id)))
      .returning({ id: folders.id, name: folders.name, parent: folders.parent });
    return row ?? null;
  }

  async deleteFolder(id: string): Promise<FolderRow | null> {
    const [row] = await this.db
      .delete(folders)
      .where(and(eq(folders.siteId, this.siteId), eq(folders.id, id)))
      .returning({ id: folders.id, name: folders.name, parent: folders.parent });
    return row ?? null;
  }

  async folderContents(id: string): Promise<{ files: number; folders: number }> {
    const [f] = await this.db
      .select({ n: count() })
      .from(files)
      .where(and(eq(files.siteId, this.siteId), eq(files.folder, id)));
    const [d] = await this.db
      .select({ n: count() })
      .from(folders)
      .where(and(eq(folders.siteId, this.siteId), eq(folders.parent, id)));
    return { files: Number(f?.n ?? 0), folders: Number(d?.n ?? 0) };
  }
}
