/**
 * Digital asset lifecycle for `lumibase_files` (#670):
 *
 *  - ingest       — hash + EXIF/IPTC/XMP extraction for a registered binary (#705, #706)
 *  - replace      — new bytes behind the same id AND the same storage key (#703)
 *  - versions     — previous binaries kept `versionRetentionDays` for undo (#703)
 *  - duplicates   — content-hash lookup (#706)
 *  - safe delete  — refuses / requires confirm while content references the file (#706)
 *
 * Replace keeps the storage key on purpose: the Studio `file` interface stores
 * `filename_disk` inside item data, so a new key would silently break every
 * reference. The previous bytes are copied to a per-version archive key first,
 * the row is moved to the next version under an optimistic-concurrency guard,
 * and only then are the new bytes written over the live key. If that write
 * fails the row is rolled back, so the row never points at bytes that are not
 * there.
 *
 * Runtime-neutral: only the StorageProvider port and Web Crypto are used.
 */
import type { StorageProvider } from '@lumibase/runtime';
import type { DamSettings } from './dam-settings';
import type { FileContentPatch, FileRecord, FileRepository, FileVersionRecord } from './file-repository';
import { fileUsage, type FileUsageReport, type FileUsageSource } from './file-usage';
import { extractMediaMetadata, metadataSearchText, type ExtractedMetadata } from './media-metadata';

export class FileAssetError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 503 = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FileAssetError';
  }
}

/** Objects larger than this are not read back for hashing/extraction at registration. */
export const INGEST_READ_LIMIT = 64 * 1024 * 1024;

/** Metadata keys the service owns; everything else on `files.metadata` is editorial. */
const EMBEDDED_KEY = 'embedded';
const SEARCH_KEY = 'searchText';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface IngestResult {
  contentHash: string;
  filesize: number;
  width: number | null;
  height: number | null;
  embedded: ExtractedMetadata | null;
}

export async function ingestBytes(bytes: Uint8Array, opts: { extractMetadata: boolean }): Promise<IngestResult> {
  const embedded = opts.extractMetadata ? extractMediaMetadata(bytes) : null;
  return {
    contentHash: await sha256Hex(bytes),
    filesize: bytes.byteLength,
    width: embedded?.width ?? null,
    height: embedded?.height ?? null,
    embedded,
  };
}

/** Merge extracted metadata into the row's metadata, keeping editorial keys (alt, caption, tags…). */
export function mergeEmbeddedMetadata(
  current: unknown,
  embedded: ExtractedMetadata | null,
): Record<string, unknown> {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  delete base[EMBEDDED_KEY];
  delete base[SEARCH_KEY];
  if (!embedded) return base;
  return { ...base, [EMBEDDED_KEY]: embedded, [SEARCH_KEY]: metadataSearchText(embedded) };
}

export function archiveKey(siteId: string, fileId: string, version: number): string {
  return `sites/${siteId}/file-versions/${fileId}/v${version}`;
}

async function readAll(body: ReadableStream | Buffer | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

export interface ReplaceInput {
  id: string;
  bytes: Uint8Array;
  mime: string;
  /** New download name; keeps the current one when omitted. */
  filename?: string;
  userId?: string | null;
  /** Reject with 409 unless the row is still at this version (If-Match). */
  expectedVersion?: number;
}

export interface ReplaceResult {
  file: FileRecord;
  previous: FileVersionRecord | null;
}

export interface DeleteResult {
  file: FileRecord;
  usage: FileUsageReport;
  removedVersions: number;
}

export interface FileAssetServiceDeps {
  repo: FileRepository;
  storage: StorageProvider;
  settings: DamSettings;
  usage?: FileUsageSource;
  now?: () => Date;
}

export class FileAssetService {
  constructor(private readonly deps: FileAssetServiceDeps) {}

  private get siteId(): string {
    return this.deps.repo.siteId;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async mustGet(id: string): Promise<FileRecord> {
    const file = await this.deps.repo.get(id);
    if (!file) throw new FileAssetError('NOT_FOUND', 'File not found.', 404);
    return file;
  }

  /** State a newly written binary starts in: `pending` when scanning is on. */
  initialScanStatus(): string {
    return this.deps.settings.scan.enabled ? 'pending' : 'skipped';
  }

  /**
   * Read a just-registered object back and fill hash, dimensions and embedded
   * metadata. Best-effort: a missing or oversized object leaves the row as the
   * client described it. Returns the updated row and same-hash duplicates.
   */
  async ingestRegistered(file: FileRecord): Promise<{ file: FileRecord; duplicates: FileRecord[] }> {
    if (file.filesize > INGEST_READ_LIMIT) return { file, duplicates: [] };
    let obj: Awaited<ReturnType<StorageProvider['get']>>;
    try {
      obj = await this.deps.storage.get(file.filenameDisk);
    } catch {
      return { file, duplicates: [] };
    }
    if (!obj) return { file, duplicates: [] };
    const bytes = await readAll(obj.body);
    if (bytes.byteLength > INGEST_READ_LIMIT) return { file, duplicates: [] };
    const ingest = await ingestBytes(bytes, { extractMetadata: this.deps.settings.extractMetadata });
    const patch: FileContentPatch = {
      contentHash: ingest.contentHash,
      filesize: ingest.filesize,
      metadata: mergeEmbeddedMetadata(file.metadata, ingest.embedded),
    };
    if (file.width == null && ingest.width != null) patch.width = ingest.width;
    if (file.height == null && ingest.height != null) patch.height = ingest.height;
    const updated = (await this.deps.repo.update(file.id, patch)) ?? file;
    const duplicates = await this.deps.repo.findByHash(ingest.contentHash, file.id);
    return { file: updated, duplicates };
  }

  async duplicatesOf(contentHash: string, excludeId?: string): Promise<FileRecord[]> {
    if (!/^[0-9a-f]{64}$/.test(contentHash)) {
      throw new FileAssetError('VALIDATION', 'hash must be a lowercase hex SHA-256 digest.', 400);
    }
    return this.deps.repo.findByHash(contentHash, excludeId);
  }

  async replaceContent(input: ReplaceInput): Promise<ReplaceResult> {
    const { repo, storage, settings } = this.deps;
    const current = await this.mustGet(input.id);
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new FileAssetError('VERSION_CONFLICT', 'The file was replaced since you loaded it.', 409, {
        currentVersion: current.version,
      });
    }
    if (input.bytes.byteLength === 0) {
      throw new FileAssetError('VALIDATION', 'Replacement body is empty.', 400);
    }

    const ingest = await ingestBytes(input.bytes, { extractMetadata: settings.extractMetadata });

    // 1. Archive the live bytes (when there is history to keep and bytes exist).
    let archived: string | null = null;
    if (settings.versionRetentionDays > 0) {
      const live = await storage.get(current.filenameDisk).catch(() => null);
      if (live) {
        archived = archiveKey(this.siteId, current.id, current.version);
        await storage.put(archived, Buffer.from(await readAll(live.body)), {
          contentType: current.mime,
          ...(current.contentHash ? { contentHash: current.contentHash } : {}),
        });
      }
    }

    // 2. Move the row to the next version — the concurrency guard.
    const nextVersion = current.version + 1;
    const updated = await repo.update(
      current.id,
      {
        version: nextVersion,
        mime: input.mime,
        filesize: ingest.filesize,
        width: ingest.width,
        height: ingest.height,
        contentHash: ingest.contentHash,
        filenameDownload: input.filename ?? current.filenameDownload,
        metadata: mergeEmbeddedMetadata(current.metadata, ingest.embedded),
        scanStatus: this.initialScanStatus(),
      },
      current.version,
    );
    if (!updated) {
      throw new FileAssetError('VERSION_CONFLICT', 'The file was replaced concurrently; reload and retry.', 409);
    }

    // 3. Record the previous state for undo.
    let previous: FileVersionRecord | null = null;
    if (archived) {
      const expiresAt = new Date(this.now().getTime() + settings.versionRetentionDays * 86_400_000);
      previous = await repo.insertVersion({
        fileId: current.id,
        version: current.version,
        filenameDisk: archived,
        filenameDownload: current.filenameDownload,
        mime: current.mime,
        filesize: current.filesize,
        width: current.width,
        height: current.height,
        contentHash: current.contentHash,
        metadata: (current.metadata ?? {}) as Record<string, unknown>,
        replacedBy: input.userId ?? null,
        expiresAt,
      });
    }

    // 4. Write the new bytes over the live key; roll the row back on failure.
    try {
      await storage.put(current.filenameDisk, Buffer.from(input.bytes), {
        contentType: input.mime,
        contentHash: ingest.contentHash.slice(0, 32),
      });
    } catch (err) {
      await repo
        .update(
          current.id,
          {
            version: current.version,
            mime: current.mime,
            filesize: current.filesize,
            width: current.width,
            height: current.height,
            contentHash: current.contentHash,
            filenameDownload: current.filenameDownload,
            metadata: current.metadata as Record<string, unknown>,
            scanStatus: current.scanStatus,
          },
          nextVersion,
        )
        .catch(() => null);
      if (previous) await repo.deleteVersion(previous.id).catch(() => undefined);
      throw new FileAssetError('STORAGE_ERROR', `Failed to write the replacement: ${err instanceof Error ? err.message : String(err)}`, 503);
    }

    // Opportunistic retention sweep for this site; never fails the replace.
    await this.pruneExpiredVersions(25).catch(() => 0);
    return { file: updated, previous };
  }

  async listVersions(id: string): Promise<FileVersionRecord[]> {
    await this.mustGet(id);
    return this.deps.repo.listVersions(id);
  }

  /** Undo: restoring a version is itself a replace, so the current bytes are archived too. */
  async restoreVersion(id: string, versionId: string, userId?: string | null): Promise<ReplaceResult> {
    await this.mustGet(id);
    const version = await this.deps.repo.getVersion(id, versionId);
    if (!version) throw new FileAssetError('NOT_FOUND', 'File version not found.', 404);
    if (version.expiresAt.getTime() <= this.now().getTime()) {
      throw new FileAssetError('VERSION_EXPIRED', 'This version is past its retention window.', 409);
    }
    const obj = await this.deps.storage.get(version.filenameDisk);
    if (!obj) throw new FileAssetError('VERSION_MISSING', 'The archived binary for this version is gone.', 409);
    return this.replaceContent({
      id,
      bytes: await readAll(obj.body),
      mime: version.mime,
      filename: version.filenameDownload,
      userId,
    });
  }

  /** Delete archived binaries past retention (this site only). Returns how many were removed. */
  async pruneExpiredVersions(limit = 100): Promise<number> {
    const expired = await this.deps.repo.expiredVersions(this.now(), limit);
    let removed = 0;
    for (const v of expired) {
      try {
        await this.deps.storage.delete(v.filenameDisk);
        await this.deps.repo.deleteVersion(v.id);
        removed++;
      } catch {
        // Keep the row so the next sweep retries; never strand a row without bytes.
      }
    }
    return removed;
  }

  async usage(id: string): Promise<FileUsageReport> {
    const file = await this.mustGet(id);
    return this.usageOf(file);
  }

  private async usageOf(file: FileRecord): Promise<FileUsageReport> {
    if (!this.deps.usage) return { total: 0, truncated: false, references: [] };
    return fileUsage(this.deps.usage, file);
  }

  /**
   * Safe delete (#706). A referenced file is refused with the reference list:
   * under `confirm` the caller may repeat with `confirm: true`; under `block`
   * it may not delete at all. Removes the row, the live object and every
   * archived version.
   */
  async delete(id: string, opts: { confirm: boolean }): Promise<DeleteResult> {
    const file = await this.mustGet(id);
    const usage = await this.usageOf(file);
    if (usage.total > 0) {
      if (this.deps.settings.deletePolicy === 'block') {
        throw new FileAssetError('FILE_IN_USE', 'File is referenced by content and the site blocks deleting referenced files.', 409, {
          policy: 'block',
          usage,
        });
      }
      if (!opts.confirm) {
        throw new FileAssetError('FILE_IN_USE', 'File is referenced by content. Repeat with ?confirm=true to delete anyway.', 409, {
          policy: 'confirm',
          usage,
        });
      }
    }
    const versions = await this.deps.repo.listVersions(id);
    const removed = await this.deps.repo.remove(id);
    if (!removed) throw new FileAssetError('NOT_FOUND', 'File not found.', 404);
    // Object cleanup after the row is gone; a failure leaves an orphan object,
    // never a row pointing at missing bytes.
    for (const key of [file.filenameDisk, ...versions.map((v) => v.filenameDisk)]) {
      await this.deps.storage.delete(key).catch(() => undefined);
    }
    return { file: removed, usage, removedVersions: versions.length };
  }
}
