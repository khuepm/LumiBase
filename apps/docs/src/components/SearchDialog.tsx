import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import DOMPurify from 'dompurify';
import { search, type SearchResult } from '../lib/search';
import { useLocale } from '../hooks/useLocale';
import { useT } from '../hooks/useT';

/**
 * SearchDialog — a modal search interface triggered by Cmd/Ctrl+K.
 *
 * Displays a search input and a list of results with highlighted snippets.
 * Navigating to a result uses client-side routing (no full page reload).
 *
 * Styled after the LumiBase "dark cosmic" design system: glass pill trigger,
 * blurred overlay, dark panel with inset ring, planet-gradient result icons.
 *
 * Requirements: 7.2, 7.3, 7.4, 7.6
 */

/** Planet-gradient icon backgrounds (violet / blue / green), rotated deterministically. */
const PLANET_GRADIENTS = [
  'radial-gradient(circle at 32% 28%, #fff 0%, #7B61FF 60%, #26204a 100%)',
  'radial-gradient(circle at 32% 28%, #fff 0%, #18A0FB 60%, #123a52 100%)',
  'radial-gradient(circle at 32% 28%, #fff 0%, #2EC47C 60%, #12402c 100%)',
] as const;

/** Deterministically pick a planet gradient for a slug. */
function planetFor(slug: string): string {
  let sum = 0;
  for (let i = 0; i < slug.length; i++) {
    sum = (sum + slug.charCodeAt(i)) % PLANET_GRADIENTS.length;
  }
  return PLANET_GRADIENTS[sum]!;
}

export function SearchDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { locale } = useLocale();
  const t = useT();

  // Reset query and results when locale changes
  useEffect(() => {
    setQuery('');
    setResults([]);
    setSelectedIndex(0);
  }, [locale]);

  // Global keyboard shortcut: Cmd/Ctrl+K to open
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      // Close on Escape
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        closeDialog();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  // Focus input when dialog opens
  useEffect(() => {
    if (open) {
      // Small delay to ensure the dialog is rendered before focusing
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Run search when query changes
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    const searchResults = search(locale, query);
    setResults(searchResults);
    setSelectedIndex(0);
  }, [query, locale]);

  const closeDialog = useCallback(() => {
    setOpen(false);
    setQuery('');
    setResults([]);
    setSelectedIndex(0);
  }, []);

  const navigateToResult = useCallback(
    (result: SearchResult) => {
      navigate(`/${locale}/docs/${result.slug}`);
      closeDialog();
    },
    [navigate, closeDialog, locale]
  );

  // Handle keyboard navigation within results
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      const selected = results[selectedIndex];
      if (selected) navigateToResult(selected);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="glass-chip glass-chip-hover flex items-center gap-2 rounded-2xl px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Search documentation (Cmd+K)"
      >
        <Search className="h-[15px] w-[15px]" />
        <span className="hidden sm:inline">{t('search.placeholder')}</span>
        <kbd className="glass-chip hidden rounded-md px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground sm:ml-2 sm:inline-block">
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Search documentation"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[6px] dark:bg-[rgba(8,8,11,0.62)]"
        onClick={closeDialog}
        aria-hidden="true"
      />

      {/* Dialog panel */}
      <div className="relative z-10 w-[560px] max-w-[92vw] overflow-hidden rounded-[18px] bg-popover shadow-[var(--ring-glass-strong),0_32px_80px_-12px_rgba(0,0,0,0.35)] dark:shadow-[var(--ring-glass-strong),0_32px_80px_-12px_rgba(0,0,0,0.7)]">
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-border px-[18px] py-4">
          <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent text-base font-medium text-foreground outline-none placeholder:text-muted-foreground"
            aria-label="Search query"
            aria-activedescendant={
              results.length > 0 ? `search-result-${selectedIndex}` : undefined
            }
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="search-results-list"
            aria-autocomplete="list"
          />
          <kbd
            onClick={closeDialog}
            className="glass-chip cursor-pointer rounded-[7px] px-2 py-[3px] font-sans text-[11px] font-semibold text-muted-foreground"
          >
            Esc
          </kbd>
        </div>

        {/* Results list */}
        {results.length > 0 && (
          <ul
            id="search-results-list"
            role="listbox"
            className="max-h-80 overflow-y-auto p-2.5"
          >
            {results.map((result, index) => (
              <li
                key={result.slug}
                id={`search-result-${index}`}
                role="option"
                aria-selected={index === selectedIndex}
                className={`flex cursor-pointer items-center gap-3 rounded-[11px] px-3 py-[11px] transition-colors ${
                  index === selectedIndex ? 'bg-[var(--color-glass)]' : ''
                }`}
                onClick={() => navigateToResult(result)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <div
                  aria-hidden="true"
                  className="h-7 w-7 shrink-0 rounded-[9px]"
                  style={{ background: planetFor(result.slug) }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {result.title}
                  </div>
                  <div
                    className="mt-0.5 line-clamp-2 text-xs font-medium text-muted-foreground [&_mark]:rounded-sm [&_mark]:bg-primary/30 [&_mark]:px-0.5 [&_mark]:text-foreground [&_mark]:dark:text-white"
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(result.snippet) }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* No results message */}
        {query.trim().length >= 2 && results.length === 0 && (
          <div className="px-4 py-8 text-center text-sm font-medium text-muted-foreground">
            {t('search.no-results', { q: query })}
          </div>
        )}

        {/* Empty state hint */}
        {query.trim().length < 2 && (
          <div className="px-4 py-8 text-center text-sm font-medium text-muted-foreground">
            {t('search.min-chars')}
          </div>
        )}
      </div>
    </div>
  );
}
