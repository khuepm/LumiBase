// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const createCollection = vi.fn();
const navigate = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    schema: {
      createCollection,
    },
  }),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

import { CollectionWizardPage } from '../wizard';

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

describe('CollectionWizardPage', () => {
  it('sends Directus parity collection settings as top-level create payload', async () => {
    createCollection.mockResolvedValueOnce({
      data: {
        id: 'col_posts',
        name: 'posts',
        singleton: true,
        meta: {},
      },
    });

    renderWithClient(<CollectionWizardPage />);

    fireEvent.change(screen.getByLabelText(/machine name/i), {
      target: { value: 'posts' },
    });
    fireEvent.click(screen.getByLabelText(/singleton/i));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Editorial posts' },
    });
    fireEvent.change(screen.getByLabelText(/accountability/i), {
      target: { value: 'activity' },
    });
    fireEvent.click(screen.getByLabelText(/enable content versioning/i));
    fireEvent.change(screen.getByLabelText(/primary key/i), {
      target: { value: 'uuid' },
    });
    fireEvent.change(screen.getByLabelText(/storage mode/i), {
      target: { value: 'materialized' },
    });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /create collection/i }));

    await waitFor(() => {
      expect(createCollection).toHaveBeenCalledWith({
        name: 'posts',
        singleton: true,
        note: 'Editorial posts',
        accountability: 'activity',
        versioning: true,
        primaryKeyType: 'uuid',
        storageMode: 'materialized',
      });
    });
  });

  it('blocks unsupported primary key and storage mode combinations before submit', async () => {
    renderWithClient(<CollectionWizardPage />);

    fireEvent.change(screen.getByLabelText(/machine name/i), {
      target: { value: 'posts' },
    });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.change(screen.getByLabelText(/primary key/i), {
      target: { value: 'integer' },
    });

    expect(
      screen.getByText(/integer primary keys require materialized or physical storage mode/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
    expect(createCollection).not.toHaveBeenCalled();
  });
});
