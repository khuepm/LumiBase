// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/** Settings → Preview and Data model → Preview URL (epic #667, V01 #679 / V02 #680). */

const preview = {
  getSettings: vi.fn(),
  listTokens: vi.fn(),
  updateSettings: vi.fn(),
  revokeToken: vi.fn(),
  revokeAll: vi.fn(),
};
const schema = { getCollection: vi.fn(), updateCollection: vi.fn() };
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ preview, schema }) }));

import { PreviewSettingsPage } from '../preview-page';
import { PreviewUrlSection } from '../../data-model/preview-url-section';

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  for (const fn of [...Object.values(preview), ...Object.values(schema)]) fn.mockReset();
});

const token = {
  id: 'prv_1', siteId: 's', collection: 'posts', itemId: 'itm_1', versionKey: null, releaseId: null, locale: 'vi',
  createdBy: 'u', expiresAt: '2030-01-01T00:00:00Z', revokedAt: null, revokedBy: null, useCount: 3, lastUsedAt: null, createdAt: '2029-12-31T00:00:00Z',
};

describe('PreviewSettingsPage', () => {
  it('validates origins, saves settings, revokes and rotates tokens', async () => {
    preview.getSettings.mockResolvedValue({ data: { allowedOrigins: ['https://a.example'], ttlSeconds: 900 } });
    preview.listTokens.mockResolvedValue({ data: [token] });
    preview.updateSettings.mockResolvedValue({ data: {} });
    preview.revokeToken.mockResolvedValue({ data: {} });
    preview.revokeAll.mockResolvedValue({ data: { revoked: 1 } });
    vi.stubGlobal('confirm', () => true);
    wrap(<PreviewSettingsPage />);

    expect(await screen.findByText('https://a.example')).toBeTruthy();
    expect(await screen.findByText('posts/itm_1')).toBeTruthy();

    const input = screen.getByPlaceholderText('https://www.example.com');
    fireEvent.change(input, { target: { value: 'https://*.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(screen.getByRole('alert').textContent).toContain('exact origin');
    fireEvent.change(input, { target: { value: 'http://localhost:3000/' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(screen.getByText('http://localhost:3000')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(preview.updateSettings).toHaveBeenCalledWith({
        allowedOrigins: ['https://a.example', 'http://localhost:3000'],
        ttlSeconds: 900,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Revoke token prv_1' }));
    await waitFor(() => expect(preview.revokeToken).toHaveBeenCalledWith('prv_1'));
    fireEvent.click(screen.getByRole('button', { name: /Rotate/ }));
    await waitFor(() => expect(preview.revokeAll).toHaveBeenCalled());
    expect(await screen.findByText('Revoked 1 token(s).')).toBeTruthy();
  });
});

describe('PreviewUrlSection', () => {
  it('rejects javascript: templates and merges meta on save', async () => {
    schema.getCollection.mockResolvedValue({ data: { name: 'posts', meta: { editorialWorkflow: true } } });
    schema.updateCollection.mockResolvedValue({ data: {} });
    wrap(<PreviewUrlSection collectionName="posts" />);
    const input = await screen.findByLabelText('Preview URL');
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'http://localhost:3000/api/preview?token={token}&id={id}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(schema.updateCollection).toHaveBeenCalledWith('posts', {
        meta: { editorialWorkflow: true, previewUrl: 'http://localhost:3000/api/preview?token={token}&id={id}' },
      }),
    );
  });
});
