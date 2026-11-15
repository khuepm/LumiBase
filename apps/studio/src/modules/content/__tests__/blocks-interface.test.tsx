// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { FieldResource } from '@lumibase/sdk';

vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined, useExtensionUpdates: () => 0 }));

const listFields = vi.fn();
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ schema: { listFields } }),
  getActiveToken: () => 'tok',
  getActiveSite: () => 'site_1',
}));

// Registry first, as in the app (item forms import it): blocks ↔ registry is a
// deliberate cycle, same as the repeater interface.
import { resolveInterface } from '../interfaces/registry';
import { BlocksInterface, normalizeBlocks, readBlocksOptions, type BlockValue } from '../interfaces/blocks';

const f = (name: string, type: string, extra: Partial<FieldResource> = {}): FieldResource =>
  ({ id: name, collectionId: 'c', name, type, interface: type === 'blocks' ? 'blocks' : 'input', required: false, hidden: false, sortOrder: 0, ...extra }) as FieldResource;

const TEMPLATES: Record<string, FieldResource[]> = {
  hero: [f('title', 'string', { required: true }), f('secret', 'string', { hidden: true })],
  cta: [f('label', 'string')],
  columns: [f('items', 'blocks', { options: { allowedBlocks: ['cta'] } })],
};

const zone = f('sections', 'blocks', { options: { allowedBlocks: ['hero', 'cta', 'columns'], max: 3 } });

function Harness({ initial, onValue, field = zone }: { initial: unknown; onValue: (v: BlockValue[] | null) => void; field?: FieldResource }) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <BlocksInterface
      field={field}
      value={value as BlockValue[]}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

function renderZone(initial: unknown, field?: FieldResource) {
  const onValue = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness initial={initial} onValue={onValue} field={field} />
    </QueryClientProvider>,
  );
  const last = (): BlockValue[] => onValue.mock.calls.at(-1)?.[0] as BlockValue[];
  return { onValue, last };
}

const hero = (id: string, title = id): BlockValue => ({ id, type: 'hero', data: { title } });
const cta = (id: string, label = id): BlockValue => ({ id, type: 'cta', data: { label } });

beforeEach(() => {
  cleanup();
  listFields.mockReset();
  listFields.mockImplementation(async (name: string) => ({ data: TEMPLATES[name] ?? [] }));
});

describe('blocks helpers', () => {
  it.each([null, undefined, 'x', {}, 42])('normalizeBlocks(%j) → []', (v) => {
    expect(normalizeBlocks(v)).toEqual([]);
  });

  it('normalizeBlocks fills missing ids and data, drops non-objects', () => {
    const out = normalizeBlocks([{ type: 'cta' }, null, 3, { id: 'a', type: 'hero', data: null }]);
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(out[1]).toEqual({ id: 'a', type: 'hero', data: {} });
  });

  it('readBlocksOptions reads field.options and meta.options', () => {
    expect(readBlocksOptions(zone)).toEqual({ allowedBlocks: ['hero', 'cta', 'columns'], min: undefined, max: 3 });
    const legacy = { ...f('z', 'blocks'), meta: { options: { allowedBlocks: ['cta'], min: 1 } } } as FieldResource;
    expect(readBlocksOptions(legacy).allowedBlocks).toEqual(['cta']);
  });

  it('is registered by interface and by storage type', () => {
    expect(resolveInterface(zone)).toBe(BlocksInterface);
    expect(resolveInterface({ ...zone, interface: 'unknown' })).toBe(BlocksInterface);
  });
});

describe('BlocksInterface', () => {
  it.each([null, undefined, []])('renders an empty zone for %j without crashing', (initial) => {
    renderZone(initial);
    expect(screen.getByText('No blocks yet.')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Add block' })).getAllByRole('button')).toHaveLength(3);
  });

  it('adds a block of the picked type with a fresh id and announces it', () => {
    const { last } = renderZone(null);
    fireEvent.click(screen.getByRole('button', { name: 'Add Cta' }));
    expect(last()).toEqual([{ id: expect.stringMatching(/^[A-Za-z0-9_-]{21}$/), type: 'cta', data: {} }]);
    expect(screen.getAllByTestId('blocks-announcer')[0]!.textContent).toBe('Added Cta block at position 1.');
  });

  it('renders the per-block form from the template fields (hidden fields skipped) and edits data', async () => {
    const { last } = renderZone([hero('h1', 'Hello')]);
    const input = await screen.findByDisplayValue('Hello');
    expect(screen.queryByText('secret')).toBeNull();
    fireEvent.change(input, { target: { value: 'Changed' } });
    expect(last()).toEqual([{ id: 'h1', type: 'hero', data: { title: 'Changed' } }]);
    expect(listFields).toHaveBeenCalledWith('hero');
  });

  it('reorders with the move buttons (keyboard-accessible) and announces the new position', () => {
    const { last } = renderZone([hero('a'), cta('b'), cta('c')]);
    fireEvent.click(screen.getByRole('button', { name: 'Move Cta block 3 of 3 up' }));
    expect(last().map((b) => b.id)).toEqual(['a', 'c', 'b']);
    expect(screen.getAllByTestId('blocks-announcer')[0]!.textContent).toBe('Moved Cta block to position 2 of 3.');
    fireEvent.click(screen.getByRole('button', { name: 'Move Hero block 1 of 3 down' }));
    expect(last().map((b) => b.id)).toEqual(['c', 'a', 'b']);
    // Boundaries are disabled.
    expect((screen.getByRole('button', { name: 'Move Cta block 1 of 3 up' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a block and keeps the others in order', () => {
    const { last } = renderZone([hero('a'), cta('b'), cta('c')]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cta block 2 of 3' }));
    expect(last().map((b) => b.id)).toEqual(['a', 'c']);
  });

  it('insert / reorder / remove round-trip preserves ids and data', async () => {
    const { last } = renderZone([hero('a', 'A')]);
    fireEvent.click(screen.getByRole('button', { name: 'Add Cta' }));
    const newId = last()[1]!.id;
    fireEvent.click(screen.getByRole('button', { name: 'Move Cta block 2 of 2 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Cta block 1 of 2' }));
    expect(last()).toEqual([{ id: 'a', type: 'hero', data: { title: 'A' } }]);
    expect(newId).not.toBe('a');
  });

  it('collapses and expands a block via an aria-expanded toggle', async () => {
    renderZone([hero('a', 'A')]);
    await screen.findByDisplayValue('A');
    const toggle = screen.getAllByRole('button', { expanded: true })[0]!;
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByDisplayValue('A')).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByDisplayValue('A')).toBeTruthy();
  });

  it('disables adding once max is reached', () => {
    renderZone([hero('a'), cta('b'), cta('c')]);
    for (const btn of within(screen.getByRole('group', { name: 'Add block' })).getAllByRole('button')) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.getByText(/3 \/ 3 blocks/)).toBeTruthy();
  });

  it('renders nested zones with the same editor', async () => {
    const { last } = renderZone([{ id: 'k', type: 'columns', data: { items: [cta('n1', 'Inner')] } }]);
    expect(await screen.findByDisplayValue('Inner')).toBeTruthy();
    const nested = screen.getAllByRole('group', { name: 'Add block' })[0]!;
    fireEvent.click(within(nested).getByRole('button', { name: 'Add Cta' }));
    const items = (last()[0]!.data.items as BlockValue[]).map((b) => b.type);
    expect(items).toEqual(['cta', 'cta']);
  });

  it('keeps blocks of a type that is no longer allowed and flags them', async () => {
    renderZone([{ id: 'x', type: 'legacy', data: { a: 1 } }]);
    expect(await screen.findByText(/is not allowed in this field/)).toBeTruthy();
  });

  it('reorders with the dnd-kit keyboard sensor (space, arrow down, space)', async () => {
    // jsdom has no layout: give each block row a stacked 40px-high rect so the
    // keyboard sensor's collision detection can find the next slot.
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const li = this.closest('li[data-block-id]');
      const idx = li?.parentElement ? Array.from(li.parentElement.children).indexOf(li) : 0;
      const top = idx * 50;
      return { x: 0, y: top, top, left: 0, width: 300, height: 40, bottom: top + 40, right: 300, toJSON: () => ({}) } as DOMRect;
    });
    try {
      const { last } = renderZone([hero('a'), cta('b')]);
      const handle = screen.getByRole('button', { name: 'Drag to reorder Hero block 1 of 2' });
      expect(handle.getAttribute('aria-roledescription')).toBe('sortable');
      handle.focus();
      for (const key of [' ', 'ArrowDown', ' ']) {
        await act(async () => {
          fireEvent.keyDown(handle, { key, code: key === ' ' ? 'Space' : key });
          await new Promise((r) => setTimeout(r, 0));
        });
      }
      await waitFor(() => expect(last()?.map((b) => b.id)).toEqual(['b', 'a']));
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('shows an explicit message when allowedBlocks is missing', () => {
    renderZone([], f('broken', 'blocks', { options: {} }));
    expect(screen.getByText(/Missing `options.allowedBlocks`/)).toBeTruthy();
  });
});
