// @vitest-environment jsdom
/**
 * Settings → Developer → Types: live OpenAPI switch (#745). The card reads
 * and writes `/api/v1/openapi/config` through the SDK client (no direct
 * base-URL or token handling — DoD §2d) and surfaces the admin-only 403.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LumiError } from '@lumibase/sdk';

const rawRequest = vi.fn();
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }), getActiveSite: () => 'site-a' }));
vi.mock('@/lib/api-base', () => ({ getApiBaseUrl: () => 'https://cms.example.test' }));

import { OpenApiSettingsCard } from '../openapi-settings-card';

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OpenApiSettingsCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rawRequest.mockReset();
});
afterEach(() => cleanup());

describe('OpenApiSettingsCard', () => {
  it('shows the disabled default and saves an enabled config with chosen realms', async () => {
    rawRequest.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === 'PUT' ? { data: JSON.parse(String(init.body)) } : { data: { enabled: false, realms: ['studio'] } },
    );
    renderCard();

    const enable = await screen.findByLabelText('Enable the OpenAPI endpoint');
    expect((enable as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(/openapi\.json/, { selector: 'pre' })).toBeNull();

    fireEvent.click(enable);
    fireEvent.click(screen.getByLabelText('API keys'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());
    expect(rawRequest).toHaveBeenCalledWith('/api/v1/openapi/config', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, realms: ['studio', 'api_key'] }),
    });
    expect(screen.getByText(/https:\/\/cms\.example\.test\/api\/v1\/openapi\.json/)).toBeTruthy();
  });

  it('explains the admin-only 403', async () => {
    rawRequest.mockRejectedValue(new LumiError(403, { errors: [{ code: 'FORBIDDEN' }] }, new Headers()));
    renderCard();
    expect(await screen.findByText('Only site admins can change the OpenAPI setting.')).toBeTruthy();
  });
});
