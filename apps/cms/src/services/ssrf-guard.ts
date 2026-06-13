import { isPrivateOrLoopback } from '../modules/anomaly/private-ip';

const DEFAULT_BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
]);

const DEFAULT_BLOCKED_IPS = new Set([
  '169.254.169.254',
  '100.100.100.200',
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface OutboundUrlGuardOptions {
  allowPrivateNetwork?: boolean;
  allowLocalhost?: boolean;
  blockedHosts?: Iterable<string>;
  blockedIps?: Iterable<string>;
}

export interface OutboundUrlGuardResult {
  allowed: boolean;
  url?: URL;
  reason?: string;
}

/**
 * Validate user-supplied outbound URLs before any fetch/import feature uses
 * them. This blocks classic SSRF targets: localhost, RFC1918/link-local IPs,
 * cloud metadata endpoints, userinfo tricks, and unsupported protocols.
 */
export function validateOutboundUrl(raw: string, options: OutboundUrlGuardOptions = {}): OutboundUrlGuardResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: 'URL is invalid.' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { allowed: false, reason: 'Only http and https URLs are allowed.' };
  }

  if (url.username || url.password) {
    return { allowed: false, reason: 'URLs with embedded credentials are not allowed.' };
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return { allowed: false, reason: 'URL host is required.' };

  const blockedHosts = normalizeSet(options.blockedHosts ?? DEFAULT_BLOCKED_HOSTS);
  if (!options.allowLocalhost && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    return { allowed: false, reason: 'Localhost targets are not allowed.' };
  }
  if (blockedHosts.has(hostname)) {
    return { allowed: false, reason: 'Host is explicitly blocked.' };
  }

  const blockedIps = normalizeSet(options.blockedIps ?? DEFAULT_BLOCKED_IPS);
  if (blockedIps.has(hostname)) {
    return { allowed: false, reason: 'IP address is explicitly blocked.' };
  }

  if (!options.allowPrivateNetwork && isPrivateOrLoopback(hostname)) {
    return { allowed: false, reason: 'Private, loopback, link-local, and metadata IPs are not allowed.' };
  }

  return { allowed: true, url };
}

export async function guardedFetch(input: string, init?: RequestInit, options?: OutboundUrlGuardOptions): Promise<Response> {
  const result = validateOutboundUrl(input, options);
  if (!result.allowed || !result.url) {
    throw new Error(result.reason ?? 'Outbound URL is not allowed.');
  }
  return fetch(result.url, init);
}

function normalizeSet(values: Iterable<string>): Set<string> {
  return new Set([...values].map(normalizeHostname).filter(Boolean));
}

function normalizeHostname(value: string): string {
  return value.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}
