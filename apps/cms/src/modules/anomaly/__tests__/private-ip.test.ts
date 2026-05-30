import { describe, it, expect } from 'vitest';

import { isPrivateOrLoopback } from '../private-ip';

/**
 * Unit tests for the private/loopback detector consumed by
 * `geoSubscore` (admin-setup-wizard task 7.2; Req 9.5; design §8.1).
 *
 * The geo detector skips the MMDB lookup entirely for any IP that
 * matches RFC 1918, IPv4 loopback, IPv6 loopback, link-local, or
 * the `'unknown'` sentinel from `extractClientIp`. These tests pin
 * that surface so a future tweak (e.g. accepting a new sentinel)
 * doesn't accidentally re-route private traffic into the lookup.
 */

describe('isPrivateOrLoopback', () => {
  describe('skip cases (Req 9.5)', () => {
    it.each([
      ['IPv4 loopback', '127.0.0.1'],
      ['IPv4 loopback in /8', '127.10.20.30'],
      ['RFC1918 10/8', '10.0.0.1'],
      ['RFC1918 192.168/16', '192.168.1.42'],
      ['RFC1918 172.16/12 lower bound', '172.16.0.1'],
      ['RFC1918 172.31/12 upper bound', '172.31.255.254'],
      ['link-local 169.254/16', '169.254.10.5'],
      ['IPv4 unspecified', '0.0.0.0'],
      ['IPv6 loopback', '::1'],
      ['IPv6 unspecified', '::'],
      ['IPv6 ULA fc00', 'fc00::1'],
      ['IPv6 ULA fd12', 'fd12:3456::1'],
      ['IPv6 link-local fe80', 'fe80::1'],
      ['IPv6 link-local feb0', 'feb0::1'],
      ['IPv6 fully-expanded loopback', '0:0:0:0:0:0:0:1'],
      ['IPv6 fully-expanded unspecified', '0:0:0:0:0:0:0:0'],
      ['empty string', ''],
      ['whitespace', '   '],
      ['extractClientIp unknown sentinel', 'unknown'],
      ['null', null],
      ['undefined', undefined],
    ])('treats %s (%s) as private/loopback', (_label, input) => {
      expect(isPrivateOrLoopback(input as string | null | undefined)).toBe(
        true,
      );
    });
  });

  describe('routable cases', () => {
    it.each([
      ['public IPv4', '8.8.8.8'],
      ['public IPv4 (Cloudflare)', '1.1.1.1'],
      ['172.15.x.x is NOT in RFC1918', '172.15.0.1'],
      ['172.32.x.x is NOT in RFC1918', '172.32.0.1'],
      ['11.x.x.x is NOT in RFC1918', '11.0.0.1'],
      ['public IPv6', '2606:4700:4700::1111'],
      ['public IPv6 (documentation prefix is still routable here)', '2001:db8::1'],
    ])('treats %s (%s) as routable', (_label, ip) => {
      expect(isPrivateOrLoopback(ip)).toBe(false);
    });
  });
});
