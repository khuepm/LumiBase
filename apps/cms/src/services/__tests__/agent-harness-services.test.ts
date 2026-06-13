import { describe, expect, it } from 'vitest';
import { AgentArtifactService, stableHash, stableStringify } from '../agent-artifact-service';
import { maskSecrets } from '../agent-run-service';

describe('agent harness service invariants', () => {
  it('masks nested secret-like keys before audit persistence', () => {
    expect(maskSecrets({
      prompt: 'build app',
      nested: {
        apiKey: 'sk-secret',
        token: 'abc',
        safe: 'visible',
      },
    })).toEqual({
      prompt: 'build app',
      nested: {
        apiKey: '[masked]',
        token: '[masked]',
        safe: 'visible',
      },
    });
  });

  it('hashes semantically identical artifact content deterministically', () => {
    const left = { b: 2, a: { c: 3, d: [1, 2] } };
    const right = { a: { d: [1, 2], c: 3 }, b: 2 };
    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(stableHash(left)).toBe(stableHash(right));
  });

  it('rejects oversized artifact content before writing to the database', async () => {
    const service = new AgentArtifactService({} as never, 'site_1');
    await expect(service.createArtifact({
      runId: 'run_1',
      type: 'page_spec',
      title: 'Too large',
      content: { body: 'x'.repeat(600 * 1024) },
    })).rejects.toThrow(/exceeds/);
  });
});
