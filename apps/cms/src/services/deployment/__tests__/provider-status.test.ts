import { describe, it, expect } from 'vitest';
import { mapVercelStatus } from '../providers/vercel';
import { mapNetlifyStatus } from '../providers/netlify';
import { TERMINAL_STATUSES } from '../providers/provider';

describe('Vercel status mapping', () => {
  it.each([
    ['QUEUED', 'queued'],
    ['INITIALIZING', 'queued'],
    ['BUILDING', 'building'],
    ['READY', 'ready'],
    ['ERROR', 'error'],
    ['CANCELED', 'canceled'],
  ])('maps %s → %s', (raw, expected) => {
    expect(mapVercelStatus(raw)).toBe(expected);
  });

  it('defaults unknown states to queued (not terminal)', () => {
    expect(mapVercelStatus('WAT')).toBe('queued');
    expect(mapVercelStatus(undefined)).toBe('queued');
  });
});

describe('Netlify status mapping', () => {
  it.each([
    ['new', 'queued'],
    ['enqueued', 'queued'],
    ['building', 'building'],
    ['uploading', 'building'],
    ['ready', 'ready'],
    ['current', 'ready'],
    ['error', 'error'],
    ['failed', 'error'],
    ['canceled', 'canceled'],
  ])('maps %s → %s', (raw, expected) => {
    expect(mapNetlifyStatus(raw)).toBe(expected);
  });

  it('defaults unknown states to queued', () => {
    expect(mapNetlifyStatus('mystery')).toBe('queued');
  });
});

describe('terminal status set', () => {
  it('contains exactly the finished states', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['canceled', 'error', 'ready']);
    expect(TERMINAL_STATUSES.has('building')).toBe(false);
    expect(TERMINAL_STATUSES.has('queued')).toBe(false);
  });
});
