// @vitest-environment jsdom
/**
 * Field focus + locale selection for intent links (issue #759).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined }));
import type { FieldResource } from '@lumibase/sdk';
import type { PermissionHelpers } from '@/lib/use-permissions';
import { FieldsTab } from '../item-detail';
import {
  FieldRevealContext,
  fieldContainerChain,
  planIntentLocale,
  useIntentFieldFocus,
} from '../field-focus';
import { readEditorIntentSearch } from '../editor-intent-search';

function field(name: string, extra: Partial<FieldResource> = {}): FieldResource {
  return {
    id: `f_${name}`,
    collectionId: 'c1',
    name,
    type: 'string',
    interface: 'input',
    required: false,
    hidden: false,
    ...extra,
  } as FieldResource;
}

const perms = {
  bundle: undefined,
  isLoading: false,
  isAdmin: true,
  can: () => true,
  get: () => null,
  fieldAllowed: () => true,
} as unknown as PermissionHelpers;

const fields: FieldResource[] = [
  field('title', { sortOrder: 1 } as Partial<FieldResource>),
  field('seo', { interface: 'group-accordion', type: 'alias', meta: { options: { start: 'closed' } }, sortOrder: 2 } as Partial<FieldResource>),
  field('meta_title', { group: 'seo', sortOrder: 1 } as Partial<FieldResource>),
];

function Harness({ target }: { target?: string }) {
  const [value, setValue] = useState<Record<string, unknown>>({ title: 'Hello', meta_title: 'Meta' });
  const focus = useIntentFieldFocus({ field: target, fields, ready: true, intervalMs: 5 });
  return (
    <>
      <span data-testid="status">{focus.status}</span>
      <FieldRevealContext.Provider value={focus.reveal}>
        <FieldsTab fields={fields} value={value} onChange={setValue} collection="posts" perms={perms} pinnedFields={[]} />
      </FieldRevealContext.Provider>
    </>
  );
}

describe('field focus in the editor', () => {
  it('focuses a top-level field', async () => {
    render(<Harness target="title" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('focused'));
    const anchor = document.querySelector('[data-field-anchor="title"]');
    expect(anchor?.contains(document.activeElement)).toBe(true);
  });

  it('opens a collapsed accordion group to reach a nested field', async () => {
    render(<Harness target="meta_title" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('focused'));
    const anchor = document.querySelector('[data-field-anchor="meta_title"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.contains(document.activeElement)).toBe(true);
  });

  it('keeps a closed group closed without a target', () => {
    render(<Harness />);
    expect(document.querySelector('[data-field-anchor="meta_title"]')).toBeNull();
    expect(screen.getByTestId('status')).toHaveTextContent('idle');
  });

  it('reports an unknown / hidden field as missing instead of failing silently', async () => {
    render(<Harness target="not_a_field" />);
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('missing'));
  });
});

describe('fieldContainerChain', () => {
  it('returns outermost-first containers and supports layout parents', () => {
    const fs = [
      { name: 'a', group: null },
      { name: 'g1', group: null },
      { name: 'g2', group: 'g1' },
      { name: 'leaf', group: 'g2' },
    ];
    expect(fieldContainerChain(fs, 'leaf')).toEqual(['g1', 'g2']);
    expect(fieldContainerChain(fs, 'a')).toEqual([]);
    expect(fieldContainerChain(fs, 'nope')).toBeNull();
    expect(fieldContainerChain(fs, 'a', (n) => (n === 'a' ? 'tab:main' : null))).toEqual(['tab:main']);
    // cycle-safe
    expect(fieldContainerChain([{ name: 'x', group: 'y' }, { name: 'y', group: 'x' }], 'x')).toEqual(['y']);
  });
});

describe('planIntentLocale', () => {
  const locales = ['en', 'vi', 'pt-BR'];
  it.each([
    [undefined, ['title'], undefined, null],
    ['en', ['title'], undefined, { tab: 'fields' }],
    ['vi', ['title'], 'title', { tab: 'translation', targetLocale: 'vi' }],
    ['pt-br', ['title'], undefined, { tab: 'translation', targetLocale: 'pt-BR' }],
    ['pt_BR', ['title'], undefined, { tab: 'translation', targetLocale: 'pt-BR' }],
    ['fr', ['title'], undefined, { tab: 'fields', notice: 'locale_unavailable' }],
    ['vi', [], undefined, { tab: 'fields', notice: 'no_translatable_fields' }],
    ['vi', ['title'], 'slug', { tab: 'fields', notice: 'field_not_translatable' }],
  ])('%s (translatable %j, field %s)', (requested, translatable, f, expected) => {
    expect(planIntentLocale({ requested, locales, translatable, field: f })).toEqual(expected);
  });
});

describe('readEditorIntentSearch', () => {
  it('keeps valid hints and coerces JSON-parsed scalars', () => {
    expect(readEditorIntentSearch({ locale: 'vi', field: 'title' })).toEqual({ locale: 'vi', field: 'title' });
    expect(readEditorIntentSearch({ field: true })).toEqual({ field: 'true' });
    expect(readEditorIntentSearch({ locale: '<x>', field: 'a.b', other: 1 })).toEqual({});
    expect(readEditorIntentSearch(null)).toEqual({});
  });
});
