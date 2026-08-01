/**
 * Change Feed webhook sender (Req 4.1–4.3).
 *
 * Signs every delivery with HMAC-SHA256 over the raw body via WebCrypto
 * (`crypto.subtle` — identical on Workers and Node) and sends through the
 * platform SSRF guard. The signing/verify pair is exported pure so property
 * P5 and consumer docs exercise the exact production code.
 *
 * Header: `X-LumiBase-Signature: t=<unix_seconds>,v1=<hex>` where
 * `v1 = HMAC_SHA256(secret, `${t}.${rawBody}`)` — timestamp inside the MAC
 * keeps a captured request from being replayed later (consumers should
 * reject |now - t| beyond a few minutes).
 */

import { guardedFetch } from '../../../services/ssrf-guard';
import type { CdcEventEnvelope } from '@lumibase/contracts/schemas';

export const SIGNATURE_HEADER = 'X-LumiBase-Signature';
export const WEBHOOK_TIMEOUT_MS = 30_000;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

export async function signCdcWebhookBody(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${timestampSeconds}.${rawBody}`);
  return `t=${timestampSeconds},v1=${v1}`;
}

/**
 * Verifies a signature header against a body (the snippet consumers copy —
 * Req 9.1). Returns false on any malformed header; `toleranceSeconds`
 * bounds replay (0 disables the timestamp check, e.g. in pure P5 tests).
 */
export async function verifyCdcWebhookSignature(
  secret: string,
  header: string,
  rawBody: string,
  opts: { nowSeconds?: number; toleranceSeconds?: number } = {},
): Promise<boolean> {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const t = Number(match[1]);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - t) > tolerance) return false;
  }
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  // Constant-time-ish comparison: XOR accumulate over fixed length.
  const given = match[2]!;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

/** Headers a webhook definition may NOT override (Req 4.2). */
const RESERVED_HEADERS = new Set(['x-lumibase-signature', 'content-type']);

export function mergeWebhookHeaders(
  configured: Record<string, string>,
  signature: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(configured)) {
    if (!RESERVED_HEADERS.has(key.toLowerCase())) out[key] = value;
  }
  out['Content-Type'] = 'application/json';
  out[SIGNATURE_HEADER] = signature;
  return out;
}

export interface WebhookTarget {
  url: string;
  secret: string;
  headers: Record<string, string>;
}

export interface WebhookSendOutcome {
  ok: boolean;
  httpStatus: number | null;
  errorMessage: string | null;
}

export interface WebhookSenderDeps {
  /** Injectable transport for tests; defaults to the SSRF-guarded fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
  timeoutMs?: number;
}

export class WebhookSender {
  constructor(private readonly deps: WebhookSenderDeps = {}) {}

  async deliver(
    target: WebhookTarget,
    envelopes: CdcEventEnvelope[],
    subscription: { id: string; name: string },
  ): Promise<WebhookSendOutcome> {
    const body = JSON.stringify({
      events: envelopes,
      subscription: { id: subscription.id, name: subscription.name },
    });
    const now = (this.deps.now ?? (() => new Date()))();
    const signature = await signCdcWebhookBody(
      target.secret,
      Math.floor(now.getTime() / 1000),
      body,
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
    );
    try {
      const send =
        this.deps.fetchImpl ??
        ((url: string, init: RequestInit) => guardedFetch(url, init));
      const res = await send(target.url, {
        method: 'POST',
        headers: mergeWebhookHeaders(target.headers, signature),
        body,
        redirect: 'error', // a redirect could smuggle the signed body elsewhere
        signal: controller.signal,
      });
      return {
        ok: res.status >= 200 && res.status < 300,
        httpStatus: res.status,
        errorMessage: res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        httpStatus: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
