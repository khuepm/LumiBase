import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../../env';
import { captureOpsError, resetCaptureRateLimit, takeCaptureSlot, writeOpsError } from '../capture';

interface Call {
  text: string;
  values: unknown[];
}

function fakeSql(calls: Call[], fail = false) {
  return vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    if (fail) throw new Error('relation "lumibase_ops_errors" does not exist');
    return [];
  });
}

function appWith(sql: ReturnType<typeof fakeSql>) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-123');
    c.set('siteId', 'site_a');
    c.set('runtime', { database: { getSystemConnection: () => sql } } as never);
    await next();
    if (c.res.status >= 500) captureOpsError(c, { status: c.res.status, errorCode: Promise.resolve('RLS_MISCONFIGURED') });
  });
  app.get('/boom', () => {
    throw Object.assign(new Error('Failed query: select 1\nparams: hunter2'), { cause: { code: '42703', message: 'col' } });
  });
  app.get('/503', (c) => c.json({ errors: [{ code: 'RLS_MISCONFIGURED' }] }, 503));
  app.get('/ok', (c) => c.json({ ok: true }));
  app.onError((err, c) => {
    captureOpsError(c, { err, status: 500, errorCode: 'INTERNAL' });
    return c.json({ errors: [{ code: 'INTERNAL' }] }, 500);
  });
  return app;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ops error capture', () => {
  beforeEach(() => resetCaptureRateLimit());

  it('captures a thrown error once, sanitized, with release and request id', async () => {
    const calls: Call[] = [];
    const sql = fakeSql(calls);
    const app = appWith(sql);
    const res = await app.request('/boom?token=abc', {}, { LUMIBASE_VERSION: '2.0.1', LUMIBASE_GIT_SHA: 'abc123' });
    expect(res.status).toBe(500);
    await flush();
    const inserts = calls.filter((c) => c.text.includes('INSERT'));
    expect(inserts).toHaveLength(1);
    const v = inserts[0]!.values;
    expect(v[1]).toBe('req-123');
    expect(v[3]).toBe('/boom'); // path, no query string
    expect(v[4]).toBe(500);
    expect(v[5]).toBe('site_a');
    expect(v[7]).toBe('2.0.1+abc123');
    expect(v[8]).toBe('INTERNAL');
    expect(String(v[9])).toContain('42703');
    expect(String(v[9])).not.toContain('hunter2');
  });

  it('captures a non-throwing 5xx with the body error code', async () => {
    const calls: Call[] = [];
    const app = appWith(fakeSql(calls));
    await app.request('/503');
    await flush();
    const insert = calls.find((c) => c.text.includes('INSERT'))!;
    expect(insert.values[4]).toBe(503);
    expect(insert.values[8]).toBe('RLS_MISCONFIGURED');
    expect(insert.values[9]).toBeNull();
  });

  it('ignores non-5xx responses', async () => {
    const calls: Call[] = [];
    await appWith(fakeSql(calls)).request('/ok');
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('never fails the request when the write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await appWith(fakeSql([], true)).request('/boom');
    await flush();
    expect(res.status).toBe(500);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rate-caps writes per isolate', () => {
    let granted = 0;
    for (let i = 0; i < 100; i += 1) if (takeCaptureSlot(1_000)) granted += 1;
    expect(granted).toBe(60);
    expect(takeCaptureSlot(61_000)).toBe(true);
  });

  it('prunes past retention when sampled', async () => {
    const calls: Call[] = [];
    await writeOpsError(fakeSql(calls) as never, {
      id: 'x', requestId: 'r', method: 'GET', path: '/', status: 500, siteId: null,
      principal: null, release: null, errorCode: null, error: null, stack: null,
    }, true);
    expect(calls.map((c) => c.text.trim().split(/\s+/)[0])).toEqual(['INSERT', 'DELETE']);
  });
});
