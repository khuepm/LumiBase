// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * Deployments page — environments, promotion and pending approvals (#743),
 * seen by an Editor who may trigger staging and request production, but may
 * not approve, connect targets or read build logs.
 */

const api = vi.hoisted(() => ({
  envDeploy: vi.fn(),
  promote: vi.fn(),
  decide: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    deployments: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      targets: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'tgt_stg', provider: 'vercel', name: 'Staging site', projectId: 'p', defaultBranch: 'main', status: 'active' },
            { id: 'tgt_prod', provider: 'vercel', name: 'Prod site', projectId: 'p', defaultBranch: 'main', status: 'active' },
          ],
        }),
        deploy: vi.fn(),
      },
      access: vi.fn().mockResolvedValue({
        data: {
          admin: false,
          capabilities: ['deploy:trigger:staging', 'deploy:trigger:production'],
          humanDecider: true,
          environments: [
            { key: 'preview', canTrigger: false, canApprove: false },
            { key: 'staging', canTrigger: true, canApprove: false },
            { key: 'production', canTrigger: true, canApprove: false },
          ],
        },
      }),
      environments: {
        list: vi.fn().mockResolvedValue({
          data: [
            { key: 'preview', name: 'Preview', targetIds: [], requiresApproval: false, promotesTo: null },
            { key: 'staging', name: 'Staging', targetIds: ['tgt_stg'], requiresApproval: false, promotesTo: 'production' },
            { key: 'production', name: 'Production', targetIds: ['tgt_prod'], requiresApproval: true, promotesTo: null },
          ],
        }),
        deploy: api.envDeploy,
        promote: api.promote,
      },
      approvals: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'apr_mine', kind: 'trigger', scope: 'environment', environment: 'production',
              sourceEnvironment: null, sourceDeploymentId: null, targetIds: ['tgt_prod'], branch: 'main',
              reason: null, status: 'pending', requestedBy: { type: 'user', id: 'usr_editor' },
              createdAt: '', expiresAt: '', decidedAt: null, decidedBy: null, result: null, canDecide: false,
            },
            {
              id: 'apr_other', kind: 'promote', scope: 'environment', environment: 'production',
              sourceEnvironment: 'staging', sourceDeploymentId: 'dep_1', targetIds: ['tgt_prod'], branch: null,
              reason: 'launch', status: 'pending', requestedBy: { type: 'user', id: 'usr_x' },
              createdAt: '', expiresAt: '', decidedAt: null, decidedBy: null, result: null, canDecide: true,
            },
          ],
        }),
        decide: api.decide,
      },
    },
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

import { DeploymentsPage } from '../deployments-page';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DeploymentsPage — environments & approvals (#743)', () => {
  it('shows environments with the actions the caller holds', async () => {
    renderWithClient(<DeploymentsPage />);
    const staging = await screen.findByRole('button', { name: /deploy staging/i });
    expect(staging).toBeEnabled();
    expect(screen.getByRole('button', { name: /request production deploy/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /deploy preview/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /promote to production/i })).toBeEnabled();
    expect(screen.getByText('Approval required')).toBeInTheDocument();
    // Admin-only configuration is hidden from an Editor.
    await waitFor(() => expect(screen.queryByRole('button', { name: /connect target/i })).toBeNull());
    expect(screen.queryByRole('button', { name: /edit environments/i })).toBeNull();
  });

  it('a production request surfaces the pending-approval notice', async () => {
    api.envDeploy.mockResolvedValue({
      data: { status: 'pending_approval', environment: 'production', approval: { id: 'apr_new' } },
    });
    renderWithClient(<DeploymentsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /request production deploy/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/approval requested for production/i);
    expect(api.envDeploy).toHaveBeenCalledWith('production', expect.any(Object));
  });

  it('lists pending approvals; only the decidable one offers Approve', async () => {
    api.decide.mockResolvedValue({ data: { id: 'apr_other', status: 'approved' } });
    renderWithClient(<DeploymentsPage />);
    expect(await screen.findByText(/promote staging → production/i)).toBeInTheDocument();
    expect(screen.getByText('Waiting for an approver')).toBeInTheDocument();
    const approve = screen.getAllByRole('button', { name: 'Approve' });
    expect(approve).toHaveLength(1);
    fireEvent.click(approve[0]!);
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('apr_other', { decision: 'approved' }));
  });
});
