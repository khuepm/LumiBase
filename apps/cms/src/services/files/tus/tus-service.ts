/**
 * Resumable uploads over TUS 1.0 (#704), runtime-neutral.
 *
 * Bytes go straight into a storage multipart upload (R2 on Workers, S3/MinIO
 * on Docker) through the `MultipartStorage` port, so neither runtime buffers
 * a whole file. Each PATCH is all-or-nothing: `offset` only advances after
 * every part it produced is stored, so a dropped connection simply resumes
 * from the last committed offset (HEAD), re-sending at most one chunk.
 *
 * Parts have one fixed size (`PART_SIZE`); the remainder of a PATCH that does
 * not fill a part is kept in a tail object and prepended to the next PATCH.
 * A single-writer lease (conditional UPDATE) stops two PATCHes for the same
 * upload from interleaving part numbers.
 */
import { nanoid } from 'nanoid';
import { supportsMultipart, type MultipartPart, type MultipartStorage, type StorageProvider } from '@lumibase/runtime';
import { FileAssetError } from '../file-asset-service';
import { MAX_PATCH_BYTES, PART_SIZE, SESSION_TTL_MS } from './protocol';
import type { UploadSession, UploadSessionRepository } from './session-repo';

/** A PATCH holds its lease at most this long (a crashed writer frees it). */
const LEASE_MS = 5 * 60_000;

export interface TusServiceDeps {
  repo: UploadSessionRepository;
  storage: StorageProvider;
  now?: () => Date;
  partSize?: number;
}

export interface CreateUploadInput {
  length: number;
  filename: string;
  mime: string;
  folder: string | null;
  userId: string | null;
  metadata?: Record<string, string>;
}

export interface PatchResult {
  session: UploadSession;
  /** True when this PATCH stored the last byte (the object is now assembled). */
  completed: boolean;
}

/** Storage-safe file name segment for the object key. */
export function safeKeySegment(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'upload';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'upload';
}

export function tailKey(storageKey: string): string {
  return `${storageKey}.tus-tail`;
}

async function readAll(body: ReadableStream | Buffer | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

export class TusService {
  constructor(private readonly deps: TusServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private get partSize(): number {
    return this.deps.partSize ?? PART_SIZE;
  }

  private multipart(): StorageProvider & MultipartStorage {
    const { storage } = this.deps;
    if (!supportsMultipart(storage)) {
      throw new FileAssetError('RESUMABLE_UNSUPPORTED', 'This storage backend does not support resumable uploads.', 503);
    }
    return storage;
  }

  async create(input: CreateUploadInput): Promise<UploadSession> {
    if (input.length <= 0) throw new FileAssetError('VALIDATION', 'Upload-Length must be greater than 0.', 400);
    const storage = this.multipart();
    const id = nanoid();
    const storageKey = `sites/${this.deps.repo.siteId}/uploads/${id}/${safeKeySegment(input.filename)}`;
    const { uploadId } = await storage.createMultipart(storageKey, { contentType: input.mime });
    try {
      return await this.deps.repo.create({
        id,
        createdBy: input.userId,
        filename: input.filename,
        mime: input.mime,
        length: input.length,
        storageKey,
        multipartId: uploadId,
        folder: input.folder,
        metadata: input.metadata ?? {},
        expiresAt: new Date(this.now().getTime() + SESSION_TTL_MS),
      });
    } catch (err) {
      await storage.abortMultipart(storageKey, uploadId).catch(() => undefined);
      throw err;
    }
  }

  /** The session as the client may see it: 404 for unknown/aborted, 410 for expired. */
  async active(id: string): Promise<UploadSession> {
    const session = await this.deps.repo.get(id);
    if (!session || session.status === 'aborted') throw new FileAssetError('NOT_FOUND', 'Upload not found.', 404);
    if (session.status === 'active' && session.expiresAt.getTime() <= this.now().getTime()) {
      throw new FileAssetError('UPLOAD_EXPIRED', 'This upload expired; start a new one.', 410);
    }
    return session;
  }

  async patch(id: string, offset: number, body: Uint8Array): Promise<PatchResult> {
    const session = await this.active(id);
    if (session.status === 'completed') throw new FileAssetError('UPLOAD_COMPLETE', 'This upload is already complete.', 409);
    if (offset !== session.offset) {
      throw new FileAssetError('OFFSET_MISMATCH', `Upload-Offset ${offset} does not match the stored offset ${session.offset}.`, 409, {
        offset: session.offset,
      });
    }
    if (body.byteLength === 0) return { session, completed: false };
    if (body.byteLength > MAX_PATCH_BYTES) {
      throw new FileAssetError('CHUNK_TOO_LARGE', `A PATCH may carry at most ${MAX_PATCH_BYTES} bytes.`, 413);
    }
    if (offset + body.byteLength > session.length) {
      throw new FileAssetError('UPLOAD_TOO_LARGE', 'The body would exceed the declared Upload-Length.', 413);
    }

    const storage = this.multipart();
    const now = this.now();
    const token = nanoid();
    const leased = await this.deps.repo.claim(id, offset, token, new Date(now.getTime() + LEASE_MS), now);
    if (!leased) {
      throw new FileAssetError('UPLOAD_LOCKED', 'Another request is writing to this upload; retry after HEAD.', 409);
    }

    try {
      const tail = session.tailSize > 0 ? await this.readTail(session) : new Uint8Array(0);
      let data = concat(tail, body);
      const newOffset = offset + body.byteLength;
      const final = newOffset === session.length;
      const parts: MultipartPart[] = [...((session.parts as MultipartPart[]) ?? [])];
      const key = session.storageKey;
      const uploadId = session.multipartId!;

      while (data.byteLength >= this.partSize) {
        const chunk = data.subarray(0, this.partSize);
        parts.push(await storage.uploadPart(key, uploadId, parts.length + 1, chunk));
        data = data.subarray(this.partSize);
      }
      if (final) {
        // The last part may be any size (and is the only part of a small file).
        if (data.byteLength > 0 || parts.length === 0) parts.push(await storage.uploadPart(key, uploadId, parts.length + 1, data));
        await storage.completeMultipart(key, uploadId, parts);
        if (session.tailSize > 0) await storage.delete(tailKey(key)).catch(() => undefined);
      } else if (data.byteLength > 0) {
        await storage.put(tailKey(key), Buffer.from(data), { contentType: 'application/octet-stream' });
      } else if (session.tailSize > 0) {
        await storage.delete(tailKey(key)).catch(() => undefined);
      }

      const committed = await this.deps.repo.commit(id, token, {
        offset: newOffset,
        parts,
        tailSize: final ? 0 : data.byteLength,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      });
      if (!committed) throw new FileAssetError('UPLOAD_LOCKED', 'The upload lease was lost; retry after HEAD.', 409);
      return { session: committed, completed: final };
    } catch (err) {
      await this.deps.repo.release(id, token).catch(() => undefined);
      if (err instanceof FileAssetError) throw err;
      throw new FileAssetError('STORAGE_ERROR', `Failed to store the chunk: ${err instanceof Error ? err.message : String(err)}`, 503);
    }
  }

  private async readTail(session: UploadSession): Promise<Uint8Array> {
    const obj = await this.deps.storage.get(tailKey(session.storageKey));
    if (!obj) throw new FileAssetError('UPLOAD_CORRUPT', 'The buffered tail of this upload is missing; start a new one.', 409);
    const bytes = await readAll(obj.body);
    if (bytes.byteLength !== session.tailSize) {
      throw new FileAssetError('UPLOAD_CORRUPT', 'The buffered tail of this upload is inconsistent; start a new one.', 409);
    }
    return bytes;
  }

  /** Mark completed and link the created file. */
  async markCompleted(id: string, fileId: string): Promise<UploadSession | null> {
    return this.deps.repo.finish(id, { status: 'completed', fileId });
  }

  /**
   * DELETE (termination) or a refused completion: drop the multipart upload,
   * the tail and — for a completed-but-refused upload — the assembled object.
   */
  async terminate(id: string, opts: { deleteObject?: boolean } = {}): Promise<void> {
    const session = await this.deps.repo.get(id);
    if (!session || session.status === 'aborted') throw new FileAssetError('NOT_FOUND', 'Upload not found.', 404);
    if (session.status === 'completed' && !opts.deleteObject) {
      throw new FileAssetError('UPLOAD_COMPLETE', 'This upload is already complete; delete the file instead.', 409);
    }
    await cleanupSessionStorage(this.deps.storage, session, opts.deleteObject === true);
    await this.deps.repo.finish(id, { status: 'aborted' });
  }
}

/** Best-effort storage cleanup for an abandoned or refused session. */
export async function cleanupSessionStorage(storage: StorageProvider, session: UploadSession, deleteObject: boolean): Promise<void> {
  if (session.status === 'active' && session.multipartId && supportsMultipart(storage)) {
    await storage.abortMultipart(session.storageKey, session.multipartId).catch(() => undefined);
  }
  await storage.delete(tailKey(session.storageKey)).catch(() => undefined);
  if (deleteObject) await storage.delete(session.storageKey).catch(() => undefined);
}
