/**
 * Presence state shared by the Cloudflare SiteRoom and the Node hub (#685).
 *
 * A session's presence is what it last said about itself — collection, item,
 * free-form `meta` — plus, in the item editor, the field it has focused and the
 * field it soft-locks while typing. Identity (`userId` / `subjectId`) always
 * comes from the signed ticket, never from the message.
 *
 * Rules:
 * - `meta` larger than {@link PRESENCE_META_MAX_BYTES} serialized is dropped,
 *   so one client cannot flood every peer with a huge payload.
 * - `focus` / `lock` exist only on the studio plane and only with an `itemId`;
 *   moving to another item (or leaving) clears them.
 * - An omitted `focus` / `lock` keeps the previous value; `null` clears it.
 * - `lock.since` is stamped with server time when the locked field changes,
 *   so a later claim on the same field (a takeover) is ordered by the server,
 *   not by client clocks.
 */
import { PRESENCE_META_MAX_BYTES, type ClientMessage, type PresenceEntry } from '@lumibase/contracts';

type PresenceMessage = Extract<ClientMessage, { type: 'presence' }>;

export interface PresenceState {
  userId?: string;
  subjectId?: string;
  collection?: string;
  itemId?: string;
  meta?: Record<string, unknown>;
  focus?: string;
  lock?: { field: string; since: string };
}

export interface PresencePrincipal {
  userId?: string;
  subjectId?: string;
  plane: 'studio' | 'public';
}

function boundedMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  try {
    return new TextEncoder().encode(JSON.stringify(meta)).length <= PRESENCE_META_MAX_BYTES ? meta : undefined;
  } catch {
    return undefined;
  }
}

/** The session's presence after `msg`. */
export function nextPresence(
  prev: PresenceState,
  msg: PresenceMessage,
  principal: PresencePrincipal,
  now: Date = new Date(),
): PresenceState {
  const next: PresenceState = {
    userId: principal.userId,
    subjectId: principal.subjectId,
    collection: msg.collection,
    itemId: msg.itemId,
    meta: boundedMeta(msg.meta),
  };
  const sameItem = Boolean(msg.itemId) && prev.itemId === msg.itemId && prev.collection === msg.collection;
  const fieldsAllowed = principal.plane === 'studio' && Boolean(msg.itemId);
  if (!fieldsAllowed) return next;

  const focus = msg.focus === undefined ? (sameItem ? prev.focus : undefined) : msg.focus ?? undefined;
  if (focus) next.focus = focus;

  if (msg.lock === undefined) {
    if (sameItem && prev.lock) next.lock = prev.lock;
  } else if (msg.lock !== null) {
    next.lock =
      sameItem && prev.lock?.field === msg.lock ? prev.lock : { field: msg.lock, since: now.toISOString() };
  }
  return next;
}

/** Wire entries for every session of one plane. */
export function presenceEntries(
  sessions: Iterable<{ sessionId: string; plane: 'studio' | 'public'; presence: PresenceState }>,
  plane: 'studio' | 'public',
  now: Date = new Date(),
): PresenceEntry[] {
  const lastSeen = now.toISOString();
  const users: PresenceEntry[] = [];
  for (const s of sessions) {
    if (s.plane !== plane) continue;
    users.push({ sessionId: s.sessionId, ...s.presence, lastSeen });
  }
  return users;
}

/**
 * The entries a recipient may see: those on collections its ticket allows
 * (`*` = all), plus entries not on any collection. Presence names the item a
 * person has open, which is itself information about that collection.
 */
export function visiblePresence(entries: PresenceEntry[], allowedCollections: ReadonlySet<string>): PresenceEntry[] {
  if (allowedCollections.has('*')) return entries;
  return entries.filter((e) => !e.collection || allowedCollections.has(e.collection));
}
