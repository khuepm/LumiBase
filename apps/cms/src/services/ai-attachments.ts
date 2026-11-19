import type { Context } from 'hono';
import type { StorageProvider } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { canActOnFile, type FilesAccess } from './files/file-access';
import type { FileRepository } from './files/file-repository';
import type { FolderRow } from './files/folder-tree';
import { DrizzleFileRepository } from './files/file-repository';
import { resolveFilesAccess } from './files/files-context';
import { isServable } from '../modules/malware-scan';
import type { LLMAttachment } from './llm-provider';

/**
 * Files as model input (#709): images and PDFs from the site's media library,
 * attached to a Copilot turn or read by the `describeImage` /
 * `extractFieldsFromPdf` skills.
 *
 * A file is read with the CALLER's `files::read` access — the same rule
 * (site admin, or a folder-scoped grant evaluated per file) that guards
 * `GET /files/:id/content` — so attaching a file can never show the model
 * something the caller could not download. A file outside that scope answers
 * exactly like a file that does not exist. Quarantined or still-scanning
 * files (#707) are refused.
 *
 * Bytes are sent to the configured model provider and are never stored with
 * the conversation: the stored user message keeps `{ fileId, name, mimeType }`
 * only, and older turns are not re-sent with their files.
 */

export const AI_ATTACHMENT_LIMITS = {
  /** Files per Copilot turn. */
  maxPerTurn: 4,
  /** Per image. Providers resize larger images anyway. */
  maxImageBytes: 5 * 1024 * 1024,
  /** Per PDF. */
  maxPdfBytes: 10 * 1024 * 1024,
  /** All files of one turn together. */
  maxTotalBytes: 20 * 1024 * 1024,
} as const;

export const AI_ATTACHMENT_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
export const AI_ATTACHMENT_PDF_TYPE = 'application/pdf';

export type AttachmentErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'ATTACHMENT_TOO_LARGE'
  | 'FILE_NOT_AVAILABLE';

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
    readonly status: 403 | 404 | 409 | 413 | 415,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

/** Reads one media-library file as a model attachment, or throws {@link AttachmentError}. */
export interface AttachmentReader {
  read(fileId: string): Promise<LLMAttachment>;
}

export function attachmentKindOf(mime: string): LLMAttachment['kind'] | null {
  const type = mime.toLowerCase().split(';')[0]!.trim();
  if (AI_ATTACHMENT_IMAGE_TYPES.has(type)) return 'image';
  if (type === AI_ATTACHMENT_PDF_TYPE) return 'pdf';
  return null;
}

function maxBytesOf(kind: LLMAttachment['kind']): number {
  return kind === 'image' ? AI_ATTACHMENT_LIMITS.maxImageBytes : AI_ATTACHMENT_LIMITS.maxPdfBytes;
}

function tooLarge(name: string, limit: number): AttachmentError {
  return new AttachmentError(
    'ATTACHMENT_TOO_LARGE',
    `"${name}" is larger than ${Math.round(limit / (1024 * 1024))} MB, the limit for a model attachment.`,
    413,
  );
}

async function readLimited(body: ReadableStream | Buffer | Uint8Array, limit: number, name: string): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > limit) throw tooLarge(name, limit);
    return body;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(name, limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export interface AttachmentReaderDeps {
  repo: Pick<FileRepository, 'get' | 'listFolders'>;
  storage: Pick<StorageProvider, 'get'>;
  /** The caller's `files::read` access; null = no access to the media library. */
  access: FilesAccess | null;
}

export function createAttachmentReader(deps: AttachmentReaderDeps): AttachmentReader {
  let folders: Promise<FolderRow[]> | null = null;
  const loadFolders = () => (folders ??= deps.access?.admin ? Promise.resolve([]) : deps.repo.listFolders());

  return {
    async read(fileId) {
      if (!deps.access) {
        throw new AttachmentError('FORBIDDEN', 'You do not have access to the media library.', 403);
      }
      const file = await deps.repo.get(fileId);
      if (!file || !canActOnFile(deps.access, file, await loadFolders())) {
        throw new AttachmentError('NOT_FOUND', `File ${fileId} not found.`, 404);
      }
      const name = file.filenameDownload;
      const kind = attachmentKindOf(file.mime);
      if (!kind) {
        throw new AttachmentError(
          'UNSUPPORTED_MEDIA_TYPE',
          `"${name}" (${file.mime}) cannot be sent to the model. Attach a PNG, JPEG, GIF or WebP image, or a PDF.`,
          415,
        );
      }
      if (!isServable(file.scanStatus)) {
        throw new AttachmentError('FILE_NOT_AVAILABLE', `"${name}" is not available (malware scan: ${file.scanStatus}).`, 409);
      }
      const limit = maxBytesOf(kind);
      if (file.filesize > limit) throw tooLarge(name, limit);
      const object = await deps.storage.get(file.filenameDisk);
      if (!object) throw new AttachmentError('FILE_NOT_AVAILABLE', `The bytes of "${name}" are missing from storage.`, 409);
      const bytes = await readLimited(object.body, limit, name);
      return {
        fileId: file.id,
        kind,
        mimeType: file.mime.toLowerCase().split(';')[0]!.trim(),
        name,
        size: bytes.byteLength,
        data: toBase64(bytes),
      };
    },
  };
}

/** Reads every file of one turn: count, per-file and total limits enforced. */
export async function readTurnAttachments(reader: AttachmentReader, fileIds: readonly string[]): Promise<LLMAttachment[]> {
  const unique = [...new Set(fileIds)];
  if (unique.length > AI_ATTACHMENT_LIMITS.maxPerTurn) {
    throw new AttachmentError('ATTACHMENT_TOO_LARGE', `At most ${AI_ATTACHMENT_LIMITS.maxPerTurn} files can be attached to one message.`, 413);
  }
  const attachments: LLMAttachment[] = [];
  let total = 0;
  for (const id of unique) {
    const attachment = await reader.read(id);
    total += attachment.size;
    if (total > AI_ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new AttachmentError(
        'ATTACHMENT_TOO_LARGE',
        `The attached files together exceed ${AI_ATTACHMENT_LIMITS.maxTotalBytes / (1024 * 1024)} MB.`,
        413,
      );
    }
    attachments.push(attachment);
  }
  return attachments;
}

/** The reader for the current request: the caller's own `files::read` access. */
export async function attachmentReaderForRequest(c: Context<AppEnv>): Promise<AttachmentReader> {
  return createAttachmentReader({
    repo: new DrizzleFileRepository(c.get('db'), c.get('siteId')),
    storage: c.get('runtime').storage,
    access: await resolveFilesAccess(c, 'read'),
  });
}

/**
 * Same as {@link attachmentReaderForRequest}, resolved on first use: a harness
 * is built for every Copilot / MCP request, and most never read a file.
 */
export function lazyAttachmentReader(c: Context<AppEnv>): AttachmentReader {
  let reader: Promise<AttachmentReader> | null = null;
  return {
    read: async (fileId) => (await (reader ??= attachmentReaderForRequest(c))).read(fileId),
  };
}
