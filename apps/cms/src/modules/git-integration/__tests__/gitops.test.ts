import { describe, it, expect } from 'vitest';
import { parseIntentConfig } from '../gitops';

const validIntent = {
  name: 'fresh-posts',
  collection: 'posts',
  rules: [{ type: 'freshness', maxAgeDays: 30 }],
  schedule: '0 0 * * *',
};

describe('parseIntentConfig', () => {
  it('accepts a single valid intent object', () => {
    const res = parseIntentConfig(JSON.stringify(validIntent));
    expect(res.errors).toHaveLength(0);
    expect(res.intents).toHaveLength(1);
    expect(res.intents[0]!.name).toBe('fresh-posts');
  });

  it('accepts an array of intents', () => {
    const res = parseIntentConfig(
      JSON.stringify([validIntent, { ...validIntent, name: 'b' }]),
    );
    expect(res.errors).toHaveLength(0);
    expect(res.intents).toHaveLength(2);
  });

  it('reports invalid JSON', () => {
    const res = parseIntentConfig('{ not json');
    expect(res.intents).toHaveLength(0);
    expect(res.errors[0]).toContain('not valid JSON');
  });

  it('collects validation errors for malformed intents but keeps valid ones', () => {
    const res = parseIntentConfig(
      JSON.stringify([validIntent, { name: 'x' /* missing rules/collection */ }]),
    );
    expect(res.intents).toHaveLength(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toContain('intent[1]');
  });
});
