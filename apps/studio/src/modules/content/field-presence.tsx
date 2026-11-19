import { Lock, Users } from 'lucide-react';
import type { PresenceEntry } from '@/types/realtime';

/**
 * Field presence and soft locks in the item editor (#685).
 *
 * Every session on the item reports the field it has focused and the field it
 * is editing (its soft lock). For each field:
 * - `focused` lists the *other* sessions that have it focused (badge);
 * - `holder` is the session whose lock on it is newest. Locks are stamped by
 *   the server, so "Take over" — claiming the same field later — always wins
 *   and the previous holder sees the field go read-only.
 * Locks are soft: they guide people, the server does not refuse writes. A
 * lock disappears when its holder blurs the field, leaves the item or
 * disconnects (the server drops the session's presence).
 */

export interface FieldPresenceInfo {
  focused: PresenceEntry[];
  holder?: PresenceEntry;
}

export function computeFieldPresence(
  sessions: PresenceEntry[],
  selfSessionId: string | null,
): Map<string, FieldPresenceInfo> {
  const out = new Map<string, FieldPresenceInfo>();
  const entry = (field: string) => {
    let info = out.get(field);
    if (!info) {
      info = { focused: [] };
      out.set(field, info);
    }
    return info;
  };
  for (const s of sessions) {
    if (s.focus && s.sessionId !== selfSessionId) entry(s.focus).focused.push(s);
    if (s.lock) {
      const info = entry(s.lock.field);
      if (!info.holder || s.lock.since > (info.holder.lock?.since ?? '')) info.holder = s;
    }
  }
  return out;
}

/** Someone else holds the field's soft lock. */
export function lockedByOther(info: FieldPresenceInfo | undefined, selfSessionId: string | null): PresenceEntry | null {
  const holder = info?.holder;
  return holder && holder.sessionId !== selfSessionId ? holder : null;
}

export function presenceName(e: PresenceEntry): string {
  const meta = e.meta ?? {};
  const name = meta.name ?? meta.email;
  return typeof name === 'string' && name.length > 0 ? name : e.userId || 'Someone';
}

/** Hooks for FieldsTab: what to show per field and what to report back. */
export interface FieldPresenceApi {
  info: (field: string) => FieldPresenceInfo | undefined;
  lockedByOther: (field: string) => PresenceEntry | null;
  onFocus: (field: string) => void;
  onBlur: (field: string) => void;
  /** First keystroke in a field takes its soft lock. */
  onEdit: (field: string) => void;
  onTakeOver: (field: string) => void;
}

export function buildFieldPresenceApi(opts: {
  sessions: PresenceEntry[];
  selfSessionId: string | null;
  setFocus: (field: string | null) => void;
  setLock: (field: string | null) => void;
}): FieldPresenceApi {
  const map = computeFieldPresence(opts.sessions, opts.selfSessionId);
  const self = opts.sessions.find((s) => s.sessionId === opts.selfSessionId);
  return {
    info: (field) => map.get(field),
    lockedByOther: (field) => lockedByOther(map.get(field), opts.selfSessionId),
    onFocus: (field) => opts.setFocus(field),
    onBlur: (field) => {
      opts.setFocus(null);
      if (self?.lock?.field === field) opts.setLock(null);
    },
    onEdit: (field) => {
      if (self?.lock?.field !== field && !lockedByOther(map.get(field), opts.selfSessionId)) opts.setLock(field);
    },
    onTakeOver: (field) => opts.setLock(field),
  };
}

/** Badge beside a field label: who is looking at it. */
export function FieldFocusBadge({ info }: { info: FieldPresenceInfo | undefined }) {
  if (!info || info.focused.length === 0) return null;
  const names = info.focused.map(presenceName);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-200"
      title={`${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} on this field`}
      data-testid="field-focus-badge"
    >
      <Users className="h-3 w-3" />
      {names.length === 1 ? names[0] : `${names.length} people`}
    </span>
  );
}

/** Notice over a field someone else is editing, with "Take over". */
export function FieldLockNotice({ holder, onTakeOver }: { holder: PresenceEntry; onTakeOver: () => void }) {
  return (
    <div
      role="status"
      className="mb-1 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    >
      <Lock className="h-3 w-3" />
      <span className="flex-1">{presenceName(holder)} is editing this field.</span>
      <button type="button" onClick={onTakeOver} className="rounded border border-amber-400 px-1.5 py-0.5 font-medium hover:bg-amber-100 dark:hover:bg-amber-900">
        Take over
      </button>
    </div>
  );
}
