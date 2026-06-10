import { describe, expect, it } from 'vitest';
import { validateOutboundUrl } from '../outbound-url-guard';

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
