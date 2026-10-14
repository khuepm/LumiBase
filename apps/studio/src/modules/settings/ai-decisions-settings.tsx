import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Power, Save, Sparkles } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { LumiError } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';

/**
 * Settings → AI decisions (Jev J09, #516). A site admin opts the site in to
 * sending content to the decision provider and runs the draft-review pilot:
 * which collections take part and whether they are measured in `baseline`
 * (panel hidden, editor time only) or `assisted` (panel shown) mode.
 *
 * Everything is the existing `aiDecisions` site setting, written through the
 * settings API. Fields this page does not edit (`allowedStateFields`, quota
 * overrides) are kept as stored. The kill switch turns decisions and the pilot
 * off in one write; it deletes no review run, feedback or session.
 */

export const AI_DECISIONS_KEY = 'aiDecisions';

/**
 * The server caps `review.pilotCollections` at 100. A longer list makes the
 * whole `aiDecisions` value malformed, which reads as "decisions off", so the
 * page refuses it instead of saving a value that silently disables the site.
 */
export const MAX_PILOT_COLLECTIONS = 100;

type PilotMode = 'baseline' | 'assisted';

interface Stored {
  enabled?: unknown;
  review?: { enabled?: unknown; pilotCollections?: unknown; mode?: unknown };
  [key: string]: unknown;
}

interface FormState {
  enabled: boolean;
  pilotEnabled: boolean;
  pilotCollections: string[];
  mode: PilotMode;
}

function formFrom(stored: Stored | null): FormState {
  const review = stored?.review ?? {};
  return {
    enabled: stored?.enabled === true,
    pilotEnabled: review.enabled === true,
    pilotCollections: Array.isArray(review.pilotCollections)
      ? review.pilotCollections.filter((c): c is string => typeof c === 'string')
      : [],
    mode: review.mode === 'assisted' ? 'assisted' : 'baseline',
  };
}

/** The value to store: the stored object with this page's fields replaced. */
export function mergeDecisionSettings(stored: Stored | null, form: FormState): Record<string, unknown> {
  return {
    ...(stored ?? {}),
    enabled: form.enabled,
    review: { enabled: form.pilotEnabled, pilotCollections: form.pilotCollections, mode: form.mode },
  };
}

function friendlyError(err: unknown): string {
  if (err instanceof LumiError && err.status === 403) return 'Changing AI decision settings requires site admin access.';
  return 'Failed to save AI decision settings.';
}

export function AiDecisionsSettingsPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const ids = { enabled: useId(), pilot: useId(), mode: useId() };

  const settingQuery = useQuery({
    queryKey: ['settings', AI_DECISIONS_KEY],
    queryFn: async () => {
      try {
        return ((await client.settings.get(AI_DECISIONS_KEY)).data?.value ?? null) as Stored | null;
      } catch (err) {
        if (err instanceof LumiError && err.status === 404) return null;
        throw err;
      }
    },
  });
  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });

  const [form, setForm] = useState<FormState>(formFrom(null));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (settingQuery.data !== undefined) setForm(formFrom(settingQuery.data));
  }, [settingQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async ({ next }: { next: FormState; message: string }) =>
      client.settings.set(AI_DECISIONS_KEY, mergeDecisionSettings(settingQuery.data ?? null, next)),
    onSuccess: (_res, { next, message }) => {
      setError(null);
      setSaved(message);
      setForm(next);
      void qc.invalidateQueries({ queryKey: ['settings', AI_DECISIONS_KEY] });
      void qc.invalidateQueries({ queryKey: ['review-rollout'] });
    },
    onError: (err) => {
      setSaved(null);
      setError(friendlyError(err));
    },
  });

  const collections = (collectionsQuery.data ?? []).filter((c) => !c.system && !c.name.startsWith('lumibase_'));

  const onSave = () => {
    setSaved(null);
    if (form.pilotEnabled && form.pilotCollections.length === 0) {
      setError('Choose at least one pilot collection, or turn the pilot off.');
      return;
    }
    if (form.pilotCollections.length > MAX_PILOT_COLLECTIONS) {
      setError(`Choose at most ${MAX_PILOT_COLLECTIONS} pilot collections.`);
      return;
    }
    setError(null);
    saveMutation.mutate({ next: form, message: 'Settings saved.' });
  };

  // Built from the stored value, not the form: unsaved collection or mode
  // edits are discarded, so the stored list and mode are kept as they were.
  const onKillSwitch = () => {
    setSaved(null);
    setError(null);
    saveMutation.mutate({
      next: { ...formFrom(settingQuery.data ?? null), enabled: false, pilotEnabled: false },
      message: 'Decisions and the pilot are off. Existing reviews, feedback and sessions are kept.',
    });
  };

  const toggleCollection = (name: string) =>
    setForm((prev) => {
      if (prev.pilotCollections.includes(name)) {
        return { ...prev, pilotCollections: prev.pilotCollections.filter((c) => c !== name) };
      }
      if (prev.pilotCollections.length >= MAX_PILOT_COLLECTIONS) return prev;
      return { ...prev, pilotCollections: [...prev.pilotCollections, name] };
    });
  const atCap = form.pilotCollections.length >= MAX_PILOT_COLLECTIONS;

  const active = settingQuery.data ? formFrom(settingQuery.data) : formFrom(null);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
          <Sparkles className="h-7 w-7" aria-hidden="true" /> AI decisions
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Opt this site in to the decision model and run the draft-review pilot. Reviews only
          suggest; editors still save and publish themselves.
        </p>
      </header>

      {settingQuery.isLoading ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : settingQuery.isError ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Could not load the AI decision settings.
        </div>
      ) : (
        <>
          <p role="status" className="text-sm" data-testid="ai-decisions-status">
            {active.enabled ? 'Decisions are on.' : 'Decisions are off.'}{' '}
            {active.pilotEnabled && active.pilotCollections.length > 0
              ? `Draft-review pilot: ${active.mode} on ${active.pilotCollections.join(', ')}.`
              : 'Draft-review pilot is off.'}
          </p>

          <section className="space-y-2 rounded-xl border bg-background p-5">
            <label htmlFor={ids.enabled} className="flex items-start gap-3">
              <input
                id={ids.enabled}
                type="checkbox"
                className="mt-1"
                checked={form.enabled}
                onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
              />
              <span>
                <span className="block text-sm font-medium">Send content to the decision provider</span>
                <span className="block text-xs text-muted-foreground">
                  Needed for assisted reviews. Only the fields a review profile lists are sent, read with the
                  editor&apos;s own permissions.
                </span>
              </span>
            </label>
          </section>

          <section className="space-y-3 rounded-xl border bg-background p-5">
            <label htmlFor={ids.pilot} className="flex items-start gap-3">
              <input
                id={ids.pilot}
                type="checkbox"
                className="mt-1"
                checked={form.pilotEnabled}
                onChange={(e) => setForm((prev) => ({ ...prev, pilotEnabled: e.target.checked }))}
              />
              <span>
                <span className="block text-sm font-medium">Run the draft-review pilot</span>
                <span className="block text-xs text-muted-foreground">
                  Times each editor session (open → first save) on the chosen collections.
                </span>
              </span>
            </label>

            <div>
              <label htmlFor={ids.mode} className="block text-xs font-medium text-muted-foreground">
                Mode
              </label>
              <select
                id={ids.mode}
                value={form.mode}
                onChange={(e) => setForm((prev) => ({ ...prev, mode: e.target.value as PilotMode }))}
                className="mt-1 rounded-md border bg-background px-2 py-1 text-sm"
              >
                <option value="baseline">Baseline — panel hidden, editor time only</option>
                <option value="assisted">Assisted — panel shown, reviews run</option>
              </select>
            </div>

            <fieldset>
              <legend className="text-xs font-medium text-muted-foreground">
                Pilot collections ({form.pilotCollections.length}/{MAX_PILOT_COLLECTIONS})
              </legend>
              {atCap && (
                <p className="text-xs text-muted-foreground">
                  The pilot takes at most {MAX_PILOT_COLLECTIONS} collections. Untick one to add another.
                </p>
              )}
              {collectionsQuery.isError ? (
                <p className="text-xs text-destructive">Could not load collections.</p>
              ) : collections.length === 0 ? (
                <p className="text-xs text-muted-foreground">No collections yet.</p>
              ) : (
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  {collections.map((c) => (
                    <label key={c.name} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.pilotCollections.includes(c.name)}
                        disabled={atCap && !form.pilotCollections.includes(c.name)}
                        onChange={() => toggleCollection(c.name)}
                      />
                      {c.label ?? c.name}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          </section>

          {error && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {saved && (
            <p role="status" className="text-sm text-emerald-700">
              {saved}
            </p>
          )}

          <div className="flex flex-wrap justify-between gap-2">
            <button
              type="button"
              onClick={onKillSwitch}
              disabled={saveMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md border border-destructive/50 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              <Power className="h-4 w-4" aria-hidden="true" /> Turn everything off
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saveMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-4 w-4" aria-hidden="true" /> {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
