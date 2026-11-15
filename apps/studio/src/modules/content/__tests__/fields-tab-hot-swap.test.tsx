// @vitest-environment jsdom
/**
 * Extension hot reload (#754) in the item editor: a form that rendered before
 * the dev hub's first build arrived must pick the extension up when it lands,
 * without waiting for an unrelated re-render.
 */
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FieldResource } from '@lumibase/sdk';
import type { PermissionHelpers } from '@/lib/use-permissions';
import { hotSwapExtension } from '@/lib/extension-loader';
import { FieldsTab } from '../item-detail';

const perms = {
  bundle: undefined,
  isLoading: false,
  isAdmin: true,
  can: () => true,
  get: () => null,
  fieldAllowed: () => true,
} as unknown as PermissionHelpers;

const fields = [
  { id: 'f_title', collectionId: 'c1', name: 'title', type: 'string', interface: 'late-badge', required: false, hidden: false },
] as unknown as FieldResource[];

describe('FieldsTab + hot-swapped extension interfaces', () => {
  it('re-renders when the extension arrives after the form was drawn', async () => {
    render(<FieldsTab fields={fields} value={{ title: 'hello' }} onChange={() => undefined} collection="posts" perms={perms} pinnedFields={[]} />);
    // Before the build: the by-type default editor.
    expect(screen.queryByTestId('late-badge')).toBeNull();

    act(() => {
      hotSwapExtension({
        name: 'late-badge',
        slot: 'interface',
        session: 'sessaaaa',
        version: 1,
        component: ({ value }: { value: unknown }) => <span data-testid="late-badge">badge:{String(value)}</span>,
      });
    });
    expect(await screen.findByTestId('late-badge')).toHaveTextContent('badge:hello');
  });
});
