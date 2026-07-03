import { describe, it, expect } from 'vitest';
import app from './index';

describe('enterprise worker', () => {
  it('reports the enterprise edition at root', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { edition: string } };
    expect(body.data.edition).toBe('enterprise');
  });

  it('exposes a health endpoint', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });
});
