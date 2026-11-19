import { describe, expect, it } from 'vitest';
import { resumeKey, tusUpload, type TusTransport } from '../tus-client';
import { PermanentUploadError } from '../upload-queue';

/** In-memory TUS server behind a `rawFetch`-shaped transport. */
function fakeServer() {
  const uploads = new Map<string, { length: number; bytes: number[]; meta: string; fileId?: string }>();
  let seq = 0;
  const calls: string[] = [];
  let dropNextPatch = 0;
  const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  const transport: TusTransport = async (path, init) => {
    const method = init.method ?? 'GET';
    const h = new Headers(init.headers);
    calls.push(`${method} ${path}`);
    if (method === 'POST' && path === '/api/v1/files/tus') {
      const id = `u${++seq}`;
      uploads.set(id, { length: Number(h.get('Upload-Length')), bytes: [], meta: h.get('Upload-Metadata') ?? '' });
      return new Response(null, { status: 201, headers: { Location: `https://cms.example/api/v1/files/tus/${id}` } });
    }
    const id = path.split('/').pop()!;
    const u = uploads.get(id);
    if (!u) throw err(404);
    if (method === 'HEAD') {
      const headers: Record<string, string> = { 'Upload-Offset': String(u.bytes.length), 'Upload-Length': String(u.length) };
      if (u.fileId) headers['X-Lumi-File-Id'] = u.fileId;
      return new Response(null, { status: 200, headers });
    }
    if (method === 'PATCH') {
      if (Number(h.get('Upload-Offset')) !== u.bytes.length) throw err(409);
      const chunk = new Uint8Array(await (init.body as Blob).arrayBuffer());
      if (dropNextPatch > 0) {
        dropNextPatch--;
        // Half the chunk reached the server before the connection dropped,
        // but TUS commits all-or-nothing: nothing is stored.
        throw new TypeError('Failed to fetch');
      }
      u.bytes.push(...chunk);
      const headers: Record<string, string> = { 'Upload-Offset': String(u.bytes.length) };
      if (u.bytes.length === u.length) {
        u.fileId = `file_${id}`;
        headers['X-Lumi-File-Id'] = u.fileId;
      }
      return new Response(null, { status: 204, headers });
    }
    throw err(405);
  };
  return { transport, uploads, calls, drop: (n: number) => (dropNextPatch = n) };
}

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

const blob = (n: number) => Object.assign(new Blob([Uint8Array.from({ length: n }, (_, i) => i % 256)], { type: 'video/mp4' }), { name: 'clip.mp4', lastModified: 1 });
const noSleep = async () => undefined;

describe('tusUpload (#704)', () => {
  it('uploads in chunks with progress and returns the file id', async () => {
    const s = fakeServer();
    const progress: number[] = [];
    const res = await tusUpload({ file: blob(10), transport: s.transport, scope: 'site_a', chunkSize: 4, store: memoryStore(), onProgress: (p) => progress.push(p), sleep: noSleep });
    expect(res).toEqual({ fileId: 'file_u1', resumed: false });
    expect(progress).toEqual([0.4, 0.8, 1]);
    expect(s.uploads.get('u1')!.bytes).toEqual([...Array(10).keys()]);
    expect(s.calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(3);
  });

  it('survives a dropped connection: HEADs, resumes from the committed offset, re-sends only that chunk', async () => {
    const s = fakeServer();
    s.drop(1);
    const res = await tusUpload({ file: blob(10), transport: s.transport, scope: 'site_a', chunkSize: 4, store: memoryStore(), sleep: noSleep });
    expect(res.fileId).toBe('file_u1');
    expect(s.uploads.get('u1')!.bytes).toEqual([...Array(10).keys()]);
    expect(s.calls).toEqual([
      'POST /api/v1/files/tus',
      'PATCH /api/v1/files/tus/u1', // dropped
      'HEAD /api/v1/files/tus/u1',
      'PATCH /api/v1/files/tus/u1',
      'PATCH /api/v1/files/tus/u1',
      'PATCH /api/v1/files/tus/u1',
    ]);
  });

  it('resumes across a reload (new call, same stored URL) without re-sending stored bytes', async () => {
    const s = fakeServer();
    const store = memoryStore();
    s.drop(10); // every PATCH after the first fails until retries run out
    await expect(
      tusUpload({ file: blob(12), transport: s.transport, scope: 'site_a', chunkSize: 4, store, retryDelays: [0], sleep: noSleep }),
    ).rejects.toThrow(/Failed to fetch/);
    expect(store.m.size).toBe(1);
    s.drop(0);
    s.uploads.get('u1')!.bytes.push(0, 1, 2, 3); // pretend 4 bytes had been committed before the "reload"
    s.calls.length = 0;
    const res = await tusUpload({ file: blob(12), transport: s.transport, scope: 'site_a', chunkSize: 4, store, sleep: noSleep });
    expect(res).toEqual({ fileId: 'file_u1', resumed: true });
    expect(s.calls[0]).toBe('HEAD /api/v1/files/tus/u1');
    expect(s.calls.filter((c) => c.startsWith('PATCH'))).toHaveLength(2);
    expect(store.m.size).toBe(0);
  });

  it('starts over when the stored upload is gone (expired/terminated), and scopes resume keys per site', async () => {
    const s = fakeServer();
    const store = memoryStore();
    store.setItem(resumeKey('site_a', blob(4)), '/api/v1/files/tus/missing');
    const res = await tusUpload({ file: blob(4), transport: s.transport, scope: 'site_a', store, sleep: noSleep });
    expect(res.resumed).toBe(false);
    expect(resumeKey('site_a', blob(4))).not.toBe(resumeKey('site_b', blob(4)));
  });

  it('treats a 4xx refusal at creation as permanent (no retries)', async () => {
    const transport: TusTransport = async () => {
      throw Object.assign(new Error('UPLOAD_TOO_LARGE'), { status: 413 });
    };
    await expect(tusUpload({ file: blob(4), transport, scope: 's', store: null, sleep: noSleep })).rejects.toBeInstanceOf(PermanentUploadError);
  });
});
