import { describe, expect, it } from 'vitest';
import { getEarliestUnsatisfiedStep } from '../setup-store';

/**
 * Unit tests for the pure deep-link guard helper used by the wizard's
 * router pre-loads (tasks 3.9, 6.6, 10.3). The helper mirrors the state
 * machine in design.md §5.4 / §11.2: pick the earliest step the
 * operator has yet to satisfy.
 *
 * Spec refs: requirements §3.11; design.md §5.4, §11.2.
 */

describe('getEarliestUnsatisfiedStep', () => {
  it('redirects to /setup/account when account is not yet valid', () => {
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: false,
        pathValid: false,
        policyValid: false,
        projectValid: false,
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
        policyValid: true,
        projectValid: true,
        completed: false,
      }),
    ).toBe('/setup/account');
  });

  it('redirects to /setup/path once account is valid but path is not', () => {
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: true,
        pathValid: false,
        policyValid: false,
        projectValid: false,
        completed: false,
      }),
    ).toBe('/setup/path');
  });

  it('redirects to /setup/security once path is valid but policy is not', () => {
    // Deep-link guard for task 6.6: a visit to a later step (e.g.
    // `/setup/recovery` once that route lands, or `/setup/done`
    // today) while the policy still hasn't validated must bounce to
    // `/setup/security`.
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: true,
        pathValid: true,
        policyValid: false,
        projectValid: false,
        completed: false,
      }),
    ).toBe('/setup/security');
  });

  it('redirects to /setup/project when policy is valid but project is not', () => {
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: true,
        pathValid: true,
        policyValid: true,
        projectValid: false,
        completed: false,
      }),
    ).toBe('/setup/project');
  });

  it('redirects to /setup/project when project is valid but setup is not completed', () => {
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: true,
        pathValid: true,
        policyValid: true,
        projectValid: true,
        completed: false,
      }),
    ).toBe('/setup/project');
  });

  it('redirects to /setup/recovery when setup completed but codes are not confirmed', () => {
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: true,
        pathValid: true,
        policyValid: true,
        projectValid: true,
        completed: true,
        confirmed: false,
      }),
    ).toBe('/setup/recovery');
  });

  it('redirects to /setup/done when the wizard is fully completed', () => {
    expect(
      getEarliestUnsatisfiedStep({
        accountValid: true,
        pathValid: true,
        policyValid: true,
        projectValid: true,
        completed: true,
        confirmed: true,
      }),
    ).toBe('/setup/done');
  });
});
