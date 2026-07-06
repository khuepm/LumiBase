// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Learn-TM on save tests (translation-memory-ui Req 6.1).
 * **Validates: Requirements 6.1**
 */

vi.mock('@/lib/api', () => ({ getActiveToken: () => 'tok', getActiveSite: () => 'site_1' }));

import { learnFromItem } from '../learn-tm';
import type { FieldResource } from '@lumibase/sdk';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => fetchMock.mockReset());

function ok(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ data }) } as Response;
}

const field = (name: string): FieldResource =>
  ({ id: name, collectionId: 'c', name, type: 'text', interface: 'translatable-text', required: false, hidden: false }) as FieldResource;

const item = { title: { en: 'Hello', vi: 'Xin chào' }, body: { en: 'World', vi: '' } };

describe('learnFromItem', () => {
  it('upserts human TM entries when learn-TM is enabled (default)', async () => {
    // setting fetch → enabled (absent value defaults on), then one upsert.
    fetchMock
      .mockResolvedValueOnce(ok({ value: { enabled: true } })) // isLearnTmEnabled
      .mockResolvedValueOnce(ok({ id: 'tm1' })); // upsert title (vi)
    const n = await learnFromItem([field('title'), field('body')], item, 'en', ['vi']);
    expect(n).toBe(1); // only title has a vi value
    const upsertCall = fetchMock.mock.calls.find((c) => c[0] === '/api/v1/tm');
    expect(JSON.parse(upsertCall![1].body)).toMatchObject({ source: 'human', quality: 100, targetText: 'Xin chào' });
  });

  it('skips entirely when the setting is disabled', async () => {
    fetchMock.mockResolvedValueOnce(ok({ value: { enabled: false } }));
    const n = await learnFromItem([field('title')], item, 'en', ['vi']);
    expect(n).toBe(0);
    // Only the settings read; no /api/v1/tm POST.
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/v1/tm')).toBe(false);
  });
});
