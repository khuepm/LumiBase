import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';

/**
 * Import routes without a database (#859): the upload size limit is enforced
 * while the body streams in, and read paths never select the stored `source`.
 */

vi.mock('../../services/item-service-factory', () => ({
  permissionServiceForRequest: () => ({ bundle: async () => ({ admin: true }), canAccess: async () => true }),
}));

import { importsRouter, readUpload } from '../imports';

const enc = new TextEncoder();

/** A body with no Content-Length, delivered in `chunks` pieces of `size` bytes; counts pulls. */
function chunkedBody(chunks: number, size: number) {
  const state = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled++;
      controller.enqueue(enc.encode('x'.repeat(size)));
    },
  });
  return { stream, state };
}

const request = (body: BodyInit | null, headers: Record<string, string>) =>
  new Request('http://x/api/v1/imports', {
    method: 'POST',
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);

describe('readUpload', () => {
  it('413s a chunked raw body over the limit and stops reading it', async () => {
    const { stream, state } = chunkedBody(1000, 1024);
    const out = await readUpload(request(stream, { 'content-type': 'text/csv' }), 4 * 1024);
    expect(out).toEqual({ error: 'Import file exceeds the 4096 byte limit.', status: 413 });
    // Cut off right after the limit, not after reading the ~1 MiB body.
    expect(state.pulled).toBeLessThan(10);
  });

  it('413s a chunked multipart body over the limit (with multipart overhead) and stops reading it', async () => {
    const boundary = 'b0undary';
    const head = `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="a.csv"\r\ncontent-type: text/csv\r\n\r\n`;
    const { stream: payload, state } = chunkedBody(1000, 1024);
    const reader = payload.getReader();
    let sentHead = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentHead) {
          sentHead = true;
          controller.enqueue(enc.encode(head));
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(enc.encode(`\r\n--${boundary}--\r\n`));
          controller.close();
          return;
        }
        controller.enqueue(value);
      },
    });
    const out = await readUpload(request(stream, { 'content-type': `multipart/form-data; boundary=${boundary}` }), 4 * 1024);
    expect(out).toMatchObject({ status: 413 });
    // 4 KiB + 64 KiB overhead, not the whole ~1 MiB.
    expect(state.pulled).toBeLessThan(80);
  });

  it('413s a multipart file over the limit even when the envelope fits the overhead', async () => {
    const form = new FormData();
    form.set('file', new File(['x'.repeat(5000)], 'a.csv', { type: 'text/csv' }));
    const probe = new Request('http://x', { method: 'POST', body: form });
    const out = await readUpload(probe, 4096);
    expect(out).toMatchObject({ status: 413 });
  });

  it('rejects a declared Content-Length over the limit before reading', async () => {
    const { stream, state } = chunkedBody(10, 1024);
    const req = request(stream, { 'content-type': 'text/csv' });
    const headers = new Headers(req.headers);
    headers.set('content-length', String(10 * 1024));
    const out = await readUpload(new Request(req, { headers }), 4096);
    expect(out).toMatchObject({ status: 413 });
    expect(state.pulled).toBeLessThanOrEqual(1); // the runtime may prefetch one chunk
  });

  it('reads a body within the limit and infers the format', async () => {
    expect(await readUpload(request('a,b\r\n1,2\r\n', { 'content-type': 'text/csv' }), 1024)).toEqual({
      body: 'a,b\r\n1,2\r\n',
      format: 'csv',
    });
    const { stream } = chunkedBody(4, 1024);
    const out = await readUpload(request(stream, { 'content-type': 'application/octet-stream' }), 4096);
    expect(out).toMatchObject({ format: undefined });
    expect('body' in out && out.body.length).toBe(4096);

    const form = new FormData();
    form.set('file', new File(['[]'], 'Export.JSON', { type: 'application/json' }));
    expect(await readUpload(new Request('http://x', { method: 'POST', body: form }), 1024)).toEqual({ body: '[]', format: 'json' });
  });
});

describe('import read paths', () => {
  const job = {
    id: 'job_1',
    siteId: 'site_1',
    collection: 'products',
    format: 'csv',
    mode: 'create',
    status: 'running',
    principal: {},
    createdBy: 'usr_1',
    sourceBytes: 10,
    totalRows: 4,
    cursor: 2,
    createdRows: 2,
    updatedRows: 0,
    failedRows: 0,
    errors: [],
    errorsTruncated: 0,
    message: null,
    timeoutMs: 1000,
    cancelRequestedAt: null,
    leaseOwner: null,
    leaseUntil: null,
    startedAt: new Date(0),
    finishedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  function appWithFakeDb() {
    const selections: Array<Record<string, unknown> | undefined> = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown) => resolve([job]),
    };
    const db = {
      select: (cols?: Record<string, unknown>) => {
        selections.push(cols);
        return chain;
      },
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db as unknown as AppEnv['Variables']['db']);
      c.set('siteId', 'site_1');
      c.set('auth', { userId: 'usr_1', roles: [], raw: {} } as unknown as AppEnv['Variables']['auth']);
      await next();
    });
    app.route('/imports', importsRouter);
    return { app, selections };
  }

  it.each(['/imports/job_1', '/imports', '/imports/job_1/errors'])('GET %s never selects the stored source', async (path) => {
    const { app, selections } = appWithFakeDb();
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain('source"');
    expect(selections.length).toBeGreaterThan(0);
    for (const cols of selections) {
      // `select()` with no projection would load every column, `source` included.
      expect(cols).toBeDefined();
      expect(Object.keys(cols!)).not.toContain('source');
      expect(Object.keys(cols!)).toContain('cursor');
    }
  });
});
