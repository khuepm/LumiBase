// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/** "Preview release" (epic #667, V04 #682). */

const mintToken = vi.fn();
const getCollection = vi.fn();
const getSetting = vi.fn();
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    preview: { mintToken },
    schema: { getCollection },
    settings: { get: getSetting },
  }),
}));

import { ReleasePreview } from '../release-preview';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const members = [
  { collection: 'posts', itemId: 'p1', targetStatus: 'published' },
  { collection: 'authors', itemId: 'a1', targetStatus: 'published' },
];

function renderPreview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReleasePreview releaseId="rel_1" items={members} />
    </QueryClientProvider>,
  );
}

describe('ReleasePreview', () => {
  it('mints one release token (with the chosen locale) and links every member that has a Preview URL', async () => {
    getSetting.mockResolvedValue({ data: { supported: ['en', 'vi'] } });
    getCollection.mockImplementation(async (name: string) => ({
      data: {
        name,
        meta:
          name === 'posts'
            ? { previewUrl: 'https://front.example/api/preview?token={token}&id={id}&release={release}&l={locale}' }
            : {},
      },
    }));
    mintToken.mockResolvedValue({ data: { token: 'tok en/1', expiresAt: '2030-01-01T00:00:00Z', locale: 'vi' } });
    renderPreview();

    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'vi' } });
    fireEvent.click(screen.getByRole('button', { name: /Create preview link/ }));

    await waitFor(() => expect(mintToken).toHaveBeenCalledWith({ releaseId: 'rel_1', locale: 'vi' }));
    const link = (await screen.findByRole('link', { name: /Open preview/ })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(
      'https://front.example/api/preview?token=tok%20en%2F1&id=p1&release=rel_1&l=vi',
    );
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
    // The member whose collection has no template is listed without a link.
    expect(screen.getByText('No Preview URL')).toBeTruthy();
  });

  it('explains when no collection in the release has a Preview URL', async () => {
    getSetting.mockResolvedValue({ data: null });
    getCollection.mockResolvedValue({ data: { meta: {} } });
    mintToken.mockResolvedValue({ data: { token: 't', expiresAt: '2030-01-01T00:00:00Z', locale: null } });
    renderPreview();
    fireEvent.click(screen.getByRole('button', { name: /Create preview link/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Preview URL');
    expect(mintToken).toHaveBeenCalledWith({ releaseId: 'rel_1' });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows mint errors inline', async () => {
    getSetting.mockResolvedValue({ data: null });
    getCollection.mockResolvedValue({ data: { meta: {} } });
    mintToken.mockRejectedValue(Object.assign(new Error('x'), { body: { errors: [{ message: 'Release "rel_1" not found.' }] } }));
    renderPreview();
    fireEvent.click(screen.getByRole('button', { name: /Create preview link/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('not found');
  });
});
