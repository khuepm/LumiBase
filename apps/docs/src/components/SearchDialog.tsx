import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, FileText } from 'lucide-react';
import { search, type SearchResult } from '../lib/search';
import { useLocale } from '../hooks/useLocale';

/**
 * SearchDialog — a modal search interface triggered by Cmd/Ctrl+K.
 *
 * Displays a search input and a list of results with highlighted snippets.
 * Navigating to a result uses client-side routing (no full page reload).
 *
 * Requirements: 7.2, 7.3, 7.4, 7.6
 */
export function SearchDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { locale } = useLocale();

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
  }, [query]);

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
    [navigate, closeDialog]
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
        className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent transition-colors"
        aria-label="Search documentation (Cmd+K)"
      >
        <Search className="h-4 w-4" />
        <span className="hidden sm:inline">Search…</span>
        <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 text-xs font-mono sm:inline-block">
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Search documentation"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50"
        onClick={closeDialog}
        aria-hidden="true"
      />

      {/* Dialog panel */}
      <div className="relative z-10 w-full max-w-lg rounded-lg border bg-background shadow-lg">
        {/* Search input */}
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search documentation…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Search query"
            aria-activedescendant={
              results.length > 0 ? `search-result-${selectedIndex}` : undefined
            }
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="search-results-list"
            aria-autocomplete="list"
          />
          <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
            Esc
          </kbd>
        </div>

        {/* Results list */}
        {results.length > 0 && (
          <ul
            id="search-results-list"
            role="listbox"
            className="max-h-80 overflow-y-auto p-2"
          >
            {results.map((result, index) => (
              <li
                key={result.slug}
                id={`search-result-${index}`}
                role="option"
                aria-selected={index === selectedIndex}
                className={`flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors ${index === selectedIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50'
                  }`}
                onClick={() => navigateToResult(result)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{result.title}</div>
                  <div
                    className="mt-0.5 text-xs text-muted-foreground line-clamp-2 [&_mark]:bg-yellow-200 [&_mark]:text-foreground [&_mark]:rounded-sm [&_mark]:px-0.5"
                    dangerouslySetInnerHTML={{ __html: result.snippet }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* No results message */}
        {query.trim().length >= 2 && results.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No results found for &ldquo;{query}&rdquo;
          </div>
        )}

        {/* Empty state hint */}
        {query.trim().length < 2 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            Type at least 2 characters to search
          </div>
        )}
      </div>
    </div>
  );
}
