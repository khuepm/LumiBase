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

/**
 * Resolve a hostname to its IP address literals. Injectable so the SSRF guard
 * stays runtime-agnostic: on Node a `node:dns` resolver is wired in by default,
 * on Workers (where no DNS module exists) resolution is simply skipped.
 */
export type HostnameResolver = (hostname: string) => Promise<string[]>;

export interface OutboundUrlGuardOptions {
  allowPrivateNetwork?: boolean;
  allowLocalhost?: boolean;
  blockedHosts?: Iterable<string>;
  blockedIps?: Iterable<string>;
  /**
   * DNS resolver used to defeat DNS-rebinding: a public hostname that resolves
   * to a private/metadata IP. When omitted, {@link defaultHostnameResolver} is
   * used (Node only). Pass `null` to disable resolution entirely.
   */
  resolve?: HostnameResolver | null;
  /**
   * When `true`, a hostname whose DNS resolution fails (or cannot run because no
   * resolver is available) is REJECTED rather than allowed through on the
   * literal-string check alone. Defaults to `false` (best-effort: the sync
   * checks still apply, resolution only adds protection when it succeeds).
   */
  requireDnsResolution?: boolean;
}

export interface OutboundUrlGuardResult {
  allowed: boolean;
  url?: URL;
  reason?: string;
  /** IPs the hostname resolved to, when DNS resolution ran. */
  resolvedIps?: string[];
}

/**
 * Synchronous, literal-string validation of a user-supplied outbound URL. This
 * blocks classic SSRF targets by inspecting the URL as written: localhost,
 * RFC1918/link-local IP literals, cloud metadata endpoints, userinfo tricks,
 * and unsupported protocols.
 *
 * It CANNOT catch a public hostname that resolves to a private IP
 * (DNS-rebinding). For that, use {@link resolveAndValidateOutboundUrl} or
 * {@link guardedFetch}, which additionally resolve DNS and re-check every
 * resolved IP.
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

/**
 * Full outbound-URL validation: the synchronous checks above PLUS DNS
 * resolution of the hostname, re-checking each resolved IP against the blocked
 * IP set and the private/loopback/link-local/metadata ranges.
 *
 * This closes the DNS-rebinding gap where `evil.example.com` (a public name)
 * points at `169.254.169.254` or `10.0.0.5`.
 */
export async function resolveAndValidateOutboundUrl(
  raw: string,
  options: OutboundUrlGuardOptions = {},
): Promise<OutboundUrlGuardResult> {
  const base = validateOutboundUrl(raw, options);
  if (!base.allowed || !base.url) return base;

  // Internal control-plane calls opt out of private-network blocking; there is
  // nothing to re-check by resolving.
  if (options.allowPrivateNetwork) return base;

  const hostname = normalizeHostname(base.url.hostname);

  // Already an IP literal — the sync check has fully vetted it, DNS adds nothing.
  if (isIpLiteral(hostname)) return base;

  const resolver = options.resolve === undefined ? defaultHostnameResolver : options.resolve;
  if (!resolver) {
    // No resolver available (e.g. Workers). Honour fail-closed if requested.
    if (options.requireDnsResolution) {
      return { allowed: false, reason: 'DNS resolution is required but unavailable in this runtime.' };
    }
    return base;
  }

  let ips: string[];
  try {
    ips = await resolver(hostname);
  } catch {
    if (options.requireDnsResolution) {
      return { allowed: false, reason: 'Hostname could not be resolved.' };
    }
    return base; // best-effort: keep the sync verdict
  }

  if (ips.length === 0) {
    if (options.requireDnsResolution) {
      return { allowed: false, reason: 'Hostname resolved to no addresses.' };
    }
    return base;
  }

  const blockedIps = normalizeSet(options.blockedIps ?? DEFAULT_BLOCKED_IPS);
  for (const ip of ips) {
    const normalized = normalizeHostname(ip);
    if (blockedIps.has(normalized)) {
      return { allowed: false, reason: 'Hostname resolves to a blocked IP address.', resolvedIps: ips };
    }
    if (isPrivateOrLoopback(normalized)) {
      return {
        allowed: false,
        reason: 'Hostname resolves to a private, loopback, link-local, or metadata IP.',
        resolvedIps: ips,
      };
    }
  }

  return { ...base, resolvedIps: ips };
}

export async function guardedFetch(
  input: string,
  init?: RequestInit,
  options?: OutboundUrlGuardOptions,
): Promise<Response> {
  const result = await resolveAndValidateOutboundUrl(input, options ?? {});
  if (!result.allowed || !result.url) {
    throw new Error(result.reason ?? 'Outbound URL is not allowed.');
  }
  return fetch(result.url, init);
}

/**
 * Node `dns` resolver, loaded lazily so the module bundles cleanly for the
 * Cloudflare Workers build (no static `node:dns` import). Returns `null` when
 * DNS is unavailable (non-Node runtimes), which callers treat as "skip".
 */
let cachedResolver: HostnameResolver | null | undefined;
export const defaultHostnameResolver: HostnameResolver = async (hostname) => {
  if (cachedResolver === undefined) {
    cachedResolver = await loadNodeResolver();
  }
  if (!cachedResolver) return [];
  return cachedResolver(hostname);
};

async function loadNodeResolver(): Promise<HostnameResolver | null> {
  const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node);
  if (!isNode) return null;
  try {
    // Variable specifier keeps bundlers from statically pulling in node:dns.
    const mod = 'node:dns/promises';
    const dns = (await import(/* @vite-ignore */ mod)) as typeof import('node:dns/promises');
    return async (hostname: string) => {
      const records = await dns.lookup(hostname, { all: true });
      return records.map((r) => r.address);
    };
  } catch {
    return null;
  }
}

function isIpLiteral(hostname: string): boolean {
  // IPv6 literals contain a colon; IPv4 literals are four dotted decimal octets.
  if (hostname.includes(':')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function normalizeSet(values: Iterable<string>): Set<string> {
  return new Set([...values].map(normalizeHostname).filter(Boolean));
}

function normalizeHostname(value: string): string {
  return value.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}
