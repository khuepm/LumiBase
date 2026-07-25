/**
 * Audience grant resolution — the authorization seam for audience (end-user)
 * realtime tickets.
 *
 * This is where the app decides, for an authenticated frontend principal:
 *   - the `subjectId` used to address that end-user (mapped from e.g. a
 *     citizenID / external id — the FE user lives in an APP-OWNED table, not
 *     `users`, and that separation is intentional); and
 *   - the set of channels the subject is allowed to join.
 *
 * Keeping this decision on the server (never trusting client-declared channels)
 * is the fix for the class of bug where a tenant's realtime layer cannot filter
 * end-users because their identity lives outside the admin `users` table.
 *
 * The default policy below is deliberately conservative. Apps with richer
 * channel rules (per-order, per-room, role-scoped topics) should extend this by
 * reading verified claims off `principal.raw` — the grant must be derivable
 * from authenticated state, not from the requested list alone.
 */

import type { AuthPrincipal } from '../env';

export interface AudienceGrant {
  /** Logical id used to address this end-user across their sessions. */
  subjectId: string;
  /** Channels the subject is permitted to join. */
  channels: string[];
}

/** The subject's private, always-allowed self channel. */
export function subjectChannel(subjectId: string): string {
  return `subject:${subjectId}`;
}

/**
 * Resolve the subjectId for a frontend principal. Prefers an explicit
 * `subject`/`citizenID` verified claim, then `externalId`, then `userId`.
 * Returns null when the principal is not a frontend end-user.
 */
export function resolveSubjectId(principal: AuthPrincipal): string | null {
  if (!principal.isFrontendUser) return null;
  const raw = principal.raw ?? {};
  const claim =
    (typeof raw.subject === 'string' && raw.subject) ||
    (typeof raw.citizenId === 'string' && raw.citizenId) ||
    (typeof raw.citizenID === 'string' && raw.citizenID) ||
    principal.externalId ||
    principal.userId;
  return claim ? String(claim) : null;
}

/**
 * Read the channel allowlist a principal carries via verified claims. Apps sign
 * this into the FE user's auth token (`channels: string[]`). Absent → empty.
 */
function allowedChannelsFromClaims(principal: AuthPrincipal): Set<string> {
  const raw = principal.raw ?? {};
  const claim = raw.channels;
  if (!Array.isArray(claim)) return new Set();
  return new Set(claim.filter((c): c is string => typeof c === 'string'));
}

/**
 * Build the audience grant for a principal, intersecting the requested channels
 * with what the principal is actually allowed to join. The subject's own
 * `subject:<id>` channel is always granted.
 *
 * @returns the grant, or null if the principal cannot receive an audience ticket.
 */
export function resolveAudienceGrant(
  principal: AuthPrincipal,
  requestedChannels: string[] = [],
): AudienceGrant | null {
  const subjectId = resolveSubjectId(principal);
  if (!subjectId) return null;

  const allowed = allowedChannelsFromClaims(principal);
  const self = subjectChannel(subjectId);

  const granted = new Set<string>([self]);
  for (const requested of requestedChannels) {
    if (allowed.has(requested)) granted.add(requested);
  }

  return { subjectId, channels: Array.from(granted) };
}
