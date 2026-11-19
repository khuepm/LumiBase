import { describe, expect, it } from 'vitest';
import type { PolicyRule } from '@lumibase/contracts';
import {
  AI_ATTACHMENT_LIMITS,
  AttachmentError,
  attachmentKindOf,
  createAttachmentReader,
  readTurnAttachments,
  type AttachmentReader,
} from '../ai-attachments';
import type { FilesAccess } from '../files/file-access';
import { MemoryFileRepository, MemoryStorage } from '../files/__tests__/memory-repo';

/**
 * Files as model input (#709): a file reaches the model only through the
 * caller's own `files::read` access, only as an image or a PDF, and only
 * within the size limits.
 */

const ctx = { userId: 'u1', siteId: 's1', roleId: 'editor', ip: null, headers: {} };
const ADMIN: FilesAccess = { admin: true, rule: null, ctx };
const MARKETING_ONLY: FilesAccess = {
  admin: false,
  rule: { folder_path: { _starts_with: '/mkt/' } } as unknown as PolicyRule,
  ctx,
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

async function fixture() {
  const repo = new MemoryFileRepository('s1');
  repo.folders = [
    { id: 'mkt', name: 'Marketing', parent: null },
    { id: 'legal', name: 'Legal', parent: null },
  ];
  const storage = new MemoryStorage();
  const add = async (id: string, mime: string, bytes: Uint8Array, extra: Record<string, unknown> = {}) => {
    repo.seed({ id, filenameDisk: `k/${id}`, filenameDownload: `${id}.bin`, mime, filesize: bytes.byteLength, ...extra });
    await storage.put(`k/${id}`, Buffer.from(bytes));
  };
  await add('img', 'image/png', PNG, { folder: 'mkt' });
  await add('pdf', 'application/pdf; charset=binary', new Uint8Array([0x25, 0x50, 0x44, 0x46]), { folder: 'mkt' });
  await add('secret', 'image/png', PNG, { folder: 'legal' });
  await add('txt', 'text/plain', new Uint8Array([0x61]), { folder: 'mkt' });
  await add('infected', 'image/png', PNG, { folder: 'mkt', scanStatus: 'infected' });
  await add('pending', 'image/png', PNG, { folder: 'mkt', scanStatus: 'pending' });
  repo.seed({ id: 'gone', filenameDisk: 'k/gone', mime: 'image/png', filesize: 4, folder: 'mkt' });
  return { repo, storage };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AttachmentError);
  return `${(err as AttachmentError).code} ${(err as AttachmentError).status}`;
}

describe('createAttachmentReader', () => {
  it('reads an image and a PDF as base64 with a normalised media type', async () => {
    const { repo, storage } = await fixture();
    const reader = createAttachmentReader({ repo, storage, access: ADMIN });
    await expect(reader.read('img')).resolves.toEqual({
      fileId: 'img', kind: 'image', mimeType: 'image/png', name: 'img.bin', size: 4, data: Buffer.from(PNG).toString('base64'),
    });
    await expect(reader.read('pdf')).resolves.toMatchObject({ kind: 'pdf', mimeType: 'application/pdf', data: 'JVBERg==' });
  });

  it('applies the caller\'s folder-scoped files::read rule; outside it a file does not exist', async () => {
    const { repo, storage } = await fixture();
    const reader = createAttachmentReader({ repo, storage, access: MARKETING_ONLY });
    await expect(reader.read('img')).resolves.toMatchObject({ fileId: 'img' });
    expect(await code(reader.read('secret'))).toBe('NOT_FOUND 404');
    expect(await code(reader.read('nope'))).toBe('NOT_FOUND 404');
    expect(await code(createAttachmentReader({ repo, storage, access: null }).read('img'))).toBe('FORBIDDEN 403');
  });

  it('refuses other media types, unscanned or infected files and missing bytes', async () => {
    const { repo, storage } = await fixture();
    const reader = createAttachmentReader({ repo, storage, access: ADMIN });
    expect(await code(reader.read('txt'))).toBe('UNSUPPORTED_MEDIA_TYPE 415');
    expect(await code(reader.read('infected'))).toBe('FILE_NOT_AVAILABLE 409');
    expect(await code(reader.read('pending'))).toBe('FILE_NOT_AVAILABLE 409');
    expect(await code(reader.read('gone'))).toBe('FILE_NOT_AVAILABLE 409');
  });

  it('enforces the size limit on the row and again on the bytes actually read', async () => {
    const { repo, storage } = await fixture();
    repo.seed({ id: 'big', filenameDisk: 'k/big', mime: 'image/jpeg', filesize: AI_ATTACHMENT_LIMITS.maxImageBytes + 1 });
    // The row understates its size; the stream is cut at the limit.
    repo.seed({ id: 'liar', filenameDisk: 'k/liar', mime: 'image/jpeg', filesize: 10 });
    const streaming = {
      get: async (key: string) => key === 'k/liar'
        ? {
            key,
            body: new ReadableStream<Uint8Array>({
              pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
            }),
          }
        : storage.get(key),
    };
    const reader = createAttachmentReader({ repo, storage: streaming, access: ADMIN });
    expect(await code(reader.read('big'))).toBe('ATTACHMENT_TOO_LARGE 413');
    expect(await code(reader.read('liar'))).toBe('ATTACHMENT_TOO_LARGE 413');
  });
});

describe('readTurnAttachments', () => {
  const fake = (size: number): AttachmentReader => ({
    read: async (fileId) => ({ fileId, kind: 'pdf', mimeType: 'application/pdf', name: fileId, size, data: '' }),
  });

  it('de-duplicates, caps the count and the total size', async () => {
    await expect(readTurnAttachments(fake(1), ['a', 'a', 'b'])).resolves.toHaveLength(2);
    expect(await code(readTurnAttachments(fake(1), ['a', 'b', 'c', 'd', 'e']))).toBe('ATTACHMENT_TOO_LARGE 413');
    const nine = 9 * 1024 * 1024;
    expect(await code(readTurnAttachments(fake(nine), ['a', 'b', 'c']))).toBe('ATTACHMENT_TOO_LARGE 413');
  });

  it('classifies media types', () => {
    expect(attachmentKindOf('IMAGE/WEBP')).toBe('image');
    expect(attachmentKindOf('application/pdf')).toBe('pdf');
    expect(attachmentKindOf('image/svg+xml')).toBeNull();
    expect(attachmentKindOf('image/heic')).toBeNull();
  });
});
