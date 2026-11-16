import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv, AuthPrincipal } from '../../env';
import { requestItemOptions } from '../items';
import { ItemServiceError } from '../../services/item-service';
import { isAnonymousPrincipal } from '../../services/item-service-factory';

/** `publicationState` (#688) and `saveRevision` (#693) query options. */
function probe() {
  const app = new Hono<AppEnv>();
  app.all('/x', (c) => {
    try {
      return c.json({ data: requestItemOptions(c) });
    } catch (err) {
      if (err instanceof ItemServiceError) return c.json({ errors: [{ code: err.code }] }, 400);
      throw err;
    }
  });
  return app;
}

describe('requestItemOptions', () => {
  it('reads publicationState on GET only', async () => {
    const app = probe();
    expect(await (await app.request('/x?publicationState=preview')).json()).toEqual({
      data: { publicationState: 'preview' },
    });
    expect(await (await app.request('/x?publicationState=preview', { method: 'PATCH' })).json()).toEqual({ data: {} });
  });

  it('rejects an unknown cohort', async () => {
    const res = await probe().request('/x?publicationState=drafts');
    expect(res.status).toBe(400);
  });

  it('reads saveRevision on PATCH/PUT only', async () => {
    const app = probe();
    expect(await (await app.request('/x?saveRevision=false', { method: 'PATCH' })).json()).toEqual({
      data: { saveRevision: false },
    });
    expect(await (await app.request('/x?saveRevision=false', { method: 'PUT' })).json()).toEqual({
      data: { saveRevision: false },
    });
    expect(await (await app.request('/x?saveRevision=false')).json()).toEqual({ data: {} });
    expect((await app.request('/x?saveRevision=no', { method: 'PATCH' })).status).toBe(400);
  });
});

describe('isAnonymousPrincipal (#688 clamp)', () => {
  it('treats missing, anonymous and frontend-realm principals as public', () => {
    expect(isAnonymousPrincipal(undefined)).toBe(true);
    const p = (extra: Partial<AuthPrincipal>): AuthPrincipal => ({ raw: {}, ...extra }) as AuthPrincipal;
    expect(isAnonymousPrincipal(p({ type: 'anonymous', roleId: 'public' }))).toBe(true);
    expect(isAnonymousPrincipal(p({ userId: 'u1', isFrontendUser: true }))).toBe(true);
    expect(isAnonymousPrincipal(p({ userId: 'u1' }))).toBe(false);
    expect(isAnonymousPrincipal(p({ type: 'api_key', apiKeyId: 'k1' }))).toBe(false);
  });
});
