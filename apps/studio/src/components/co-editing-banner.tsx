/**
 * CoEditingBanner — real-time warning shown when more than one person has the
 * same item open at once. Driven by the presence channel (usePresence): the
 * moment a second editor's `presence` message names this item, the banner
 * appears for everyone. It needs no extra backend.
 *
 * Purpose: prevent silent overwrites. The avatar stack (PresenceStack) alone is
 * easy to miss; this makes concurrent editing impossible to ignore.
 *
 * Presentational — the parent supplies the already-scoped co-editor list so a
 * single presence subscription feeds both the banner and the avatar stack.
 */

import { Users } from 'lucide-react';
import type { PresenceEntry } from '@/types/realtime';

interface CoEditingBannerProps {
  /** Peers on the *same* item, excluding self — de-duped by userId. */
  coEditors: PresenceEntry[];
}

/** Display name for a co-editor — prefers a `name`/`email` in meta, else userId. */
function editorLabel(peer: PresenceEntry): string {
  const meta = peer.meta ?? {};
  const name = meta.name ?? meta.email;
  return typeof name === 'string' && name.length > 0 ? name : peer.userId;
}

/** Join names into a natural-language list: "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function CoEditingBanner({ coEditors }: CoEditingBannerProps) {
  if (coEditors.length === 0) return null;

  const names = joinNames(coEditors.map(editorLabel));
  const plural = coEditors.length > 1;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"
    >
      <Users className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div>
        <p className="font-medium">
          {plural
            ? `${coEditors.length} other people are working on this item right now.`
            : `${names} is also working on this item right now.`}
        </p>
        <p className="mt-0.5 text-xs text-amber-700">
          {plural ? `${names} are here too. ` : ''}
          Saving may overwrite each other&rsquo;s changes — coordinate before you save.
        </p>
      </div>
    </div>
  );
}
