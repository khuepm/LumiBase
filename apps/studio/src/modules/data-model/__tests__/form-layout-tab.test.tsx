// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import fc from 'fast-check';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { placedFields, validateFormLayout, type FormLayout } from '@lumibase/contracts/form-layout';

const listFields = vi.fn();
const getFormLayout = vi.fn();
const setFormLayout = vi.fn();

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ schema: { listFields, getFormLayout, setFormLayout } }),
}));

import { FormLayoutTab } from '../form-layout-tab';
import {
  addNode,
  emptyLayout,
  fromSimple,
  moveInto,
  parseRuleValue,
  placeField,
  pruneUnknownFields,
  removeNode,
  shiftNode,
  toSimple,
} from '../form-layout-model';

/** Collection settings → Form layout builder (#750). */

const FIELDS = ['title', 'kind', 'url'].map((name, i) => ({
  id: `f_${name}`,
  collectionId: 'c',
  name,
  type: 'string',
  interface: 'input',
  required: false,
  hidden: false,
  sortOrder: i,
}));

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Minimal DataTransfer for HTML5 drag-and-drop in jsdom. */
function dataTransfer() {
  const store = new Map<string, string>();
  return {
    setData: (k: string, v: string) => store.set(k, v),
    getData: (k: string) => store.get(k) ?? '',
    effectAllowed: 'move',
    dropEffect: 'move',
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FormLayoutTab', () => {
  it('builds a tab, drags a field in, places another with the picker, adds a condition and saves', async () => {
    listFields.mockResolvedValue({ data: FIELDS });
    getFormLayout.mockResolvedValue({ data: { layout: null } });
    setFormLayout.mockImplementation(async (_n: string, layout: unknown) => ({ data: { layout } }));
    renderWithClient(<FormLayoutTab collectionName="posts" />);

    await screen.findByRole('button', { name: /Add tab/ });
    fireEvent.click(screen.getByRole('button', { name: /Add tab/ }));

    // Drag `title` onto the new tab's drop zone.
    const dt = dataTransfer();
    fireEvent.dragStart(screen.getByTestId('unplaced-title'), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId('layout-drop-tab-1'), { dataTransfer: dt });
    expect(screen.queryByTestId('unplaced-title')).toBeNull();

    // Keyboard path: place `url` via the picker.
    fireEvent.change(screen.getByLabelText('Place url in'), { target: { value: 'tab-1' } });

    // Condition on url: show when kind equals "link".
    fireEvent.click(screen.getByRole('button', { name: 'Settings for url' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    fireEvent.change(screen.getByLabelText('Rule 1 field'), { target: { value: 'kind' } });
    fireEvent.change(screen.getByLabelText('Rule 1 operator'), { target: { value: 'eq' } });
    fireEvent.change(screen.getByLabelText('Rule 1 value'), { target: { value: 'link' } });
    fireEvent.click(screen.getByLabelText('Skip required when hidden'));

    fireEvent.click(screen.getByRole('button', { name: /Save layout/ }));
    await waitFor(() => expect(setFormLayout).toHaveBeenCalled());
    const [name, saved] = setFormLayout.mock.calls[0]!;
    expect(name).toBe('posts');
    expect(saved).toEqual({
      version: 1,
      nodes: [
        {
          type: 'tab',
          id: 'tab-1',
          label: 'Tab 1',
          children: [
            { type: 'field', field: 'title' },
            {
              type: 'field',
              field: 'url',
              visibleWhen: { field: 'kind', op: 'eq', value: 'link' },
              skipRequiredWhenHidden: true,
            },
          ],
        },
      ],
    });
    expect(validateFormLayout(saved, ['title', 'kind', 'url']).ok).toBe(true);
    expect(await screen.findByRole('status')).toHaveTextContent('Layout saved.');
  });

  it('a field cannot condition on itself (not offered in its own rule picker)', async () => {
    listFields.mockResolvedValue({ data: FIELDS });
    getFormLayout.mockResolvedValue({ data: { layout: { version: 1, nodes: [{ type: 'field', field: 'url' }] } } });
    renderWithClient(<FormLayoutTab collectionName="posts" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settings for url' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }));
    const options = within(screen.getByLabelText('Rule 1 field')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['title', 'kind']);
  });

  it('drops placements of deleted fields on load and shows server errors', async () => {
    listFields.mockResolvedValue({ data: FIELDS });
    getFormLayout.mockResolvedValue({
      data: { layout: { version: 1, nodes: [{ type: 'field', field: 'ghost' }, { type: 'field', field: 'title' }] } },
    });
    setFormLayout.mockRejectedValue({ body: { errors: [{ code: 'INVALID_FORM_LAYOUT', message: 'nodes.0: nope' }] } });
    renderWithClient(<FormLayoutTab collectionName="posts" />);
    await screen.findByTestId('layout-node-field:title');
    expect(screen.queryByTestId('layout-node-field:ghost')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Save layout/ }));
    expect(await screen.findByText('nodes.0: nope')).toBeInTheDocument();
  });

  it('Remove layout saves null', async () => {
    listFields.mockResolvedValue({ data: FIELDS });
    getFormLayout.mockResolvedValue({ data: { layout: { version: 1, nodes: [{ type: 'field', field: 'title' }] } } });
    setFormLayout.mockResolvedValue({ data: { layout: null } });
    renderWithClient(<FormLayoutTab collectionName="posts" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove layout' }));
    await waitFor(() => expect(setFormLayout).toHaveBeenCalledWith('posts', null));
  });
});

describe('form-layout-model', () => {
  it('placeField moves an existing placement instead of duplicating it', () => {
    let l = addNode(addNode(emptyLayout(), 'tab', null), 'group', null);
    l = placeField(l, 'title', 'tab-1');
    l = placeField(l, 'title', 'group-1');
    expect(placedFields(l)).toEqual(['title']);
    expect(l.nodes[1]).toMatchObject({ id: 'group-1', children: [{ field: 'title' }] });
  });

  it('moveInto refuses to move a container into its own subtree', () => {
    let l = addNode(emptyLayout(), 'group', null);
    l = addNode(l, 'group', 'group-1');
    expect(moveInto(l, 'node:group-1', 'group-2')).toBe(l);
    expect(moveInto(l, 'node:group-1', 'group-1')).toBe(l);
  });

  it('shiftNode reorders siblings; removeNode drops a subtree', () => {
    let l = placeField(placeField(emptyLayout(), 'a', null), 'b', null);
    l = shiftNode(l, 'field:b', -1);
    expect(placedFields(l)).toEqual(['b', 'a']);
    expect(placedFields(removeNode(l, 'field:b'))).toEqual(['a']);
  });

  it('pruneUnknownFields keeps known placements only', () => {
    const l: FormLayout = { version: 1, nodes: [{ type: 'group', id: 'g', children: [{ type: 'field', field: 'x' }, { type: 'field', field: 'y' }] }] };
    expect(placedFields(pruneUnknownFields(l, ['y']))).toEqual(['y']);
  });

  it('simple condition round-trip and typed value parsing', () => {
    expect(toSimple(undefined)).toEqual({ match: 'all', rules: [] });
    const any = { or: [{ field: 'a', op: 'eq' as const, value: 1 }, { field: 'b', op: 'empty' as const }] };
    expect(fromSimple(toSimple(any)!)).toEqual(any);
    expect(toSimple({ not: { field: 'a', op: 'empty' } })).toBeNull();
    expect(parseRuleValue('in', 'a, b ,', 'string')).toEqual(['a', 'b']);
    expect(parseRuleValue('gt', '5', 'integer')).toBe(5);
    expect(parseRuleValue('eq', 'true', 'boolean')).toBe(true);
    expect(parseRuleValue('empty', 'x', 'string')).toBeUndefined();
  });

  it('property: any sequence of builder operations yields a valid layout with no duplicate field', () => {
    const FIELD_KEYS = ['a', 'b', 'c', 'd'];
    const op = fc.oneof(
      fc.record({ kind: fc.constant('add' as const), type: fc.constantFrom('tab' as const, 'group' as const, 'divider' as const), parent: fc.nat(5) }),
      fc.record({ kind: fc.constant('place' as const), field: fc.constantFrom(...FIELD_KEYS), parent: fc.nat(5) }),
      fc.record({ kind: fc.constant('move' as const), from: fc.nat(5), to: fc.nat(5) }),
      fc.record({ kind: fc.constant('shift' as const), field: fc.constantFrom(...FIELD_KEYS), up: fc.boolean() }),
      fc.record({ kind: fc.constant('remove' as const), field: fc.constantFrom(...FIELD_KEYS) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 25 }), (ops) => {
        let l = emptyLayout();
        const ids = () => JSON.stringify(l).match(/"id":"[^"]+"/g)?.map((s) => s.slice(6, -1)).filter((id) => !id.startsWith('divider')) ?? [];
        const pick = (n: number) => {
          const all = ids();
          return n < all.length ? all[n]! : null;
        };
        for (const o of ops) {
          if (o.kind === 'add') {
            const parent = pick(o.parent);
            // Respect the nesting cap the way the UI would by keeping the tree shallow.
            l = addNode(l, o.type, parent && JSON.stringify(l).split('"children"').length < 6 ? parent : null);
          } else if (o.kind === 'place') l = placeField(l, o.field, pick(o.parent));
          else if (o.kind === 'move') {
            const from = pick(o.from);
            if (from) l = moveInto(l, `node:${from}`, pick(o.to));
          } else if (o.kind === 'shift') l = shiftNode(l, `field:${o.field}`, o.up ? -1 : 1);
          else l = removeNode(l, `field:${o.field}`);
        }
        const placed = placedFields(l);
        expect(new Set(placed).size).toBe(placed.length);
        const result = validateFormLayout(l, FIELD_KEYS);
        // Depth is the only rule the builder leaves to the save-time check.
        if (!result.ok) expect(result.issues.every((i) => i.code === 'TOO_DEEP')).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
