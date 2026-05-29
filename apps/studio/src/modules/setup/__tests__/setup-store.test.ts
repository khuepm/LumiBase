import { describe, expect, it } from 'vitest';
import { getEarliestUnsatisfiedStep } from '../setup-store';

/**
 * Unit tests for the pure deep-link guard helper used by the wizard's
 * router pre-loads (task 3.9). The helper mirrors the state machine in
 * design.md §5.4 / §11.2: pick the earliest step the operator has yet
 * to satisfy.
 *
 * Spec refs: requirements §3.11; design.md §5.4, §11.2.
 */

describe('getEarliestUnsatisfiedStep', () => {
  it('redirects to /setup/account when account is not yet valid', () => {
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: false,
        pathValid: false,
        completed: false,
      }),
    ).toBe('/setup/account');
  });

  it('still redirects to /setup/account when later flags are set but account is not', () => {
    // Defensive: a stale store from a half-finished previous run could
    // technically have `pathValid=true` while `accountValid=false`. The
    // guard's job is to keep the redirect chain monotonic, so the
    // earliest unsatisfied step always wins.
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: false,
        pathValid: true,
        completed: false,
      }),
    ).toBe('/setup/account');
  });

  it('redirects to /setup/path once account is valid but path is not', () => {
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: true,
        pathValid: false,
        completed: false,
      }),
    ).toBe('/setup/path');
  });

  it('redirects to /setup/done when both prior steps are satisfied', () => {
    // The Done route's own beforeLoad re-checks `completed` and bounces
    // back if it's false; this helper just picks the terminal target.
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: true,
        pathValid: true,
        completed: false,
      }),
    ).toBe('/setup/done');
  });

  it('redirects to /setup/done when the wizard is fully completed', () => {
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: true,
        pathValid: true,
        completed: true,
      }),
    ).toBe('/setup/done');
  });
});
