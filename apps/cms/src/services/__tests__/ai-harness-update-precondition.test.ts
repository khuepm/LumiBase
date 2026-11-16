import { describe, expect, it, vi } from 'vitest';
import { AISecureHarness } from '../ai-harness';

/**
 * B119 (#518): `updateItem` takes an optional `expect` precondition, checked
 * when the handler runs. An approval can execute long after the proposal, so
 * this is the point where a human edit in between must stop the write.
 */
function harnessWith(current: Record<string, unknown>) {
  const patch = vi.fn(async () => ({ id: 'itm_1' }));
  const detail = vi.fn(async (_collection: string, _id: string, fields: string[]) =>
    Object.fromEntries(fields.filter((f) => f in current).map((f) => [f, current[f]])),
  );
  const itemService = {
    detail,
    patch,
    setProvenance: vi.fn(),
    beginWriteCoalescing: vi.fn(),
    flushCoalescedWrites: vi.fn(async () => undefined),
  };
  const harness = new AISecureHarness({ db: {} as never, siteId: 'site_1', itemService: itemService as never });
  return { harness, patch, detail };
}

describe('updateItem expect precondition (B119)', () => {
  it('writes when every expected field still holds its value (key order and absent fields aside)', async () => {
    const { harness, patch, detail } = harnessWith({ tags: ['a', 'b'], meta: { y: 2, x: 1 } });
    const result = await harness.runSkill('updateItem', {
      collection: 'posts',
      id: 'itm_1',
      data: { tags: ['a', 'b', 'news'] },
      expect: { tags: ['a', 'b'], meta: { x: 1, y: 2 }, missing: null },
    });
    expect(result.success).toBe(true);
    expect(detail).toHaveBeenCalledWith('posts', 'itm_1', ['tags', 'meta', 'missing']);
    expect(patch).toHaveBeenCalledWith('posts', 'itm_1', { data: { tags: ['a', 'b', 'news'] } });
  });

  it('refuses before writing when a field changed since the proposal', async () => {
    const { harness, patch } = harnessWith({ tags: ['opinion'] });
    const result = await harness.runSkill('updateItem', {
      collection: 'posts',
      id: 'itm_1',
      data: { tags: ['featured', 'news'] },
      expect: { tags: ['featured'] },
    });
    expect(result).toMatchObject({ success: false, code: 'ITEM_PRECONDITION_FAILED' });
    expect(!result.success && result.error).toMatch(/^ITEM_PRECONDITION_FAILED: tags changed since this update was proposed/);
    expect(patch).not.toHaveBeenCalled();
  });

  it('without expect behaves as before (no read)', async () => {
    const { harness, patch, detail } = harnessWith({ tags: ['opinion'] });
    const result = await harness.runSkill('updateItem', { collection: 'posts', id: 'itm_1', data: { tags: ['x'] } });
    expect(result.success).toBe(true);
    expect(detail).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('the canonical schema refuses an expect that is not a field map', async () => {
    const { harness, patch } = harnessWith({});
    const result = await harness.runSkill('updateItem', {
      collection: 'posts',
      id: 'itm_1',
      data: { tags: ['x'] },
      expect: ['tags'],
    });
    expect(result).toMatchObject({ success: false, code: 'VALIDATION' });
    expect(patch).not.toHaveBeenCalled();
  });
});
