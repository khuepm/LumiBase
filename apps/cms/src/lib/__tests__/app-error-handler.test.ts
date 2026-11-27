import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../../env';

const captureOpsError = vi.fn();
vi.mock('../../modules/ops/capture', () => ({ captureOpsError: (...args: unknown[]) => captureOpsError(...args) }));

const { appErrorHandler } = await import('../app-error-handler');

/**
 * #1046 safety net: a route that calls `schema.parse()` / `c.req.json()`
 * directly must answer 400 VALIDATION, not 500 INTERNAL, and must not land in
 * the ops error feed. Real server faults keep the 500 + capture.
 */
function buildApp(thrower: (c: { req: { json: () => Promise<unknown> } }) => Promise<unknown>) {
  const app = new Hono<AppEnv>();
  app.all('/t', async (c) => {
    await thrower(c);
    return c.json({ data: 'unreachable' });
  });
  app.onError(appErrorHandler);
  return app;
}

type ErrorBody = { errors: Array<{ code: string; message: string }> };

describe('appErrorHandler (#1046)', () => {
  beforeEach(() => {
    captureOpsError.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('maps a ZodError to 400 VALIDATION without capturing an ops error', async () => {
    const app = buildApp(async () => z.object({ email: z.string().email() }).parse({}));
    const res = await app.request('/t', { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
    const json = (await res.json()) as ErrorBody;
    expect(json.errors.length).toBeGreaterThan(0);
    expect(json.errors.every((e) => e.code === 'VALIDATION')).toBe(true);
    expect(captureOpsError).not.toHaveBeenCalled();
  });

  it('maps a JSON SyntaxError from body parsing to 400 VALIDATION without capturing', async () => {
    const app = buildApp(async (c) => c.req.json());
    const res = await app.request('/t', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }],
    });
    expect(captureOpsError).not.toHaveBeenCalled();
  });

  it('keeps a JSON SyntaxError on a GET (no body) as a 500 server fault', async () => {
    const app = buildApp(async () => JSON.parse('{bad'));
    const res = await app.request('/t', { method: 'GET' });
    expect(res.status).toBe(500);
    expect(captureOpsError).toHaveBeenCalledTimes(1);
  });

  it('keeps any other error as 500 INTERNAL and captures it', async () => {
    const app = buildApp(async () => {
      throw new Error('boom');
    });
    const res = await app.request('/t', { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
    const json = (await res.json()) as ErrorBody;
    expect(json.errors[0]?.code).toBe('INTERNAL');
    expect(captureOpsError).toHaveBeenCalledTimes(1);
  });
});
