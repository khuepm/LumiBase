import { useMutation, useQuery } from '@tanstack/react-query';
import { Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TM_DEFAULT_THRESHOLD } from '@lumibase/shared';
import type { TmSource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Translation-memory suggestion popover for a single target-locale field.
 *
 * Given the source text + language pair, it debounces a `/tm/lookup` and, if a
 * match ≥ threshold exists, offers a one-click Apply. When there is no match it
 * offers Auto-translate (`/tm/translate`, the full TM→glossary→MT pipeline).
 * Applying reports back the chosen text + its origin so the editor can mark the
 * field for learn-on-save (human) vs machine (mt).
 */
export function TmSuggestPopover({
  sourceText,
  sourceLang,
  targetLang,
  threshold = TM_DEFAULT_THRESHOLD,
  onApply,
}: {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  threshold?: number;
  onApply: (text: string, source: TmSource) => void;
}) {
  const client = getApiClient();
  const trimmed = sourceText.trim();

  // Debounce the source text so typing doesn't spam the lookup. The debounced
  // value drives the query key, so React Query drops in-flight stale requests.
  const [debounced, setDebounced] = useState(trimmed);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(trimmed), 300);
    return () => clearTimeout(t);
  }, [trimmed]);

  const canLookup = debounced.length > 0 && sourceLang !== targetLang;

  const lookup = useQuery({
    queryKey: ['tm-lookup', sourceLang, targetLang, threshold, debounced],
    enabled: canLookup,
    queryFn: () =>
      client.tm.lookup({ query: debounced, sourceLang, targetLang, threshold }),
  });

  const autoTranslate = useMutation({
    mutationFn: async () => {
      const res = await client.tm.translate({ text: trimmed, from: sourceLang, to: targetLang });
      return res.data.text;
    },
    onSuccess: (text) => onApply(text, 'mt'),
  });

  if (!canLookup) return null;

  const suggestion = lookup.data;

  return (
    <div className="mt-1 rounded-md border bg-muted/20 p-2 text-xs" data-testid="tm-suggest">
      {lookup.isFetching ? (
        <p className="text-muted-foreground">Looking up translation memory…</p>
      ) : suggestion ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            <span className="flex-1 truncate font-medium" title={suggestion.targetText}>
              {suggestion.targetText}
            </span>
            <SourceBadge source={suggestion.source} />
            <span className="tabular-nums text-muted-foreground">{suggestion.similarity}%</span>
            <button
              type="button"
              onClick={() => onApply(suggestion.targetText, 'human')}
              className="rounded bg-primary px-2 py-0.5 font-medium text-primary-foreground hover:opacity-90"
            >
              Apply
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">No TM match ≥ {threshold}%.</span>
          <button
            type="button"
            onClick={() => autoTranslate.mutate()}
            disabled={autoTranslate.isPending}
            className="inline-flex items-center gap-1 rounded border px-2 py-0.5 font-medium hover:bg-muted disabled:opacity-50"
          >
            <Wand2 className="h-3.5 w-3.5" />
            {autoTranslate.isPending ? 'Translating…' : 'Auto-translate'}
          </button>
        </div>
      )}
      {autoTranslate.isError && (
        <p className="mt-1 text-destructive">Auto-translate failed.</p>
      )}
    </div>
  );
}

function SourceBadge({ source }: { source: TmSource }) {
  const label = source === 'human' ? 'human' : source === 'mt' ? 'MT' : 'imported';
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
        source === 'human' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        source === 'mt' && 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
        source === 'imported' && 'bg-muted text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
}
