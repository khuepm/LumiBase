// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const rawRequest = vi.fn();
const perms = { isAdmin: false };

vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }) }));
vi.mock('@/lib/use-permissions', () => ({ usePermissions: () => perms }));
vi.mock('../widgets', () => {
  const Note = ({ widget }: { widget: { config?: Record<string, unknown> } }) => <p>note:{String(widget.config?.text ?? '')}</p>;
  const Plain = () => <p>plain</p>;
  const defs = [
    { type: 'collections', title: 'Collections', description: '', defaultSize: { w: 6, h: 4 }, component: Plain },
    { type: 'recent-activity', title: 'Recent activity', description: '', defaultSize: { w: 6, h: 4 }, component: Plain },
    { type: 'releases', title: 'Scheduled releases', description: '', defaultSize: { w: 6, h: 3 }, component: Plain },
    { type: 'agent-runs', title: 'Agent runs', description: '', defaultSize: { w: 6, h: 3 }, component: Plain },
    { type: 'note', title: 'Note', description: 'A note', defaultSize: { w: 4, h: 2 }, component: Note, configFields: [{ key: 'text', label: 'Text' }] },
  ];
  return {
    availableWidgets: () => defs,
    widgetDefinition: (t: string) => defs.find((d) => d.type === t),
  };
});

import { HomeDashboardPage } from '../dashboard-page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  perms.isAdmin = false;
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HomeDashboardPage />
    </QueryClientProvider>,
  );
}

describe('HomeDashboardPage (#691)', () => {
  it('shows the built-in layout when nothing is saved', async () => {
    rawRequest.mockResolvedValue({ data: { layout: null, source: 'default' } });
    renderPage();
    expect(await screen.findByText('Built-in layout')).toBeTruthy();
    expect(screen.getAllByText('Collections').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Agent runs').length).toBeGreaterThan(0);
  });

  it('adds and configures a widget and removes one', async () => {
    rawRequest.mockImplementation(async (path: string, init?: RequestInit) =>
      init?.method === 'PUT' ? { data: {} } : { data: { layout: null, source: 'default' } },
    );
    renderPage();
    fireEvent.click(await screen.findByText('Edit'));
    fireEvent.click(screen.getByText('Add widget'));
    fireEvent.click(screen.getByText('Note'));
    fireEvent.click(screen.getByLabelText('Configure Note'));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Apply'));
    expect(screen.getByText('note:hello')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Remove Agent runs'));
    expect(screen.queryByLabelText('Remove Agent runs')).toBeNull();
  });

  it('saves for the user, and only admins can save the site default', async () => {
    rawRequest.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === 'PUT' ? { data: {} } : { data: { layout: null, source: 'default' } },
    );
    renderPage();
    fireEvent.click(await screen.findByText('Edit'));
    expect(screen.queryByText('Save as site default')).toBeNull();
    fireEvent.click(screen.getByLabelText('Remove Agent runs'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(rawRequest).toHaveBeenCalledWith('/api/v1/dashboard/layout', expect.objectContaining({ method: 'PUT' })));
    const body = JSON.parse(rawRequest.mock.calls.find((c) => c[1]?.method === 'PUT')![1].body as string);
    expect(body.layout.widgets.map((w: { id: string }) => w.id)).not.toContain('agent-runs');
  });

  it('offers the site default to admins and a reset when the user has their own layout', async () => {
    perms.isAdmin = true;
    rawRequest.mockImplementation(async (path: string, init?: RequestInit) =>
      init?.method ? { data: {} } : { data: { layout: { version: 1, widgets: [{ id: 'n', type: 'note', x: 0, y: 0, w: 4, h: 2 }] }, source: 'user' } },
    );
    renderPage();
    expect(await screen.findByText('Your layout')).toBeTruthy();
    fireEvent.click(screen.getByText('Use the default'));
    await waitFor(() => expect(rawRequest).toHaveBeenCalledWith('/api/v1/dashboard/layout', { method: 'DELETE' }));
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Save as site default'));
    await waitFor(() =>
      expect(rawRequest).toHaveBeenCalledWith('/api/v1/dashboard/layout/site-default', expect.objectContaining({ method: 'PUT' })),
    );
  });
});
