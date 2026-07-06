// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * TM suggestion + completion tests (translation-memory-ui Req 3.1, 3.2, 5.1).
 * **Validates: Requirements 3.1, 3.2, 5.1**
 */

vi.mock('@/lib/api', () => ({ getActiveToken: () => 'tok', getActiveSite: () => 'site_1' }));

import { TmSuggestPopover } from '../tm-suggest-popover';
import { completionPct, isTranslatableField, translatableFields } from '../translatable-fields';
import type { FieldResource } from '@lumibase/sdk';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

function jsonResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ data }) } as Response;
}

describe('TmSuggestPopover', () => {
  it('debounces a lookup and applies the best match', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ match: { entry: { id: 'e1', targetText: 'Xin chào', sourceText: 'Hello', quality: 100 }, score: 92 } }),
    );
    const onApply = vi.fn();
    render(<TmSuggestPopover sourceText="Hello" sourceLang="en" targetLang="vi" onApply={onApply} />);

    await waitFor(() => expect(screen.getByText('Xin chào')).toBeTruthy());
    expect(screen.getByText(/92% · TM/)).toBeTruthy();
    // One debounced request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/tm/lookup');

    fireEvent.click(screen.getByRole('button', { name: /apply/i }));
    expect(onApply).toHaveBeenCalledWith('Xin chào');
  });

  it('renders nothing for an empty source', () => {
    render(<TmSuggestPopover sourceText="  " sourceLang="en" targetLang="vi" onApply={vi.fn()} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const field = (over: Partial<FieldResource>): FieldResource =>
  ({ id: 'f', collectionId: 'c', name: 'title', type: 'text', interface: 'input', required: false, hidden: false, ...over }) as FieldResource;

describe('translatable-fields', () => {
  it('detects translatable-text interface and translations special', () => {
    expect(isTranslatableField(field({ interface: 'translatable-text' }))).toBe(true);
    expect(isTranslatableField(field({ special: ['translations'] }))).toBe(true);
    expect(isTranslatableField(field({ interface: 'input' }))).toBe(false);
  });

  it('computes completion % over fields with a source value', () => {
    const fields = [
      field({ name: 'title', interface: 'translatable-text' }),
      field({ name: 'body', interface: 'translatable-text' }),
      field({ name: 'slug', interface: 'input' }),
    ];
    const data = {
      title: { en: 'Hello', vi: 'Xin chào' }, // translated
      body: { en: 'World', vi: '' }, // untranslated
      slug: 'hello',
    };
    expect(completionPct(fields, data, 'en', 'vi')).toBe(50);
  });

  it('returns 0 when nothing is translatable', () => {
    expect(completionPct([field({ interface: 'input' })], {}, 'en', 'vi')).toBe(0);
    expect(translatableFields([field({ interface: 'input' })])).toHaveLength(0);
  });
});
