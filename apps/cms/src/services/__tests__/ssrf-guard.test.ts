import { describe, expect, it } from 'vitest';
import { resolveAndValidateOutboundUrl, validateOutboundUrl } from '../ssrf-guard';

describe('validateOutboundUrl', () => {
  it('allows ordinary HTTPS URLs', () => {
    const result = validateOutboundUrl('https://example.com/import.csv');
    expect(result.allowed).toBe(true);
    expect(result.url?.hostname).toBe('example.com');
  });

  it('blocks unsupported protocols and embedded credentials', () => {
    expect(validateOutboundUrl('file:///etc/passwd').allowed).toBe(false);
    expect(validateOutboundUrl('https://user:pass@example.com').allowed).toBe(false);
  });

  it('blocks localhost, private, link-local, and cloud metadata targets', () => {
    expect(validateOutboundUrl('http://localhost:8787').allowed).toBe(false);
    expect(validateOutboundUrl('http://10.0.0.5/data').allowed).toBe(false);
    expect(validateOutboundUrl('http://192.168.1.2/data').allowed).toBe(false);
    expect(validateOutboundUrl('http://169.254.169.254/latest/meta-data').allowed).toBe(false);
    expect(validateOutboundUrl('http://[::1]/data').allowed).toBe(false);
  });

  it('can be explicitly relaxed for internal control-plane calls', () => {
    expect(validateOutboundUrl('http://10.0.0.5/data', { allowPrivateNetwork: true }).allowed).toBe(true);
  });
});

describe('resolveAndValidateOutboundUrl (DNS-rebinding, CWE-918)', () => {
  it('blocks a public hostname that resolves to a private IP', async () => {
    const resolve = async () => ['10.0.0.5'];
    const result = await resolveAndValidateOutboundUrl('https://evil.example.com/x', { resolve });
    expect(result.allowed).toBe(false);
    expect(result.resolvedIps).toEqual(['10.0.0.5']);
  });

  it('blocks a public hostname that resolves to the cloud metadata IP', async () => {
    const resolve = async () => ['169.254.169.254'];
    const result = await resolveAndValidateOutboundUrl('https://rebind.example.com/x', { resolve });
    expect(result.allowed).toBe(false);
  });

  it('allows a public hostname that resolves to public IPs', async () => {
    const resolve = async () => ['93.184.216.34'];
    const result = await resolveAndValidateOutboundUrl('https://example.com/x', { resolve });
    expect(result.allowed).toBe(true);
    expect(result.resolvedIps).toEqual(['93.184.216.34']);
  });

  it('blocks if ANY resolved address is private (multi-record)', async () => {
    const resolve = async () => ['93.184.216.34', '192.168.1.10'];
    const result = await resolveAndValidateOutboundUrl('https://mixed.example.com/x', { resolve });
    expect(result.allowed).toBe(false);
  });

  it('is best-effort by default when resolution fails', async () => {
    const resolve = async () => {
      throw new Error('ENOTFOUND');
    };
    const result = await resolveAndValidateOutboundUrl('https://example.com/x', { resolve });
    expect(result.allowed).toBe(true); // sync verdict preserved
  });

  it('fails closed on resolution failure when requireDnsResolution is set', async () => {
    const resolve = async () => {
      throw new Error('ENOTFOUND');
    };
    const result = await resolveAndValidateOutboundUrl('https://example.com/x', {
      resolve,
      requireDnsResolution: true,
    });
    expect(result.allowed).toBe(false);
  });

  it('skips resolution for IP-literal hosts (already vetted)', async () => {
    let called = false;
    const resolve = async () => {
      called = true;
      return ['1.1.1.1'];
    };
    const result = await resolveAndValidateOutboundUrl('https://1.1.1.1/x', { resolve });
    expect(result.allowed).toBe(true);
    expect(called).toBe(false);
  });

  it('still short-circuits on the sync checks before resolving', async () => {
    let called = false;
    const resolve = async () => {
      called = true;
      return ['1.1.1.1'];
    };
    const result = await resolveAndValidateOutboundUrl('http://localhost/x', { resolve });
    expect(result.allowed).toBe(false);
    expect(called).toBe(false);
  });
});
