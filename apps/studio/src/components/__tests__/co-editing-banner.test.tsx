// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PresenceEntry } from '@/types/realtime';
import { CoEditingBanner } from '../co-editing-banner';

function peer(over: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    sessionId: 's1',
    userId: 'user-1',
    collection: 'posts',
    itemId: 'item-1',
    lastSeen: '2026-06-06T00:00:00.000Z',
    ...over,
  };
}

afterEach(cleanup);

describe('CoEditingBanner', () => {
  it('renders nothing when there are no co-editors', () => {
    const { container } = render(<CoEditingBanner coEditors={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names a single co-editor using their meta name', () => {
    render(<CoEditingBanner coEditors={[peer({ meta: { name: 'Alice' } })]} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Alice is also working on this item right now.',
    );
  });

  it('falls back to userId when no meta name is present', () => {
    render(<CoEditingBanner coEditors={[peer({ userId: 'khue' })]} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'khue is also working on this item right now.',
    );
  });

  it('summarises a count and joins names for multiple co-editors', () => {
    render(
      <CoEditingBanner
        coEditors={[
          peer({ sessionId: 's1', userId: 'u1', meta: { name: 'Alice' } }),
          peer({ sessionId: 's2', userId: 'u2', meta: { email: 'bob@example.com' } }),
          peer({ sessionId: 's3', userId: 'u3', meta: { name: 'Carol' } }),
        ]}
      />,
    );
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('3 other people are working on this item right now.');
    expect(banner).toHaveTextContent('Alice, bob@example.com and Carol are here too.');
  });

  it('is announced politely to assistive tech', () => {
    render(<CoEditingBanner coEditors={[peer({ meta: { name: 'Alice' } })]} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });
});
