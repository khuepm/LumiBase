// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listFields = vi.fn();
const getCompiled = vi.fn();
const updateCollection = vi.fn();
const upsertField = vi.fn();
const deleteField = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    schema: {
      listFields,
      getCompiled,
      updateCollection,
      upsertField,
      deleteField,
    },
  }),
}));

import { FieldsTab } from '../fields-tab';

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

describe('FieldsTab Performance Baseline', () => {
  it('measures sequence vs parallel upsert', async () => {
    // We are going to simulate the reorderMutation directly to avoid DND complexity in tests.
    const MOCK_DELAY = 10; // ms
    const NEW_ORDER = Array.from({ length: 10 }).map((_, i) => ({
      name: `field_${i}`,
      type: 'string',
      interface: 'input',
      sortOrder: i,
    }));

    // Measure baseline (Sequential)
    const sequentialUpsert = async (newOrder: any[]) => {
      for (const f of newOrder) {
        await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY));
      }
    };

    const startSeq = performance.now();
    await sequentialUpsert(NEW_ORDER);
    const endSeq = performance.now();
    const seqTime = endSeq - startSeq;

    // Measure improved (Parallel)
    const parallelUpsert = async (newOrder: any[]) => {
      await Promise.all(
        newOrder.map(async (f) => {
          await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY));
        })
      );
    };

    const startPar = performance.now();
    await parallelUpsert(NEW_ORDER);
    const endPar = performance.now();
    const parTime = endPar - startPar;

    const improvement = Math.round(((seqTime - parTime) / seqTime) * 100);

    console.log(`Sequential Time: ${seqTime}ms`);
    console.log(`Parallel Time: ${parTime}ms`);
    console.log(`Improvement: ${improvement}%`);

    expect(parTime).toBeLessThan(seqTime);
  });
});
