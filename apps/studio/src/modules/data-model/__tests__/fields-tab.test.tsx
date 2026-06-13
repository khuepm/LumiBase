// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('FieldsTab', () => {
  it('renders compiled system fields in a locked group and saves metadata overrides', async () => {
    listFields.mockResolvedValueOnce({
      data: [
        {
          id: 'field_title',
          name: 'title',
          type: 'string',
          interface: 'input',
          required: false,
          hidden: false,
          sortOrder: 0,
        },
      ],
    });
    getCompiled.mockResolvedValue({
      data: {
        name: 'posts',
        meta: { systemFields: { status: true, sort: true, audit: true } },
        systemFields: [
          {
            id: 'system:status',
            name: 'status',
            type: 'string',
            interface: 'select-dropdown',
            required: true,
            readonly: false,
            hidden: false,
            width: 'half',
            sortOrder: -700,
            display: 'labels',
            displayOptions: {},
            translations: {},
            system: true,
            locked: true,
          },
        ],
        fields: [],
      },
    });
    updateCollection.mockResolvedValueOnce({ data: { name: 'posts' } });

    renderWithClient(<FieldsTab collectionName="posts" />);

    expect(await screen.findByText('System fields')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'status' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/delete status/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'status' }));

    expect(screen.getByLabelText(/machine name/i)).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^layout$/i }));
    fireEvent.click(screen.getByLabelText(/hidden/i));
    fireEvent.click(screen.getByLabelText(/readonly/i));
    fireEvent.click(screen.getByRole('button', { name: /^full$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^storage$/i }));
    fireEvent.change(screen.getByLabelText(/translations/i), {
      target: { value: '{ "vi": { "label": "Trang thai" } }' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save field/i }));

    await waitFor(() => {
      expect(updateCollection).toHaveBeenCalledWith('posts', {
        meta: {
          systemFields: { status: true, sort: true, audit: true },
          systemFieldOverrides: {
            status: {
              display: 'labels',
              hidden: true,
              readonly: true,
              width: 'full',
              translations: { vi: { label: 'Trang thai' } },
            },
          },
        },
      });
    });
    expect(deleteField).not.toHaveBeenCalled();
  });
});
