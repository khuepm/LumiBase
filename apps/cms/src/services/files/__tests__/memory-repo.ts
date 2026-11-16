import { nanoid } from 'nanoid';
import type { StorageObject, StorageProvider } from '@lumibase/runtime';
import type { FolderRow } from '../folder-tree';
import type {
  FileContentPatch,
  FileInsert,
  FileListFilter,
  FileRecord,
  FileRepository,
  FileVersionInsert,
  FileVersionRecord,
} from '../file-repository';

/** In-memory FileRepository for one site; `others` simulates rows of other sites. */
export class MemoryFileRepository implements FileRepository {
  files = new Map<string, FileRecord>();
  versions = new Map<string, FileVersionRecord>();
  folders: FolderRow[] = [];

  constructor(readonly siteId: string) {}

  seed(partial: Partial<FileRecord> & { id: string; filenameDisk: string }): FileRecord {
    const row: FileRecord = {
      siteId: this.siteId,
      storage: 'r2',
      filenameDownload: partial.filenameDisk,
      mime: 'image/jpeg',
      filesize: 0,
      width: null,
      height: null,
      duration: null,
      folder: null,
      metadata: {},
      uploadedBy: null,
      contentHash: null,
      version: 1,
      scanStatus: 'skipped',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...partial,
    };
    this.files.set(row.id, row);
    return row;
  }

  async get(id: string) {
    const f = this.files.get(id);
    return f && f.siteId === this.siteId ? { ...f } : null;
  }

  async getMany(ids: string[]) {
    return ids.map((id) => this.files.get(id)).filter((f): f is FileRecord => !!f && f.siteId === this.siteId);
  }

  async update(id: string, patch: FileContentPatch, expectedVersion?: number) {
    const f = this.files.get(id);
    if (!f || f.siteId !== this.siteId) return null;
    if (expectedVersion !== undefined && f.version !== expectedVersion) return null;
    const next = { ...f, ...patch, updatedAt: new Date() } as FileRecord;
    this.files.set(id, next);
    return { ...next };
  }

  async remove(id: string) {
    const f = this.files.get(id);
    if (!f || f.siteId !== this.siteId) return null;
    this.files.delete(id);
    for (const [vid, v] of this.versions) if (v.fileId === id) this.versions.delete(vid);
    return f;
  }

  async findByHash(hash: string, excludeId?: string) {
    return [...this.files.values()].filter((f) => f.siteId === this.siteId && f.contentHash === hash && f.id !== excludeId);
  }

  async insertVersion(row: FileVersionInsert) {
    const v: FileVersionRecord = { ...row, id: nanoid(), siteId: this.siteId, createdAt: new Date() };
    this.versions.set(v.id, v);
    return v;
  }

  async listVersions(fileId: string) {
    return [...this.versions.values()]
      .filter((v) => v.siteId === this.siteId && v.fileId === fileId)
      .sort((a, b) => b.version - a.version);
  }

  async getVersion(fileId: string, versionId: string) {
    const v = this.versions.get(versionId);
    return v && v.fileId === fileId && v.siteId === this.siteId ? v : null;
  }

  async deleteVersion(versionId: string) {
    this.versions.delete(versionId);
  }

  async expiredVersions(now: Date, limit: number) {
    return [...this.versions.values()]
      .filter((v) => v.siteId === this.siteId && v.expiresAt.getTime() < now.getTime())
      .slice(0, limit);
  }

  async listFolders() {
    return this.folders;
  }

  private all(): FileRecord[] {
    return [...this.files.values()].filter((f) => f.siteId === this.siteId);
  }

  async list(filter: FileListFilter) {
    let rows = this.all();
    if (filter.folders) rows = rows.filter((f) => filter.folders!.includes(f.folder));
    if (filter.ids) rows = rows.filter((f) => filter.ids!.includes(f.id));
    if (filter.mime?.length) {
      rows = rows.filter((f) => filter.mime!.some((m) => (m.endsWith('/*') ? f.mime.startsWith(m.slice(0, -1)) : f.mime === m)));
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      rows = rows.filter((f) => {
        const meta = f.metadata as Record<string, unknown>;
        return [f.filenameDownload, meta.searchText, meta.alt, meta.caption, meta.title, JSON.stringify(meta.tags ?? '')]
          .some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
      });
    }
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id));
    return { rows: rows.slice(filter.offset, filter.offset + filter.limit), total: rows.length };
  }

  async insert(row: FileInsert) {
    return this.seed({ id: nanoid(), ...row, createdAt: new Date(), updatedAt: new Date() });
  }

  async move(ids: string[], folder: string | null) {
    const out: FileRecord[] = [];
    for (const id of ids) {
      const r = await this.update(id, { folder });
      if (r) out.push(r);
    }
    return out;
  }

  async mergeMetadata(ids: string[], metadata: Record<string, unknown>) {
    const out: FileRecord[] = [];
    for (const id of ids) {
      const f = await this.get(id);
      if (!f) continue;
      const r = await this.update(id, { metadata: { ...(f.metadata as Record<string, unknown>), ...metadata } });
      if (r) out.push(r);
    }
    return out;
  }

  async createFolder(input: { name: string; parent: string | null }) {
    const row = { id: nanoid(), ...input };
    this.folders.push(row);
    return row;
  }

  async updateFolder(id: string, patch: { name?: string; parent?: string | null }) {
    const i = this.folders.findIndex((f) => f.id === id);
    if (i < 0) return null;
    this.folders[i] = { ...this.folders[i]!, ...patch };
    return this.folders[i]!;
  }

  async deleteFolder(id: string) {
    const i = this.folders.findIndex((f) => f.id === id);
    if (i < 0) return null;
    return this.folders.splice(i, 1)[0]!;
  }

  async folderContents(id: string) {
    return {
      files: this.all().filter((f) => f.folder === id).length,
      folders: this.folders.filter((f) => f.parent === id).length,
    };
  }
}

export class MemoryStorage implements StorageProvider {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  failPutFor = new Set<string>();

  async put(key: string, data: ReadableStream | Buffer, metadata: Record<string, string> = {}) {
    if (this.failPutFor.has(key)) throw new Error('disk full');
    const bytes = new Uint8Array(await new Response(data as BodyInit).arrayBuffer());
    this.objects.set(key, { bytes, metadata });
  }

  async get(key: string): Promise<StorageObject | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      key,
      body: Buffer.from(o.bytes),
      contentType: o.metadata.contentType,
      size: o.bytes.byteLength,
      metadata: o.metadata,
    };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  async list(prefix = '') {
    return { keys: [...this.objects.keys()].filter((k) => k.startsWith(prefix)) };
  }

  text(key: string): string | undefined {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.bytes) : undefined;
  }
}
