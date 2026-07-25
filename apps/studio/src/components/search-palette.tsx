import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search as SearchIcon, Loader2 } from 'lucide-react';
import { search, type SearchHit } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { getAdminBase } from '@/lib/admin-base';
import { cn } from '@/lib/cn';

/**
 * Content search palette. Distinct from the navigation command palette
 * (`command-palette.tsx`, ⌘K, "jump to a screen"): this one runs a
 * cross-collection full-text search against `GET /api/v1/search` and jumps to
 * the matching item editor. Opened from the TopBar search button or ⌘P.
 *
 * Search is diacritics-insensitive for Vietnamese (handled server-side), so
 * typing "ha noi" matches "Hà Nội" without any client-side normalization.
 */

const DEBOUNCE_MS = 300;
const RESULT_LIMIT = 20;

interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function SearchPalette({ open, onClose }: SearchPaletteProps) {
  const { t } = useTranslation('ui');
  const navigate = useNavigate();
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus when opened.
  useEffect(() => {
    if (open) {
      setQuery('');
      setDebounced('');
      setActiveIndex(0);
      // Defer focus until the input is mounted.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // Debounce the query feeding the search request.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['content-search', debounced],
    enabled: open && debounced.length > 0,
    queryFn: async () =>
      getApiClient().request(search(debounced, { limit: RESULT_LIMIT })),
    // Keep showing the previous results while the next query is in flight.
    placeholderData: (prev) => prev,
  });

  const hits: SearchHit[] = useMemo(() => data?.data ?? [], [data]);

  // Keep the active row in range as results change.
  useEffect(() => {
    setActiveIndex((i) => (hits.length === 0 ? 0 : Math.min(i, hits.length - 1)));
  }, [hits.length]);

  if (!open) return null;

  const go = (hit: SearchHit) => {
    const collection = hit._collection;
    const id = typeof hit.id === 'string' ? hit.id : String(hit.id ?? '');
    if (!collection || !id) return;
    onClose();
    navigate({ to: `${adminBase}/content/${collection}/${id}` });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[activeIndex];
      if (hit) go(hit);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        // Close when clicking the backdrop (not the panel).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('search_title', 'Search')}
        className="w-full max-w-xl overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search_placeholder', 'Search content…')}
            aria-label={t('search_placeholder', 'Search content…')}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {isFetching && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
        </div>

        <div className="max-h-[50vh] overflow-auto py-1" role="listbox">
          {debounced.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t('search_hint', 'Type to search across all content')}
            </p>
          ) : isError ? (
            <p className="px-4 py-6 text-center text-sm text-destructive">
              {t('search_error', 'Search is unavailable right now.')}
            </p>
          ) : hits.length === 0 && !isFetching ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {t('search_no_results', 'No results found')}
            </p>
          ) : (
            hits.map((hit, i) => {
              const id = typeof hit.id === 'string' ? hit.id : String(hit.id ?? '');
              return (
                <button
                  key={`${hit._collection}:${id}`}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => go(hit)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm',
                    i === activeIndex ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  <span className="truncate">{hit._title || id}</span>
                  {hit._collection && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {hit._collection}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
