/**
 * PresenceChip — displays avatar stack of users currently viewing the same
 * collection/item, powered by the usePresence hook.
 *
 * Shows up to 4 avatars. When more users are present, shows a +N badge.
 * Each avatar has a tooltip with the userId.
 *
 * PresenceStack is the presentational core (takes an already-resolved peer
 * list); PresenceChip wraps it with its own presence connection. Use the stack
 * directly when the parent already holds a presence subscription, to avoid
 * opening a second WebSocket for the same page.
 */

import { usePresence } from '@/hooks/use-presence';
import type { PresenceEntry } from '@/types/realtime';

interface PresenceChipProps {
  collection: string;
  itemId?: string;
  /** Maximum avatars to display before showing +N. Default: 4 */
  maxVisible?: number;
}

interface PresenceStackProps {
  /** Peers to render — already scoped/de-duped by the caller. */
  peers: PresenceEntry[];
  /** Maximum avatars to display before showing +N. Default: 4 */
  maxVisible?: number;
}

const COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f97316',
  '#10b981', '#06b6d4', '#eab308', '#ef4444',
];

function avatarColor(userId: string): string {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
  return COLORS[Math.abs(hash) % COLORS.length] ?? COLORS[0]!;
}

function Avatar({ user }: { user: PresenceEntry }) {
  const initials = user.userId.slice(0, 2).toUpperCase();
  const bg = avatarColor(user.userId);
  return (
    <span
      title={user.userId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: '50%',
        background: bg,
        color: '#fff',
        fontSize: 11,
        fontWeight: 600,
        border: '2px solid var(--color-background, #fff)',
        marginLeft: -6,
        flexShrink: 0,
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      {initials}
    </span>
  );
}

/** Scope a raw peer list to one item (when given) and de-dupe by userId. */
function scopePeers(peers: PresenceEntry[], itemId?: string): PresenceEntry[] {
  const scoped = itemId ? peers.filter((p) => p.itemId === itemId) : peers;
  const seen = new Set<string>();
  return scoped.filter((p) => (seen.has(p.userId) ? false : (seen.add(p.userId), true)));
}

/** Presentational avatar stack — no presence connection of its own. */
export function PresenceStack({ peers, maxVisible = 4 }: PresenceStackProps) {
  if (peers.length === 0) return null;

  const visible = peers.slice(0, maxVisible);
  const overflow = peers.length - maxVisible;

  return (
    <span
      role="group"
      aria-label={`${peers.length} user${peers.length !== 1 ? 's' : ''} viewing`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        paddingLeft: 6,
        gap: 0,
      }}
    >
      {visible.map((u) => (
        <Avatar key={u.sessionId} user={u} />
      ))}
      {overflow > 0 && (
        <span
          title={`${overflow} more user${overflow !== 1 ? 's' : ''}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'var(--color-subdued, #6b7280)',
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            border: '2px solid var(--color-background, #fff)',
            marginLeft: -6,
            flexShrink: 0,
          }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

export function PresenceChip({ collection, itemId, maxVisible = 4 }: PresenceChipProps) {
  const { peers, connected } = usePresence({ collection, itemId });
  if (!connected) return null;
  // When an itemId is supplied, only count peers on the *same* item — otherwise
  // the chip shows everyone in the collection, which misrepresents "here".
  return <PresenceStack peers={scopePeers(peers, itemId)} maxVisible={maxVisible} />;
}
