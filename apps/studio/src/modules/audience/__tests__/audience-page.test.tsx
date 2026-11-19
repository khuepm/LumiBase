// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Audience page (epic #672): members list through the API client, live
 * segment preview, sending-domain DNS records and status, Portal settings.
 */

const rawRequest = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }) }));

import { AudiencePage } from '../audience-page';

const DOMAIN = {
  id: 'd1',
  domain: 'news.example.test',
  status: 'verified',
  dkimSelector: 'lb2026110a0b0c',
  rotation: { state: 'idle', nextSelector: null, previousSelector: null },
  checks: { dmarcAligned: false, problems: ['Senders not aligned under adkim=s: a@sub.news.example.test.'] },
  records: [
    { purpose: 'dkim', host: 'lb2026110a0b0c._domainkey.news.example.test', valueChunks: '"v=DKIM1; k=rsa; p=AAA" "BBB"', status: 'ok' },
    { purpose: 'dmarc', host: '_dmarc.news.example.test', valueChunks: '"v=DMARC1; p=none"', status: 'missing' },
  ],
  lastCheckedAt: null,
};

function route(path: string, init?: RequestInit) {
  if (path.startsWith('/api/v1/members?')) return { data: [{ id: 'm1', email: 'reader@example.test', name: null, status: 'free', tier: { id: 't', key: 'free', name: 'Free' }, labels: [], newsletters: [], emailOpenRate: 50, hasAccount: true }], meta: { total: 1 } };
  if (path === '/api/v1/members/segments') return { data: [{ id: 's1', name: 'Quiet', count: 7, filter: {} }] };
  if (path === '/api/v1/members/tiers') return { data: [] };
  if (path === '/api/v1/members/segments/preview') return { data: { count: JSON.parse(String(init?.body)).filter.match === 'any' ? 3 : 12, sample: [] } };
  if (path === '/api/v1/email/sending-domains' && !init) return { data: [DOMAIN] };
  if (path.endsWith('/check')) return { data: DOMAIN };
  if (path === '/api/v1/members/settings' && !init) return { data: { portalEnabled: false, allowSelfSignup: true, redirectUris: ['https://blog.example.test/in'], signupCopy: {} } };
  if (path === '/api/v1/members/settings') return { data: {} };
  throw new Error(`unexpected ${path}`);
}

function renderPage(tab?: Parameters<typeof AudiencePage>[0]['initialTab']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AudiencePage initialTab={tab} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockImplementation(async (path: string, init?: RequestInit) => route(path, init));
});
afterEach(cleanup);

describe('AudiencePage', () => {
  it('lists members with the segment counts in the filter', async () => {
    renderPage();
    expect(await screen.findByText('reader@example.test')).toBeTruthy();
    expect(await screen.findByText('Quiet (7)')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('previews a segment filter live', async () => {
    renderPage('segments');
    await waitFor(() => expect(screen.getByTestId('segment-preview').textContent).toBe('Matches 12 members now.'));
    fireEvent.change(screen.getByLabelText('Segment filter'), { target: { value: '{"match":"any","conditions":[]}' } });
    await waitFor(() => expect(screen.getByTestId('segment-preview').textContent).toBe('Matches 3 members now.'));
    fireEvent.change(screen.getByLabelText('Segment filter'), { target: { value: '{oops' } });
    expect(screen.getByTestId('segment-preview').textContent).toBe('Filter is not valid JSON.');
  });

  it('shows DNS records with status and checks on demand', async () => {
    renderPage('domains');
    const card = await screen.findByTestId('domain-news.example.test');
    expect(card.textContent).toContain('verified');
    expect(card.textContent).toContain('DMARC not aligned');
    expect(card.textContent).toContain('"v=DKIM1; k=rsa; p=AAA" "BBB"');
    expect(card.textContent).toContain('missing');
    fireEvent.click(screen.getByText('Check DNS'));
    await waitFor(() => expect(rawRequest).toHaveBeenCalledWith('/api/v1/email/sending-domains/d1/check', { method: 'POST' }));
  });

  it('saves Portal settings', async () => {
    renderPage('portal');
    const box = (await screen.findByLabelText('Landing URLs')) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe('https://blog.example.test/in'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(rawRequest).toHaveBeenCalledWith('/api/v1/members/settings', {
        method: 'PATCH',
        body: JSON.stringify({ redirectUris: ['https://blog.example.test/in'], signupCopy: {} }),
      }),
    );
  });
});
