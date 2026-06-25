import { validateOutboundUrl } from '../../ssrf-guard';

/**
 * Shared guarded fetch for provider adapters. Applies the same SSRF policy and
 * timeout as the Flow `http` operation (flow-service.ts), so every outbound
 * call to a Provider API is uniformly protected.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const guard = validateOutboundUrl(url);
  if (!guard.allowed || !guard.url) {
    throw new Error(`outbound URL blocked: ${guard.reason ?? 'not allowed'}`);
  }
  const { timeoutMs = 30_000, ...rest } = init;
  return fetch(guard.url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

/** Bearer auth header for token-based provider APIs. */
export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
