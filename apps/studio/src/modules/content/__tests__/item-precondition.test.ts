import type { ItemRow } from '@lumibase/sdk';
import { describe, expect, it, vi } from 'vitest';
import { changedFields, isPreconditionFailed, saveFieldChanges } from '../save-conflict';

/** The item editor shows the "changed by someone else" banner only for 412 PRECONDITION_FAILED. */
describe('isPreconditionFailed', () => {
  it('matches a 412 with the PRECONDITION_FAILED code', () => {
    expect(
      isPreconditionFailed({ status: 412, body: { errors: [{ code: 'PRECONDITION_FAILED' }] } }),
    ).toBe(true);
  });

  it('ignores other failures', () => {
    expect(isPreconditionFailed({ status: 412, body: { errors: [{ code: 'OTHER' }] } })).toBe(false);
    expect(isPreconditionFailed({ status: 409, body: { errors: [{ code: 'PRECONDITION_FAILED' }] } })).toBe(false);
    expect(isPreconditionFailed(new Error('network'))).toBe(false);
    expect(isPreconditionFailed(null)).toBe(false);
  });
});

describe('saveFieldChanges', () => {
  const stale = { status: 412, body: { errors: [{ code: 'PRECONDITION_FAILED' }] } };
  const base: ItemRow = { status: 'draft', sort: 0, userCreated: null, userUpdated: null,
    createdAt: '2026-01-01', updatedAt: '2026-01-01', deletedAt: null, id: 'item', siteId: 'site', collectionId: 'posts', version: 3,
    data: { title: 'First', body: 'Original' } };
  const changes = { data: changedFields(base.data, { ...base.data, title: 'New' }) };

  it('retries only the edited field and respects a concurrent body and schedule change', async () => {
    const latest = { ...base, version: 4, publishAt: '2030-01-01', data: { ...base.data, body: 'Remote' } };
    const saved = { ...latest, version: 5, data: { ...latest.data, ...changes.data } };
    const write = vi.fn().mockRejectedValueOnce(stale).mockResolvedValueOnce(saved);
    expect(await saveFieldChanges(base, changes, async () => latest, write)).toEqual(saved);
    expect(write.mock.calls).toEqual([[{ data: { title: 'New' } }, 3], [{ data: { title: 'New' } }, 4]]);
  });

  it('keeps a same-field conflict and never retries without a version', async () => {
    for (const latest of [
      { ...base, version: 4, data: { ...base.data, title: 'Remote' } },
      { ...base, version: undefined },
    ]) {
      const write = vi.fn().mockRejectedValue(stale);
      await expect(saveFieldChanges(base, changes, async () => latest, write)).rejects.toBe(stale);
      expect(write).toHaveBeenCalledTimes(1);
    }
  });

  it('surfaces a second race', async () => {
    const write = vi.fn().mockRejectedValue(stale);
    await expect(saveFieldChanges(base, changes, async () => ({ ...base, version: 4 }), write)).rejects.toBe(stale);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
