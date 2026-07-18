import { useQuery } from '@tanstack/react-query';
import { Bookmark, ChevronDown, Globe, RotateCcw, User, Users } from 'lucide-react';
import { useState } from 'react';
import { listBookmarks, type PresetScope, type ScopedViewPreset } from './api';

/**
 * Bookmark switcher for a collection view (presets-inheritance Req 5.1, 3.3,
 * 2.4). Lists the bookmarks visible to the current principal — own, role-chain,
 * and global — each tagged with its scope, plus "Default view" and "Reset to
 * default" actions.
 */

const SCOPE_META: Record<PresetScope, { label: string; Icon: typeof User }> = {
  user: { label: 'You', Icon: User },
  role: { label: 'Role', Icon: Users },
  global: { label: 'Global', Icon: Globe },
};

export interface BookmarkSwitcherProps {
  collection: string;
  activeBookmarkId?: string | null;
  onSelectDefault: () => void;
  onSelectBookmark: (preset: ScopedViewPreset) => void;
  onResetToDefault: () => void;
}

export function BookmarkSwitcher({
  collection,
  activeBookmarkId,
  onSelectDefault,
  onSelectBookmark,
  onResetToDefault,
}: BookmarkSwitcherProps) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['preset-bookmarks', collection],
    queryFn: () => listBookmarks(collection),
  });

  const bookmarks = query.data ?? [];
  const active = bookmarks.find((b) => b.id === activeBookmarkId);
  const label = active?.bookmark ?? 'Default view';

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Bookmark className="h-4 w-4" />
        <span className="max-w-[10rem] truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>

      {open && (
        <div
          className="absolute z-20 mt-1 w-64 rounded-md border bg-popover p-1 shadow-md"
          role="listbox"
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
            onClick={() => {
              onSelectDefault();
              setOpen(false);
            }}
          >
            <Bookmark className="h-4 w-4 opacity-60" />
            Default view
          </button>

          {bookmarks.length > 0 && <div className="my-1 h-px bg-border" />}

          {bookmarks.map((b) => {
            const meta = SCOPE_META[b.sourceScope];
            return (
              <button
                key={b.id}
                type="button"
                role="option"
                aria-selected={b.id === activeBookmarkId}
                className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted ${
                  b.id === activeBookmarkId ? 'bg-muted' : ''
                }`}
                onClick={() => {
                  onSelectBookmark(b);
                  setOpen(false);
                }}
              >
                <span className="flex items-center gap-2 truncate">
                  <Bookmark className="h-4 w-4 opacity-60" />
                  <span className="truncate">{b.bookmark}</span>
                </span>
                <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  <meta.Icon className="h-3 w-3" />
                  {meta.label}
                </span>
              </button>
            );
          })}

          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted"
            onClick={() => {
              onResetToDefault();
              setOpen(false);
            }}
          >
            <RotateCcw className="h-4 w-4" />
            Reset to default
          </button>
        </div>
      )}
    </div>
  );
}
