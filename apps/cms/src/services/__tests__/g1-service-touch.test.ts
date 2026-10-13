import { describe, expect, it, vi } from 'vitest';
import { AISecureHarness } from '../ai-harness';

/**
 * G1 (#453) — retry safety must cover EVERY side-effect surface, not just the
 * services handed to the constructor.
 *
 * A failed approval returns to `pending` only when the harness can prove the
 * skill never reached anything. That proof comes from a touch flag, so any
 * write path the flag misses is a path where a real side effect gets
 * misclassified as "safe to retry".
 *
 * The constructor proxies the six injected services, but `buildCoreSkills`
 * also builds services of its own — deployments, cdc-feed, content-versions —
 * and `runFlow` writes through the raw `db` handle. Those bypassed the proxy
 * entirely: a deployment could fire at an external provider, fail afterwards,
 * and the approval would be re-offered as if nothing had happened.
 *
 * These tests exercise the tracker through the real skill registry rather than
 * asserting on the tracker directly, so a new skill wired to an untracked
 * service shows up here.
 */

/** Reads the private tracker; the flag has no public surface by design. */
function wasTouched(harness: AISecureHarness): boolean {
  return (harness as unknown as { serviceTouch: { wasTouched: boolean } }).serviceTouch.wasTouched;
}

function resetTouch(harness: AISecureHarness): void {
  (harness as unknown as { serviceTouch: { reset(): void } }).serviceTouch.reset();
}

describe('G1 — every side-effect surface marks the execution as touched', () => {
  it('marks an injected service call', async () => {
    const deleteCollection = vi.fn().mockResolvedValue({ ok: true });
    const harness = new AISecureHarness({
      db: {} as never,
      siteId: 'site_1',
      schemaService: { deleteCollection } as never,
    });

    expect(wasTouched(harness)).toBe(false);
    await harness.runSkill('deleteCollection', { name: 'posts' });
    expect(wasTouched(harness)).toBe(true);
  });

  it('marks a deployment, which is built inside the skill factory', async () => {
    const trigger = vi.fn().mockResolvedValue({ id: 'dep_1', status: 'queued', provider: 'vercel' });
    vi.doMock('../deployment/deployment-service', () => ({
      DeploymentService: class {
        trigger = trigger;
      },
    }));

    const harness = new AISecureHarness({
      db: {} as never,
      siteId: 'site_1',
      keys: {} as never,
    });

    resetTouch(harness);
    const result = await harness.runSkill('triggerDeployment', { targetId: 'target_1' });

    expect(result.success).toBe(true);
    expect(trigger).toHaveBeenCalledTimes(1);
    // The failure this guards: an external deploy fires, the skill then errors,
    // and an untracked flag sends the approval back to pending for a re-run.
    expect(wasTouched(harness)).toBe(true);
    vi.doUnmock('../deployment/deployment-service');
  });

  it('leaves the flag false when the skill fails before reaching a service', async () => {
    // No SchemaService: the handler throws SCHEMA_SERVICE_NOT_CONFIGURED before
    // anything is called, so this failure really is safe to retry.
    const harness = new AISecureHarness({
      db: {} as never,
      siteId: 'site_1',
      keys: {} as never,
    });

    const result = await harness.runSkill('deleteCollection', { name: 'posts' });

    expect(result.success).toBe(false);
    expect(wasTouched(harness)).toBe(false);
  });

  it('marks a read-only call too — an ambiguous failure is treated as unsafe', async () => {
    const listCollections = vi.fn().mockResolvedValue([]);
    const harness = new AISecureHarness({
      db: {} as never,
      siteId: 'site_1',
      schemaService: { listCollections } as never,
    });

    await harness.runSkill('listCollections', {});

    // Deliberately over-reports: proving a handler only read is harder than
    // erring toward "a human should look".
    expect(wasTouched(harness)).toBe(true);
  });

  it('resets between executions so a stale flag cannot misclassify the next failure', async () => {
    const deleteCollection = vi.fn().mockResolvedValue({ ok: true });
    const harness = new AISecureHarness({
      db: {} as never,
      siteId: 'site_1',
      schemaService: { deleteCollection } as never,
    });

    await harness.runSkill('deleteCollection', { name: 'posts' });
    expect(wasTouched(harness)).toBe(true);

    resetTouch(harness);
    expect(wasTouched(harness)).toBe(false);
  });
});
