/**
 * Collaborative cursor protocol — POST-GA2.
 *
 * "CRDT-lite": we do not run a full operational-transform stack.
 * Instead, we broadcast last-write-wins cursor positions plus a small
 * Y-style update vector for inline text edits. Each client maintains its
 * own state; the server is a relay backed by the existing SiteRoom
 * Durable Object.
 *
 * Message types:
 *
 *   client → server:
 *     { type: 'cursor.join',   itemId, fieldKey, color, name }
 *     { type: 'cursor.move',   itemId, fieldKey, anchor, head, selection }
 *     { type: 'cursor.update', itemId, fieldKey, ops: TextOp[] }
 *     { type: 'cursor.leave',  itemId, fieldKey }
 *
 *   server → client:
 *     { type: 'cursor.peer',   userId, itemId, fieldKey, anchor, head, color, name, ts }
 *     { type: 'cursor.peers',  list: PeerCursor[] }
 *     { type: 'cursor.ops',    userId, itemId, fieldKey, ops: TextOp[], ts }
 *
 * Conflict resolution:
 *   - Cursor positions: last write wins (single integer offsets).
 *   - Text ops: 3-tuple inserts/deletes carrying a stable client clock
 *     so concurrent edits can be merged without reordering history.
 */

export type CursorMessage =
  | { type: 'cursor.join'; itemId: string; fieldKey: string; color: string; name: string }
  | { type: 'cursor.move'; itemId: string; fieldKey: string; anchor: number; head: number; selection?: { from: number; to: number } }
  | { type: 'cursor.update'; itemId: string; fieldKey: string; ops: TextOp[] }
  | { type: 'cursor.leave'; itemId: string; fieldKey: string };

export interface TextOp {
  /** Operation kind. */
  kind: 'insert' | 'delete';
  /** 0-indexed character offset before the operation is applied. */
  pos: number;
  /** Inserted text (kind = 'insert') or number of chars to delete. */
  value: string | number;
  /** Hybrid logical clock so concurrent ops can be ordered deterministically. */
  clock: number;
  /** Stable client id — used as a tie-break when clocks match. */
  client: string;
}

export interface PeerCursor {
  userId: string;
  itemId: string;
  fieldKey: string;
  anchor: number;
  head: number;
  color: string;
  name: string;
  ts: number;
}

/**
 * In-memory cursor registry. One instance per (siteId, itemId) — typically
 * lives inside a SiteRoom Durable Object.
 *
 * Eviction: peers older than `idleMs` are removed on each broadcast call.
 */
export class CursorRegistry {
  private peers = new Map<string, PeerCursor>(); // key = `${userId}:${itemId}:${fieldKey}`

  constructor(private idleMs = 60_000) {}

  /** Apply a client message and return outbound messages to broadcast. */
  apply(userId: string, msg: CursorMessage, now = Date.now()): {
    broadcast: Array<{ type: 'cursor.peer' | 'cursor.ops' | 'cursor.leave'; payload: Record<string, unknown> }>;
  } {
    const broadcast: Array<{ type: 'cursor.peer' | 'cursor.ops' | 'cursor.leave'; payload: Record<string, unknown> }> = [];

    switch (msg.type) {
      case 'cursor.join':
      case 'cursor.move': {
        const key = `${userId}:${msg.itemId}:${msg.fieldKey}`;
        const existing = this.peers.get(key);
        const peer: PeerCursor = {
          userId,
          itemId: msg.itemId,
          fieldKey: msg.fieldKey,
          anchor: msg.type === 'cursor.move' ? msg.anchor : existing?.anchor ?? 0,
          head: msg.type === 'cursor.move' ? msg.head : existing?.head ?? 0,
          color: msg.type === 'cursor.join' ? msg.color : existing?.color ?? '#888',
          name: msg.type === 'cursor.join' ? msg.name : existing?.name ?? userId,
          ts: now,
        };
        this.peers.set(key, peer);
        broadcast.push({ type: 'cursor.peer', payload: peer });
        break;
      }
      case 'cursor.update': {
        broadcast.push({
          type: 'cursor.ops',
          payload: { userId, itemId: msg.itemId, fieldKey: msg.fieldKey, ops: msg.ops, ts: now },
        });
        break;
      }
      case 'cursor.leave': {
        const key = `${userId}:${msg.itemId}:${msg.fieldKey}`;
        this.peers.delete(key);
        broadcast.push({
          type: 'cursor.leave',
          payload: { userId, itemId: msg.itemId, fieldKey: msg.fieldKey, ts: now },
        });
        break;
      }
    }

    this.evictIdle(now);
    return { broadcast };
  }

  /** Snapshot of every active peer (used when a fresh client joins). */
  list(itemId?: string): PeerCursor[] {
    const list = [...this.peers.values()];
    return itemId ? list.filter((p) => p.itemId === itemId) : list;
  }

  /** Drop peers that haven't sent any signal in `idleMs`. */
  private evictIdle(now: number): void {
    for (const [key, peer] of this.peers) {
      if (now - peer.ts > this.idleMs) this.peers.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// CRDT-lite: deterministic merge for concurrent text ops.
//
// The algorithm is intentionally simple — we sort by (clock, client) and
// re-apply each operation against the running offset tracker. It handles
// the common cases for headless CMS field edits (one author per field at a
// time, occasional 2-3 way conflicts).
// ---------------------------------------------------------------------------

export function applyOps(initial: string, ops: TextOp[]): string {
  const sorted = [...ops].sort((a, b) =>
    a.clock !== b.clock ? a.clock - b.clock : a.client.localeCompare(b.client),
  );

  let out = initial;
  for (const op of sorted) {
    if (op.kind === 'insert') {
      const value = String(op.value);
      out = out.slice(0, op.pos) + value + out.slice(op.pos);
    } else {
      const len = typeof op.value === 'number' ? op.value : String(op.value).length;
      out = out.slice(0, op.pos) + out.slice(op.pos + len);
    }
  }
  return out;
}
