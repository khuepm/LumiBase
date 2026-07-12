// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * TM suggestion popover (translation-memory-ui).
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.5**
 */

const lookup = vi.fn();
const translate = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ tm: { lookup, translate } }),
}));

import { TmSuggestPopover } from '../tm-suggest-popover';

function renderPopover(props: Partial<React.ComponentProps<typeof TmSuggestPopover>> = {}) {
  const onApply = props.onApply ?? vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TmSuggestPopover
        sourceText="Hello"
        sourceLang="en"
        targetLang="vi"
        onApply={onApply}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onApply };
}

beforeEach(() => {
  lookup.mockReset();
  translate.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TmSuggestPopover', () => {
  it('looks up the source text (debounced) and applies a match as human', async () => {
    lookup.mockResolvedValue({ targetText: 'Xin chào', similarity: 92, source: 'human' });
    const { onApply } = renderPopover();

    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Hello', sourceLang: 'en', targetLang: 'vi', threshold: 75 }),
    );

    const apply = await screen.findByRole('button', { name: 'Apply' });
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith('Xin chào', 'human');
  });

  it('offers auto-translate when there is no match and applies as mt', async () => {
    lookup.mockResolvedValue(null);
    translate.mockResolvedValue({ data: { text: '[mt] Hello' } });
    const { onApply } = renderPopover();

    const auto = await screen.findByRole('button', { name: /Auto-translate/ });
    fireEvent.click(auto);
    await waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith('[mt] Hello', 'mt'));
  });

  it('does not look up when source and target locale are the same', async () => {
    renderPopover({ targetLang: 'en' });
    // Give the debounce + any effects a chance to fire, then assert nothing ran.
    await new Promise((r) => setTimeout(r, 350));
    expect(lookup).not.toHaveBeenCalled();
  });
});
