// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FieldResource } from '@lumibase/sdk';
import type { PermissionHelpers } from '@/lib/use-permissions';
import type { PresenceEntry } from '@/types/realtime';

vi.mock('@/lib/api', () => ({ getApiClient: () => ({}), hasActiveToken: () => true }));
vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined, useExtensionUpdates: () => 0 }));
vi.mock('@/hooks/use-presence', () => ({ useCoEditors: () => ({ coEditors: [] }) }));
vi.mock('@/hooks/use-realtime', () => ({ useRealtimeSubscription: () => {} }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null, useNavigate: () => vi.fn(), useParams: () => ({}), useSearch: () => ({}) }));

const { FieldsTab } = await import('../item-detail');
const { buildFieldPresenceApi, computeFieldPresence } = await import('../field-presence');
const { mergeDrafts } = await import('../stale-merge');

const entry = (sessionId: string, extra: Partial<PresenceEntry> = {}): PresenceEntry => ({
  sessionId,
  userId: `user-${sessionId}`,
  collection: 'posts',
  itemId: 'p1',
  lastSeen: '',
  ...extra,
});

afterEach(() => cleanup());

describe('computeFieldPresence (#685)', () => {
  it('lists other sessions focused on a field and picks the newest lock', () => {
    const map = computeFieldPresence(
      [
        entry('me', { focus: 'title' }),
        entry('a', { focus: 'title', lock: { field: 'title', since: '2026-11-19T10:00:00Z' } }),
        entry('b', { lock: { field: 'title', since: '2026-11-19T10:00:05Z' } }),
      ],
      'me',
    );
    expect(map.get('title')!.focused.map((e) => e.sessionId)).toEqual(['a']);
    expect(map.get('title')!.holder!.sessionId).toBe('b');
  });

  it('takes the lock on first edit, releases it on blur, and takes over on demand', () => {
    const setFocus = vi.fn();
    const setLock = vi.fn();
    const mine = buildFieldPresenceApi({
      sessions: [entry('me', { lock: { field: 'title', since: 't0' } })],
      selfSessionId: 'me',
      setFocus,
      setLock,
    });
    mine.onEdit('title'); // already mine — no resend
    expect(setLock).not.toHaveBeenCalled();
    mine.onBlur('title');
    expect(setFocus).toHaveBeenCalledWith(null);
    expect(setLock).toHaveBeenCalledWith(null);

    const blocked = buildFieldPresenceApi({
      sessions: [entry('me'), entry('other', { lock: { field: 'body', since: 't0' } })],
      selfSessionId: 'me',
      setFocus,
      setLock,
    });
    setLock.mockClear();
    blocked.onEdit('body'); // someone else holds it
    expect(setLock).not.toHaveBeenCalled();
    expect(blocked.lockedByOther('body')?.sessionId).toBe('other');
    blocked.onTakeOver('body');
    expect(setLock).toHaveBeenCalledWith('body');
  });
});

describe('FieldsTab with field presence', () => {
  const perms = { can: () => true, fieldAllowed: () => true } as unknown as PermissionHelpers;
  const fields: FieldResource[] = [
    { id: 'f1', collectionId: 'c', name: 'title', type: 'string', interface: 'input', required: false, hidden: false, sortOrder: 0 },
    { id: 'f2', collectionId: 'c', name: 'body', type: 'string', interface: 'input', required: false, hidden: false, sortOrder: 1 },
  ];

  function Harness({ sessions, onFocus, onTakeOver }: { sessions: PresenceEntry[]; onFocus: (f: string | null) => void; onTakeOver: (f: string | null) => void }) {
    const [value, setValue] = useState<Record<string, unknown>>({ title: 'a', body: 'b' });
    const api = buildFieldPresenceApi({ sessions, selfSessionId: 'me', setFocus: onFocus, setLock: onTakeOver });
    return (
      <>
        <FieldsTab fields={fields} value={value} onChange={setValue} collection="posts" perms={perms} pinnedFields={[]} presence={api} />
        <output data-testid="value">{JSON.stringify(value)}</output>
      </>
    );
  }

  it('shows who is on a field, blocks a field someone else is editing, and offers Take over', () => {
    const onFocus = vi.fn();
    const onLock = vi.fn();
    render(
      <Harness
        sessions={[
          entry('me'),
          entry('ann', { meta: { name: 'Ann' }, focus: 'title' }),
          entry('bob', { meta: { name: 'Bob' }, focus: 'body', lock: { field: 'body', since: 't0' } }),
        ]}
        onFocus={onFocus}
        onTakeOver={onLock}
      />,
    );
    expect(screen.getAllByTestId('field-focus-badge').map((b) => b.textContent)).toEqual(['Ann', 'Bob']);
    expect(screen.getByText('Bob is editing this field.')).toBeTruthy();

    const title = document.querySelector('[data-field="title"] input') as HTMLInputElement;
    fireEvent.focus(title);
    expect(onFocus).toHaveBeenCalledWith('title');

    // The locked field ignores input until we take over.
    const body = document.querySelector('[data-field="body"] input') as HTMLInputElement;
    fireEvent.change(body, { target: { value: 'typed' } });
    expect(screen.getByTestId('value').textContent).toBe(JSON.stringify({ title: 'a', body: 'b' }));

    fireEvent.click(screen.getByText('Take over'));
    expect(onLock).toHaveBeenCalledWith('body');
  });
});

describe('mergeDrafts (#685)', () => {
  it('keeps my edits, takes theirs where only they changed, and flags conflicts', () => {
    const base = { title: 'A', body: 'B', tags: ['x'], seo: 'S' };
    const mine = { title: 'A-mine', body: 'B', tags: ['x'], seo: 'S-mine' };
    const theirs = { title: 'A', body: 'B-theirs', tags: ['x', 'y'], seo: 'S-theirs' };
    expect(mergeDrafts(base, mine, theirs)).toEqual({
      data: { title: 'A-mine', body: 'B-theirs', tags: ['x', 'y'], seo: 'S-mine' },
      conflicts: ['seo'],
      fromTheirs: ['body', 'tags'],
    });
  });

  it('handles fields added or removed on one side', () => {
    expect(mergeDrafts({ a: 1 }, { a: 1, b: 2 }, { c: 3 })).toEqual({
      data: { b: 2, c: 3 },
      conflicts: [],
      fromTheirs: ['a', 'c'],
    });
  });
});
