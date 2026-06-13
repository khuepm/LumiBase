import { describe, expect, it } from 'vitest';
import { isIpAllowedByGuard, resolvePolicyIpGuards } from '../permission-service';

describe('isIpAllowedByGuard', () => {
  it('allows requests when no IP guard is configured', () => {
    expect(isIpAllowedByGuard(undefined)).toBe(true);
    expect(isIpAllowedByGuard('203.0.113.10')).toBe(true);
  });

  it('matches exact IPv4 and IPv6 entries', () => {
    expect(isIpAllowedByGuard('203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(isIpAllowedByGuard('203.0.113.11', ['203.0.113.10'])).toBe(false);
    expect(isIpAllowedByGuard('2001:db8::1', ['2001:0db8:0:0:0:0:0:1'])).toBe(true);
  });

  it('matches IPv4 and IPv6 CIDR ranges', () => {
    expect(isIpAllowedByGuard('10.15.68.122', ['10.15.68.0/24'])).toBe(true);
    expect(isIpAllowedByGuard('10.15.69.1', ['10.15.68.0/24'])).toBe(false);
    expect(isIpAllowedByGuard('2001:db8:abcd::42', ['2001:db8:abcd::/48'])).toBe(true);
    expect(isIpAllowedByGuard('2001:db8:abce::42', ['2001:db8:abcd::/48'])).toBe(false);
  });

  it('applies deny before allow', () => {
    expect(isIpAllowedByGuard('10.15.68.122', ['10.15.68.0/24'], ['10.15.68.122'])).toBe(false);
    expect(isIpAllowedByGuard('10.15.68.122', ['10.15.68.0/24'], ['10.15.69.0/24'])).toBe(true);
  });

  it('fails closed when allow list exists but request IP is unavailable', () => {
    expect(isIpAllowedByGuard(undefined, ['10.15.68.0/24'])).toBe(false);
  });

  it('falls back to legacy rules guards when migrated top-level lists are empty', () => {
    const allowGuard = resolvePolicyIpGuards([], [], { ipAllow: ['203.0.113.10'] });
    expect(isIpAllowedByGuard('198.51.100.20', allowGuard.ipAllow, allowGuard.ipDeny)).toBe(false);

    const denyGuard = resolvePolicyIpGuards([], [], { ipDeny: ['198.51.100.20'] });
    expect(isIpAllowedByGuard('198.51.100.20', denyGuard.ipAllow, denyGuard.ipDeny)).toBe(false);
  });

  it('prefers populated top-level guards over legacy rules guards', () => {
    const guard = resolvePolicyIpGuards(['198.51.100.20'], [], { ipAllow: ['203.0.113.10'] });
    expect(isIpAllowedByGuard('198.51.100.20', guard.ipAllow, guard.ipDeny)).toBe(true);
  });
});
