// @vitest-environment jsdom
/**
 * Flows → Create from template (J11, #518): the template is built server-side
 * and saved as a draft manual flow through the flows API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LumiError } from '@lumibase/sdk';

const rawRequest = vi.fn();
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }) }));

import { CreateFromTemplate } from '../create-from-template';

const TEMPLATE = {
  key: 'taxonomy-tagging',
  name: 'Taxonomy tagging',
  description: 'Shadow by default; never publishes.',
  exampleParams: { profileKey: 'taxonomy', profileVersion: 1, collection: 'posts', questionKey: 'category', choices: ['news'], tagField: 'tags' },
  parameters: [{ name: 'tagField', type: 'string', required: true, description: 'Tags field.' }],
};
const BUILT = { name: 'Jev taxonomy tagging — posts', status: 'draft', triggerType: 'manual', triggerOptions: {}, graph: { entry: 'decide', nodes: [] } };

function renderIt(onCreated = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CreateFromTemplate onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return onCreated;
}

beforeEach(() => {
  rawRequest.mockImplementation(async (path: string) => {
    if (path === '/api/v1/ai/automation/templates') return { data: [TEMPLATE] };
    if (path === '/api/v1/ai/automation/templates/taxonomy-tagging/build') return { data: BUILT };
    if (path === '/api/v1/flows') return { data: { id: 'flow_1' } };
    throw new Error(`unexpected ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('create from template', () => {
  it('builds the template and saves the result as a draft flow', async () => {
    const onCreated = renderIt();
    fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'taxonomy-tagging' } });
    const params = screen.getByLabelText('Template parameters') as HTMLTextAreaElement;
    expect(JSON.parse(params.value)).toEqual(TEMPLATE.exampleParams);
    fireEvent.change(params, { target: { value: JSON.stringify({ ...TEMPLATE.exampleParams, collection: 'articles' }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft flow' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('flow_1'));
    const build = rawRequest.mock.calls.find(([p]) => String(p).endsWith('/build'))!;
    expect(JSON.parse(String((build[1] as RequestInit).body))).toMatchObject({ collection: 'articles' });
    const save = rawRequest.mock.calls.find(([p]) => p === '/api/v1/flows')!;
    expect(JSON.parse(String((save[1] as RequestInit).body))).toMatchObject({ status: 'draft', triggerType: 'manual' });
  });

  it('shows the server validation error and saves nothing', async () => {
    rawRequest.mockImplementation(async (path: string) => {
      if (path === '/api/v1/ai/automation/templates') return { data: [TEMPLATE] };
      throw new LumiError(400, { errors: [{ code: 'VALIDATION', message: 'Required', path: ['tagField'] }] });
    });
    renderIt();
    fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'taxonomy-tagging' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft flow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('tagField: Required');
    expect(rawRequest.mock.calls.some(([p]) => p === '/api/v1/flows')).toBe(false);
  });

  it('rejects malformed JSON before any request', async () => {
    renderIt();
    fireEvent.change(await screen.findByLabelText('Template'), { target: { value: 'taxonomy-tagging' } });
    fireEvent.change(screen.getByLabelText('Template parameters'), { target: { value: '{ nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft flow' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Parameters must be valid JSON.');
    expect(rawRequest).toHaveBeenCalledTimes(1);
  });

  it('tells a non-admin the templates are admin-only', async () => {
    rawRequest.mockRejectedValue(new LumiError(403, { errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] }));
    renderIt();
    expect(await screen.findByText('Automation templates are available to site admins only.')).toBeInTheDocument();
  });
});
