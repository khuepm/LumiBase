import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import type { ReviewPilotMode, ReviewRollout, ReviewSessionRequest } from '@lumibase/contracts/schemas';
import { getApiClient } from '@/lib/api';

/**
 * Draft-review pilot wiring for the editor (Jev J09, #516).
 *
 * `useReviewRollout` reads the collection's pilot mode from the CMS. Anything
 * but an explicit `assisted` hides the review panel — including loading and
 * errors — so a disabled pilot, a missing `ai:decide` grant or an older CMS
 * all leave the plain editor.
 *
 * `useReviewSession` measures one session: from opening the editor to the
 * first successful save. It is recorded in both `baseline` (panel hidden) and
 * `assisted` mode, and never when the mode is `off`. Recording is best effort:
 * a failure never blocks or fails the save.
 */

export type ReviewRolloutMode = ReviewPilotMode | 'off';

const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function useReviewRollout(collection: string): ReviewRolloutMode {
  const query = useQuery({
    queryKey: ['review-rollout', collection],
    queryFn: async () =>
      (
        await getApiClient().rawRequest<ReviewRollout>(
          `/api/v1/ai/reviews/rollout?collection=${encodeURIComponent(collection)}`,
        )
      ).data,
    retry: false,
    staleTime: 60_000,
  });
  const mode = query.data?.mode;
  return mode === 'baseline' || mode === 'assisted' ? mode : 'off';
}

export interface ReviewSessionTracker {
  /** The suggestions of `runId` that were rendered to the editor (assisted). */
  markViewed: (runId: string, questionKeys: string[]) => void;
  /** Call after the first successful save. Later calls are ignored. */
  finish: (itemId: string | undefined) => void;
}

export function useReviewSession({
  collection,
  mode,
  locale,
}: {
  collection: string;
  mode: ReviewRolloutMode;
  locale: string | undefined;
}): ReviewSessionTracker {
  const startedAt = useRef<number>(Date.now());
  const viewed = useRef<{ runId: string; questionKeys: string[] } | null>(null);
  const done = useRef(false);
  const latest = useRef({ collection, mode, locale });
  latest.current = { collection, mode, locale };

  // A new collection is a new editor: restart the clock.
  useEffect(() => {
    startedAt.current = Date.now();
    viewed.current = null;
    done.current = false;
  }, [collection]);

  const markViewed = useCallback((runId: string, questionKeys: string[]) => {
    viewed.current = { runId, questionKeys };
  }, []);

  const finish = useCallback((itemId: string | undefined) => {
    const { collection: name, mode: current, locale: lang } = latest.current;
    if (done.current || current === 'off') return;
    done.current = true;
    const view = current === 'assisted' ? viewed.current : null;
    const body: ReviewSessionRequest = {
      collection: name,
      mode: current,
      durationMs: Math.max(0, Math.round(Date.now() - startedAt.current)),
      ...(itemId ? { itemId } : {}),
      ...(view ? { runId: view.runId, viewedQuestions: view.questionKeys } : {}),
      // Same shape the CMS accepts; anything else is dropped rather than failing the session.
      ...(lang && LOCALE.test(lang) ? { locale: lang } : {}),
    };
    void getApiClient()
      .rawRequest('/api/v1/ai/reviews/sessions', { method: 'POST', body: JSON.stringify(body) })
      .catch(() => undefined);
  }, []);

  return { markViewed, finish };
}
