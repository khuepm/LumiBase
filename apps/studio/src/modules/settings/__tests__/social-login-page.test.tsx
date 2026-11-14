// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SocialLoginSettingsPage, parseRedirectUris, type ProviderConfigRow } from '../social-login-page';

/** Settings → Social login (#736): per-site provider configuration. */

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SocialLoginSettingsPage />
    </QueryClientProvider>,
  );
}

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const row = (provider: ProviderConfigRow['provider'], over: Partial<ProviderConfigRow> = {}): ProviderConfigRow => ({
  provider,
  configured: false,
  enabled: false,
  clientId: null,
  hasClientSecret: false,
  appleTeamId: null,
  appleKeyId: null,
  hasApplePrivateKey: false,
  allowedRedirectUris: [],
  callbackUri: `https://cms.example.com/api/v1/auth/social/callback/site_a/${provider}`,
  updatedAt: null,
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('parseRedirectUris', () => {
  it('splits lines and drops blanks', () => {
    expect(parseRedirectUris(' https://a.io/cb \n\nmyapp://cb\r\n')).toEqual(['https://a.io/cb', 'myapp://cb']);
  });
});

describe('SocialLoginSettingsPage', () => {
  it('shows each provider with its callback URL and never pre-fills a stored secret', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          row('google', { configured: true, enabled: true, clientId: 'g-client', hasClientSecret: true, allowedRedirectUris: ['https://a.io/cb'] }),
          row('apple'),
          row('github'),
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText('https://cms.example.com/api/v1/auth/social/callback/site_a/google')).toBeTruthy();
    expect(screen.getByTestId('callback-apple').textContent).toContain('/callback/site_a/apple');
    const secret = screen.getByPlaceholderText('Stored — leave blank to keep the current secret') as HTMLInputElement;
    expect(secret.value).toBe('');
    expect(screen.getByDisplayValue('g-client')).toBeTruthy();
  });

  it('saves a provider with PUT, sending the secret only when typed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [row('github')] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: row('github', { configured: true }) }))
      .mockResolvedValue(jsonResponse(200, { data: [row('github', { configured: true })] }));
    renderPage();
    const card = (await screen.findByText('GitHub')).closest('section')!;
    const inputs = within(card).getAllByRole('textbox');
    fireEvent.change(inputs[0]!, { target: { value: 'gh-client' } });
    fireEvent.change(card.querySelector('input[type="password"]')!, { target: { value: 'gh-secret' } });
    fireEvent.change(card.querySelector('textarea')!, { target: { value: 'https://a.io/cb' } });
    fireEvent.click(within(card).getByRole('checkbox'));
    fireEvent.click(within(card).getByRole('button', { name: /Save GitHub/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [putUrl, init] = fetchMock.mock.calls[1]!;
    expect(String(putUrl)).toContain('/api/v1/admin/social-providers/github');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({
      enabled: true,
      clientId: 'gh-client',
      clientSecret: 'gh-secret',
      allowedRedirectUris: ['https://a.io/cb'],
    });
    expect(await within(card).findByRole('status')).toBeTruthy();
  });

  it('shows the API error message when saving is refused', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { data: [row('google', { clientId: 'x' })] }))
      .mockResolvedValueOnce(jsonResponse(400, { errors: [{ code: 'PROVIDER_INCOMPLETE', message: 'Cannot enable google: missing clientSecret.' }] }));
    renderPage();
    const card = (await screen.findByText('Google')).closest('section')!;
    fireEvent.click(within(card).getByRole('button', { name: /Save Google/ }));
    expect(await within(card).findByText('Cannot enable google: missing clientSecret.')).toBeTruthy();
  });
});
