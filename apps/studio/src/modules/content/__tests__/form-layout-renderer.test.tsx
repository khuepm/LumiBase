// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFormVisibility, type FormLayout } from '@lumibase/contracts/form-layout';
import type { FieldResource } from '@lumibase/sdk';
import type { PermissionHelpers } from '@/lib/use-permissions';

vi.mock('@/lib/api', () => ({ getApiClient: () => ({}), hasActiveToken: () => true }));
vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined, useExtensionUpdates: () => 0 }));
vi.mock('@/hooks/use-presence', () => ({ useCoEditors: () => ({ coEditors: [], connected: false }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: () => null,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const { FieldsTab } = await import('../item-detail');
const { checkRequired, validationErrorsFrom } = await import('../form-layout-state');

/** Studio form renderer for collection form layouts (#750). */

const perms = {
  bundle: undefined,
  isLoading: false,
  isAdmin: true,
  can: () => true,
  get: () => null,
  fieldAllowed: () => true,
  filterFields: (_c: string, _a: string, f: string[]) => f,
} as unknown as PermissionHelpers;

function f(name: string, extra: Partial<FieldResource> = {}): FieldResource {
  return {
    id: `id_${name}`,
    collectionId: 'col',
    name,
    type: 'string',
    interface: 'input',
    required: false,
    hidden: false,
    sortOrder: 0,
    ...extra,
  };
}

const FIELDS = [
  f('title', { sortOrder: 1, required: true }),
  f('kind', { sortOrder: 2 }),
  f('url', { sortOrder: 3, required: true }),
  f('summary', { sortOrder: 4 }),
  f('seo_title', { sortOrder: 5 }),
  f('loose', { sortOrder: 0 }),
];

const LAYOUT: FormLayout = {
  version: 1,
  nodes: [
    {
      type: 'tab',
      id: 'content',
      label: 'Content',
      children: [
        { type: 'field', field: 'title' },
        { type: 'field', field: 'kind' },
        { type: 'divider', id: 'sep', label: 'Link details' },
        {
          type: 'group',
          id: 'link',
          label: 'Link',
          collapsible: true,
          visibleWhen: { field: 'kind', op: 'eq', value: 'link' },
          children: [{ type: 'field', field: 'url' }],
        },
      ],
    },
    { type: 'tab', id: 'extra', label: 'Extra', children: [{ type: 'field', field: 'summary' }] },
    {
      type: 'tab',
      id: 'seo',
      label: 'SEO',
      visibleWhen: { field: 'kind', op: 'nempty' },
      children: [{ type: 'field', field: 'seo_title' }],
    },
  ],
};

function Harness({
  initial = {},
  layout = LAYOUT,
  errors = {},
}: {
  initial?: Record<string, unknown>;
  layout?: FormLayout | null;
  errors?: Record<string, string>;
}) {
  const [value, setValue] = useState<Record<string, unknown>>(initial);
  return (
    <>
      <FieldsTab
        fields={FIELDS}
        value={value}
        onChange={setValue}
        collection="posts"
        perms={perms}
        pinnedFields={[]}
        layout={layout}
        errors={errors}
      />
      <button type="button" onClick={() => setValue((v) => ({ ...v, kind: 'link' }))}>
        set-kind-link
      </button>
    </>
  );
}

const renderedFields = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-field]')).map((el) => el.getAttribute('data-field'));

afterEach(() => cleanup());

describe('FieldsTab without a layout', () => {
  it('renders the classic flat form (sorted, no tabs) — backwards compatible', () => {
    const { container } = render(<Harness layout={null} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(renderedFields(container)).toEqual(['loose', 'title', 'kind', 'url', 'summary', 'seo_title']);
  });

  it('an empty layout renders the same fields in the same order', () => {
    const flat = renderedFields(render(<Harness layout={null} />).container);
    cleanup();
    const empty = renderedFields(render(<Harness layout={{ version: 1, nodes: [] }} />).container);
    expect(empty).toEqual(flat);
  });
});

describe('FieldsTab with a layout', () => {
  it('renders unplaced fields in the default section, then accessible tabs', () => {
    const { container } = render(<Harness />);
    // Default section first, then the active tab's fields.
    expect(renderedFields(container)).toEqual(['loose', 'title', 'kind']);
    const tabs = screen.getAllByRole('tab');
    // SEO tab hidden: kind is empty.
    expect(tabs.map((t) => t.textContent)).toEqual(['Content', 'Extra']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', tabs[0]!.id);
    expect(tabs[0]).toHaveAttribute('aria-controls', panel.id);
    expect(screen.getByRole('separator', { name: 'Link details' })).toBeInTheDocument();
  });

  it('conditional group and tab appear when the controlling value changes', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('[data-field="url"]')).toBeNull();
    fireEvent.click(screen.getByText('set-kind-link'));
    expect(container.querySelector('[data-field="url"]')).not.toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Content', 'Extra', 'SEO']);
  });

  it('typing into a field re-evaluates conditions live', () => {
    const { container } = render(<Harness />);
    const kind = container.querySelector('[data-field="kind"] input') as HTMLInputElement;
    fireEvent.change(kind, { target: { value: 'link' } });
    expect(container.querySelector('[data-field="url"]')).not.toBeNull();
    fireEvent.change(kind, { target: { value: 'text' } });
    expect(container.querySelector('[data-field="url"]')).toBeNull();
  });

  it('roving tabindex: arrows wrap, Home/End jump, focus follows selection', () => {
    render(<Harness initial={{ kind: 'x' }} />);
    const tablist = screen.getByRole('tablist');
    const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
    tab('Content').focus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(tab('Extra')).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(tab('Extra'));
    expect(tab('Content')).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(tab('SEO')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(tab('Content')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(tab('SEO')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(tab('Content')).toHaveAttribute('aria-selected', 'true');
  });

  it('a selected tab hidden by its condition falls back to the first tab', () => {
    const { container } = render(<Harness initial={{ kind: 'x' }} />);
    fireEvent.click(screen.getByRole('tab', { name: /^SEO/ }));
    expect(container.querySelector('[data-field="seo_title"]')).not.toBeNull();
    const kind = container.querySelector('[data-field="kind"]');
    expect(kind).toBeNull(); // kind lives on the Content tab
    // Clear kind via a fresh render path: switch back and empty it.
    fireEvent.click(screen.getByRole('tab', { name: /^Content/ }));
    fireEvent.change(container.querySelector('[data-field="kind"] input') as HTMLInputElement, { target: { value: '' } });
    expect(screen.queryByRole('tab', { name: /^SEO/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /^Content/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('collapsible group exposes aria-expanded and toggles its region', () => {
    render(<Harness initial={{ kind: 'link' }} />);
    const toggle = screen.getByRole('button', { name: /Link/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const region = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(region).not.toHaveAttribute('hidden');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(region).toHaveAttribute('hidden');
  });

  it('shows an error badge on tabs containing invalid fields and inline messages', () => {
    render(<Harness initial={{ kind: 'link' }} errors={{ url: 'This field is required.', summary: 'Too long' }} />);
    const content = screen.getByRole('tab', { name: /^Content/ });
    const extra = screen.getByRole('tab', { name: /^Extra/ });
    expect(within(content).getByTestId('tab-error-badge')).toHaveAttribute('aria-label', '1 error');
    expect(within(extra).getByTestId('tab-error-badge')).toHaveTextContent('1');
    expect(within(screen.getByRole('tab', { name: /^SEO/ })).queryByTestId('tab-error-badge')).toBeNull();
    expect(screen.getByText('This field is required.')).toBeInTheDocument();
    const cell = document.querySelector('[data-field="url"]')!;
    expect(cell).toHaveAttribute('aria-invalid', 'true');
  });

  it('errors on a hidden field do not badge its tab', () => {
    render(<Harness initial={{ kind: 'text' }} errors={{ url: 'stale' }} />);
    expect(screen.queryByTestId('tab-error-badge')).toBeNull();
  });

  it('property: exactly the fields resolveFormVisibility shows (on the active tab) are rendered', () => {
    const kinds = fc.constantFrom(undefined, '', 'link', 'text');
    fc.assert(
      fc.property(kinds, (kind) => {
        const initial = kind === undefined ? {} : { kind };
        const { container } = render(<Harness initial={initial} />);
        const v = resolveFormVisibility(LAYOUT, initial);
        const onContent = ['title', 'kind', 'url'].filter((k) => !v.fields.get(k)?.hidden);
        expect(renderedFields(container)).toEqual(['loose', ...onContent]);
        cleanup();
      }),
      { numRuns: 20 },
    );
  });
});

describe('form-layout-state helpers', () => {
  it('checkRequired honours skipRequiredWhenHidden like the server', () => {
    const fields = [{ name: 'kind', required: false }, { name: 'url', required: true }];
    const layout = (skip: boolean): FormLayout => ({
      version: 1,
      nodes: [{ type: 'field', field: 'url', visibleWhen: { field: 'kind', op: 'eq', value: 'link' }, skipRequiredWhenHidden: skip }],
    });
    expect(checkRequired(fields, { kind: 'text' }, layout(false))).toEqual({ url: 'This field is required.' });
    expect(checkRequired(fields, { kind: 'text' }, layout(true))).toEqual({});
    expect(checkRequired(fields, { kind: 'link' }, layout(true))).toEqual({ url: 'This field is required.' });
    // PATCH semantics: only present keys are checked.
    expect(checkRequired(fields, { kind: 'link' }, layout(true), true)).toEqual({});
  });

  it('validationErrorsFrom maps a CMS VALIDATION message to known fields', () => {
    const err = { body: { errors: [{ code: 'VALIDATION', message: 'url: Required; meta.x: bad; ghost: nope' }] } };
    expect(validationErrorsFrom(err, ['url', 'meta'])).toEqual({ url: 'Required', meta: 'bad' });
    expect(validationErrorsFrom({ body: { errors: [{ code: 'FORBIDDEN', message: 'url: x' }] } }, ['url'])).toEqual({});
  });
});
