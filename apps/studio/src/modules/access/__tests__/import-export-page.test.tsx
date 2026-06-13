// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessExportManifest, AccessImportDiff, AccessImportDryRunResult } from '@lumibase/sdk';

const dryRunImport = vi.fn();
const importManifest = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    access: {
      dryRunImport,
      importManifest,
      exportManifest: vi.fn(),
    },
  }),
}));

import { AccessImportDialog, summarizeImportDiff } from '../import-export-page';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AccessImportDialog', () => {
  it('shows dry-run diff, warnings, and blocking conflicts from the import preview', async () => {
    dryRunImport.mockResolvedValueOnce({ data: dryRunResult({ valid: false }) });

    renderWithClient(<AccessImportDialog onClose={vi.fn()} onApplied={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/manifest json/i), {
      target: { files: [manifestFile()] },
    });

    expect(await screen.findByText('Dry-run blocked')).toBeInTheDocument();
    expect(screen.getByText('Blocking conflicts (1)')).toBeInTheDocument();
    expect(screen.getByText('Warnings (1)')).toBeInTheDocument();
    expect(screen.getByText('policy:editor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apply import/i })).toBeDisabled();
  });

  it('applies the selected import mode after a valid dry-run', async () => {
    dryRunImport.mockResolvedValueOnce({ data: dryRunResult({ valid: true, withConflicts: false }) });
    importManifest.mockResolvedValueOnce({ data: { applied: true } });
    const onApplied = vi.fn();

    renderWithClient(<AccessImportDialog onClose={vi.fn()} onApplied={onApplied} />);
    fireEvent.change(screen.getByLabelText(/manifest json/i), {
      target: { files: [manifestFile()] },
    });

    expect(await screen.findByText('Dry-run passed')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/replace managed/i));
    fireEvent.click(screen.getByRole('button', { name: /apply import/i }));

    await waitFor(() => {
      expect(importManifest).toHaveBeenCalledWith(expect.objectContaining({ schema: 'lumibase.access@v1' }), {
        mode: 'replace-managed',
      });
    });
    expect(onApplied).toHaveBeenCalled();
  });
});

describe('summarizeImportDiff', () => {
  it('totals entity and binding sections', () => {
    expect(summarizeImportDiff(diff())).toEqual({
      create: 3,
      update: 1,
      unchanged: 2,
      delete: 1,
    });
  });
});

function manifestFile(): File {
  return new File([JSON.stringify(manifest())], 'access.json', { type: 'application/json' });
}

function manifest(): AccessExportManifest {
  return {
    schema: 'lumibase.access@v1',
    exportedAt: '2026-06-05T00:00:00.000Z',
    roles: [],
    policies: [],
    bindings: {
      rolePolicies: [],
      userRoles: [],
      userPolicies: [],
      apiKeyRoles: [],
      apiKeyPolicies: [],
    },
    apiKeys: [],
  };
}

function dryRunResult({
  valid,
  withConflicts = true,
}: {
  valid: boolean;
  withConflicts?: boolean;
}): AccessImportDryRunResult {
  return {
    dryRun: true,
    valid,
    errors: valid ? [] : [{ code: 'VALIDATION', message: 'Resolve blocking conflicts.' }],
    diff: diff(),
    conflicts: {
      ok: valid,
      conflicts: withConflicts
        ? [
            {
              severity: 'blocking',
              collection: 'posts',
              action: 'read',
              existingPolicy: 'policy:public',
              incomingPolicy: 'policy:editor',
              reason: 'UNCONDITIONAL_RULE_WIDENS_RESTRICTED_RULE',
            },
          ]
        : [],
      warnings: withConflicts
        ? [
            {
              severity: 'warning',
              collection: 'posts',
              action: 'update',
              existingPolicy: 'policy:public',
              incomingPolicy: 'policy:editor',
              reason: 'OVERLAPPING_PERMISSION_REQUIRES_REVIEW',
            },
          ]
        : [],
    },
  };
}

function diff(): AccessImportDiff {
  return {
    roles: {
      create: 1,
      update: 0,
      unchanged: 0,
      delete: 0,
      entries: [{ ref: 'role:editor', status: 'create' }],
    },
    policies: {
      create: 1,
      update: 1,
      unchanged: 0,
      delete: 0,
      entries: [
        { ref: 'policy:editor', status: 'create' },
        { ref: 'policy:public', status: 'update' },
      ],
    },
    apiKeys: { create: 0, update: 0, unchanged: 1, delete: 0, entries: [] },
    bindings: {
      rolePolicies: { create: 1, update: 0, unchanged: 0, delete: 0, entries: [] },
      userRoles: { create: 0, update: 0, unchanged: 1, delete: 0, entries: [] },
      userPolicies: { create: 0, update: 0, unchanged: 0, delete: 1, entries: [] },
      apiKeyRoles: { create: 0, update: 0, unchanged: 0, delete: 0, entries: [] },
      apiKeyPolicies: { create: 0, update: 0, unchanged: 0, delete: 0, entries: [] },
    },
  };
}
