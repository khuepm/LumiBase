import type { DomainVerificationRecord } from '@lumibase/shared/schemas';
import { bearer, guardedFetch } from '../deployment/providers/http';

/**
 * Cloudflare for SaaS — Custom Hostnames client.
 *
 * Wraps the `/zones/{zone}/custom_hostnames` REST API so LumiBase can provision
 * a TLS certificate for an operator-owned domain without that operator moving
 * their nameservers. Flow:
 *
 *   1. `createCustomHostname(hostname)` — registers the hostname and requests a
 *      DV certificate validated via TXT (DCV). Cloudflare returns the DNS
 *      records the operator must publish (a CNAME to the SaaS fallback origin,
 *      plus a TXT token for certificate validation).
 *   2. The operator publishes those records at their own DNS provider.
 *   3. `getCustomHostname(id)` — polled until `status` and `ssl.status` are both
 *      `active`; then the hostname routes traffic to this Worker.
 *
 * Token + zone come from the Worker env (`CLOUDFLARE_API_TOKEN`,
 * `CLOUDFLARE_ZONE_ID`). When either is missing — self-hosted / Docker — the
 * caller falls back to manual DNS instructions instead of calling this client
 * (see `isConfigured`). Strict Rule #3: we never touch a CF binding here; this
 * is a plain authenticated `fetch` and the token is read from `c.env`.
 */

const API = 'https://api.cloudflare.com/client/v4';

export interface CloudflareSaaSConfig {
  apiToken: string;
  zoneId: string;
  /** Hostname operators CNAME to (the proxied fallback origin), e.g. `cname.lumibase.dev`. */
  fallbackOrigin: string;
}

/** Normalized view of a Cloudflare custom hostname, mapped to our domain row. */
export interface CustomHostnameState {
  cfHostnameId: string;
  /** `pending` | `pending_validation` | `active` | `blocked` | `moved` | `deleted`. */
  status: string;
  /** `initializing` | `pending_validation` | `active` | `pending_deployment` | … */
  sslStatus: string;
  /** DNS records the operator must publish (CNAME + DCV TXT). */
  records: DomainVerificationRecord[];
}

/** Build a config from env, or null when the platform isn't set up for SaaS. */
export function cloudflareSaaSConfig(env: {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  LUMIBASE_SAAS_FALLBACK?: string;
}): CloudflareSaaSConfig | null {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ZONE_ID) return null;
  return {
    apiToken: env.CLOUDFLARE_API_TOKEN,
    zoneId: env.CLOUDFLARE_ZONE_ID,
    fallbackOrigin: env.LUMIBASE_SAAS_FALLBACK ?? 'cname.lumibase.dev',
  };
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
}

interface CfHostname {
  id: string;
  hostname: string;
  status?: string;
  ssl?: {
    status?: string;
    validation_records?: Array<{ txt_name?: string; txt_value?: string }>;
  };
  // Some API versions surface DCV on `ownership_verification`.
  ownership_verification?: { type?: string; name?: string; value?: string };
}

function cfError(env: CfEnvelope<unknown>, status: number): string {
  const first = env.errors?.[0];
  return first ? `Cloudflare ${status}: ${first.message} (${first.code})` : `Cloudflare ${status}`;
}

/**
 * Map a Cloudflare hostname payload into the DNS records the operator must
 * create: always the CNAME to the fallback origin, plus the DCV TXT token once
 * Cloudflare has issued one.
 */
function toState(cfg: CloudflareSaaSConfig, h: CfHostname): CustomHostnameState {
  const records: DomainVerificationRecord[] = [
    {
      type: 'CNAME',
      name: h.hostname,
      value: cfg.fallbackOrigin,
      purpose: 'Routes your domain to LumiBase.',
    },
  ];
  const dcv = h.ssl?.validation_records?.find((r) => r.txt_name && r.txt_value);
  if (dcv?.txt_name && dcv.txt_value) {
    records.push({
      type: 'TXT',
      name: dcv.txt_name,
      value: dcv.txt_value,
      purpose: 'Proves domain ownership so Cloudflare can issue an SSL certificate.',
    });
  } else if (h.ownership_verification?.name && h.ownership_verification.value) {
    records.push({
      type: 'TXT',
      name: h.ownership_verification.name,
      value: h.ownership_verification.value,
      purpose: 'Proves domain ownership so Cloudflare can issue an SSL certificate.',
    });
  }
  return {
    cfHostnameId: h.id,
    status: h.status ?? 'pending',
    sslStatus: h.ssl?.status ?? 'initializing',
    records,
  };
}

export class CloudflareSaaSClient {
  constructor(private readonly cfg: CloudflareSaaSConfig) {}

  /** Register `hostname` and request a DV cert validated by TXT (DCV). */
  async createCustomHostname(hostname: string): Promise<CustomHostnameState> {
    const res = await guardedFetch(`${API}/zones/${this.cfg.zoneId}/custom_hostnames`, {
      method: 'POST',
      headers: { ...bearer(this.cfg.apiToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hostname,
        ssl: {
          method: 'txt',
          type: 'dv',
          settings: { min_tls_version: '1.2' },
        },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as CfEnvelope<CfHostname>;
    if (!res.ok || !json.success || !json.result) {
      throw new Error(cfError(json, res.status));
    }
    // The create response may omit DCV tokens; a follow-up GET fills them in.
    const created = toState(this.cfg, json.result);
    if (created.records.length < 2) {
      try {
        return await this.getCustomHostname(created.cfHostnameId);
      } catch {
        return created;
      }
    }
    return created;
  }

  /** Fetch current status + validation records for a hostname id. */
  async getCustomHostname(id: string): Promise<CustomHostnameState> {
    const res = await guardedFetch(
      `${API}/zones/${this.cfg.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
      { headers: bearer(this.cfg.apiToken) },
    );
    const json = (await res.json().catch(() => ({}))) as CfEnvelope<CfHostname>;
    if (!res.ok || !json.success || !json.result) {
      throw new Error(cfError(json, res.status));
    }
    return toState(this.cfg, json.result);
  }

  /** Remove a hostname (best-effort; missing hostname is treated as success). */
  async deleteCustomHostname(id: string): Promise<void> {
    const res = await guardedFetch(
      `${API}/zones/${this.cfg.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: bearer(this.cfg.apiToken) },
    );
    if (res.status === 404) return;
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as CfEnvelope<unknown>;
      throw new Error(cfError(json, res.status));
    }
  }
}

/** True once both `status` and `ssl.status` report `active`. */
export function isHostnameLive(state: Pick<CustomHostnameState, 'status' | 'sslStatus'>): boolean {
  return state.status === 'active' && state.sslStatus === 'active';
}
