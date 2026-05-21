/**
 * PresenceChip — displays avatar stack of users currently viewing the same
 * collection/item, powered by the usePresence hook.
 *
 * Shows up to 4 avatars. When more users are present, shows a +N badge.
 * Each avatar has a tooltip with the userId.
 */

import { usePresence } from '@/hooks/use-presence';
import type { PresenceEntry } from '@/types/realtime';

interface PresenceChipProps {
  collection: string;
  itemId?: string;
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

export function PresenceChip({ collection, itemId, maxVisible = 4 }: PresenceChipProps) {
  const { peers, connected } = usePresence({ collection, itemId });

  if (!connected || peers.length === 0) return null;

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
