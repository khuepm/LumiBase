import { useEffect, useRef, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';

/**
 * TM suggestion popover (translation-memory-ui Req 3.1, 3.2, 3.5). Given a
 * source string and a language pair, debounces a `/tm/lookup`, cancels the
 * in-flight request when the input changes, and offers a one-click Apply of the
 * best match (with similarity % + source badge).
 */

const DEBOUNCE_MS = 300;

interface Suggestion {
  entry: { id: string; targetText: string; sourceText: string; quality: number | null };
  score: number;
}

export interface TmSuggestPopoverProps {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  threshold?: number;
  onApply: (targetText: string) => void;
}

export function TmSuggestPopover({
  sourceText,
  sourceLang,
  targetLang,
  threshold,
  onApply,
}: TmSuggestPopoverProps) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const text = sourceText.trim();
    if (!text) {
      setSuggestion(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/v1/tm/lookup', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...(getActiveToken() ? { Authorization: `Bearer ${getActiveToken()}` } : {}),
            ...(getActiveSite() ? { 'x-site-id': getActiveSite()! } : {}),
          },
          body: JSON.stringify({ query: text, sourceLang, targetLang, threshold }),
        });
        const body = (await res.json().catch(() => ({}))) as { data?: { match: Suggestion | null } };
        setSuggestion(body.data?.match ?? null);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setSuggestion(null);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [sourceText, sourceLang, targetLang, threshold]);

  if (loading && !suggestion) {
    return <p className="mt-1 text-xs text-muted-foreground">Looking up translation memory…</p>;
  }
  if (!suggestion) return null;

  return (
    <div className="mt-1 flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-xs">
      <span className="flex items-center gap-2 truncate">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="truncate">{suggestion.entry.targetText}</span>
        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
          {Math.round(suggestion.score)}% · TM
        </span>
      </span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground"
        onClick={() => onApply(suggestion.entry.targetText)}
      >
        <Check className="h-3 w-3" />
        Apply
      </button>
    </div>
  );
}
