import { describe, expect, it } from 'vitest';
import { CORE_SKILLS, NEVER_AUTONOMOUS_SKILLS } from '../ai-harness';
import { AUTONOMY_LEVELS, resolveAutonomy } from '../autonomy-service';

/**
 * #991 — skills that extend the system's own privileges or code never run
 * without a human, at any autonomy level. The behaviour is proven end to end
 * in `ai-harness-item-impact.db.integration.test.ts`; these cases keep the list
 * honest: a misspelt name would silently protect nothing.
 */
describe('NEVER_AUTONOMOUS_SKILLS', () => {
  it.each([...NEVER_AUTONOMOUS_SKILLS])('%s is a real core skill', (name) => {
    expect(Object.hasOwn(CORE_SKILLS, name), name).toBe(true);
  });

  it('covers extensions, API keys, webhooks, flows, settings, roles, policies and accounts', () => {
    for (const name of ['installExtension', 'updateExtension', 'createApiKey', 'rotateApiKey', 'createWebhook', 'updateWebhook', 'createFlow', 'upsertSetting', 'createRole', 'createPolicy', 'inviteUser']) {
      expect(NEVER_AUTONOMOUS_SKILLS.has(name), name).toBe(true);
    }
  });

  it('the shared ceiling holds an L4 grant at approval (L2) for them', () => {
    // The harness passes `irreversible: true` for these skills.
    expect(resolveAutonomy({ grantLevel: AUTONOMY_LEVELS.AUTOPILOT, dangerous: true, irreversible: true })).toBeLessThanOrEqual(2);
  });
});
