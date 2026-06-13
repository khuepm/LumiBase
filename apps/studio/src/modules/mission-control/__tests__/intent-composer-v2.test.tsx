// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Intent Composer v2 — rule cards (content-os-ui task 12.3).
 *
 * **Validates: Requirements 11.1, 11.2, 11.6**
 */

const api = vi.hoisted(() => ({
  compileIntent: vi.fn(),
  createIntent: vi.fn().mockResolvedValue({}),
}));

vi.mock('../api', () => ({ missionControlApi: api }));

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    schema: {
      listCollections: vi
        .fn()
        .mockResolvedValue({ data: [{ name: 'articles', label: 'Articles' }] }),
    },
  }),
}));

import { IntentComposer } from '../intent-composer';

function renderComposer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <IntentComposer onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.compileIntent.mockResolvedValue({
    rules: [{ type: 'freshness', maxAgeDays: 90 }],
    schedule: '0 6 * * *',
    warnings: ['Demo warning'],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function pickCollection() {
  // The picker options load async — change only once the option exists,
  // otherwise the controlled <select> swallows the value.
  await screen.findByRole('option', { name: 'Articles' });
  fireEvent.change(screen.getByLabelText(/^collection$/i), { target: { value: 'articles' } });
}

async function compileWith(description: string) {
  fireEvent.change(screen.getByLabelText(/describe the desired state/i), {
    target: { value: description },
  });
  await pickCollection();
  fireEvent.click(screen.getByRole('button', { name: /compile to rules/i }));
  await waitFor(() => expect(api.compileIntent).toHaveBeenCalled());
}

describe('IntentComposer v2', () => {
  it('keeps compile disabled until both description and collection are set (Req 11.1)', async () => {
    renderComposer();
    const compile = screen.getByRole('button', { name: /compile to rules/i });
    expect(compile).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/describe the desired state/i), {
      target: { value: 'fresh articles' },
    });
    expect(compile).toBeDisabled();

    await pickCollection();
    expect(compile).not.toBeDisabled();
  });

  it('renders compiled rules as cards with warnings, edits a param, confirms a structured payload (Req 11.2, 11.6)', async () => {
    renderComposer();
    await compileWith('articles fresher than 90 days');

    // The card's typed editor proves the rule landed as a structured form.
    const maxAge = await screen.findByLabelText(/max age/i);
    expect(screen.getByText(/demo warning/i)).toBeInTheDocument();

    // Tighten the rule on its card, then confirm.
    fireEvent.change(maxAge, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm & create intent/i }));

    await waitFor(() => expect(api.createIntent).toHaveBeenCalled());
    const body = api.createIntent.mock.calls[0]![0] as {
      collection: string;
      rules: Array<Record<string, unknown>>;
      schedule: string;
      autonomyCap: number;
      budget: Record<string, number>;
    };
    expect(body.collection).toBe('articles');
    expect(body.rules).toEqual([{ type: 'freshness', maxAgeDays: 30 }]);
    expect(body.schedule).toBe('0 6 * * *');
    expect(body.autonomyCap).toBe(2);
    expect(body.budget.maxGoalsPerCycle).toBe(10);
  });

  it('adds and removes rules by hand without compiling (Req 11.2)', async () => {
    renderComposer();
    fireEvent.change(await screen.findByLabelText(/add rule/i), {
      target: { value: 'required_fields' },
    });
    // The card is identified by its remove button — the Add-rule menu also
    // contains the type name as an <option>.
    const remove = await screen.findByRole('button', { name: /remove required_fields rule/i });
    expect(screen.getByLabelText(/^fields/i)).toBeInTheDocument();

    fireEvent.click(remove);
    expect(
      screen.queryByRole('button', { name: /remove required_fields rule/i }),
    ).not.toBeInTheDocument();
  });
});
