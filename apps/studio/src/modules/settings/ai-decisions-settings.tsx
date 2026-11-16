import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Power, Save, ShieldCheck, Sparkles } from 'lucide-react';
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
 *
 * It also switches Flows decisions (`flows`, J10/J11) and semantic drift
 * (`drift`, J12), and shows Jev automation (`automation`, J11) read-only with
 * a **Return to shadow** action. Going live is not offered here: the gate
 * must cite a measured benchmark report (`evidenceRef`), so it stays a
 * deliberate settings-API write.
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
  flows?: unknown;
  drift?: unknown;
  automation?: unknown;
  [key: string]: unknown;
}

interface FormState {
  enabled: boolean;
  pilotEnabled: boolean;
  pilotCollections: string[];
  mode: PilotMode;
  flows: boolean;
  drift: boolean;
}

export interface AutomationSummary {
  /** The configured mode. `live` still needs a measured threshold per decision. */
  mode: 'shadow' | 'live';
  hasGate: boolean;
  /** Thresholds configured, per locale. */
  thresholds: Record<string, number>;
  /** A stored block the CMS cannot parse; the CMS then runs in shadow. */
  malformed: boolean;
}

const AUTOMATION_KEYS = new Set(['mode', 'thresholds', 'gate']);
const GATE_KEYS = ['approvedBy', 'approvedAt', 'evidenceRef'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads `aiDecisions.automation` for display. Mirrors the CMS's shape rules
 * (`automationSettingsSchema`): absent → shadow; any unknown key, a bad mode,
 * gate or thresholds shape → malformed, which the CMS runs as shadow. It
 * never reports live for a block the CMS would refuse on shape.
 */
export function summarizeAutomation(raw: unknown): AutomationSummary {
  const shadow: AutomationSummary = { mode: 'shadow', hasGate: false, thresholds: {}, malformed: false };
  if (raw === undefined || raw === null) return shadow;
  const malformed = { ...shadow, malformed: true };
  if (!isPlainObject(raw) || Object.keys(raw).some((k) => !AUTOMATION_KEYS.has(k))) return malformed;
  if (raw.mode !== undefined && raw.mode !== 'shadow' && raw.mode !== 'live') return malformed;
  const gate = raw.gate;
  if (gate !== undefined) {
    if (!isPlainObject(gate) || Object.keys(gate).length !== GATE_KEYS.length) return malformed;
    for (const key of GATE_KEYS) {
      const v = gate[key];
      if (typeof v !== 'string' || v.trim() === '') return malformed;
    }
    if (Number.isNaN(Date.parse(gate.approvedAt as string))) return malformed;
  }
  const thresholds: Record<string, number> = {};
  if (raw.thresholds !== undefined) {
    if (!isPlainObject(raw.thresholds)) return malformed;
    for (const [locale, actions] of Object.entries(raw.thresholds)) {
      if (!isPlainObject(actions)) return malformed;
      thresholds[locale] = Object.keys(actions).length;
    }
  }
  return { mode: raw.mode === 'live' ? 'live' : 'shadow', hasGate: gate !== undefined, thresholds, malformed: false };
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
    flows: stored?.flows === true,
    drift: stored?.drift === true,
  };
}

/** The value to store: the stored object with this page's fields replaced. */
export function mergeDecisionSettings(stored: Stored | null, form: FormState): Record<string, unknown> {
  return {
    ...(stored ?? {}),
    enabled: form.enabled,
    review: { enabled: form.pilotEnabled, pilotCollections: form.pilotCollections, mode: form.mode },
    // Written once set; an absent flag stays absent (the CMS reads it as off).
    ...(form.flows || stored?.flows !== undefined ? { flows: form.flows } : {}),
    ...(form.drift || stored?.drift !== undefined ? { drift: form.drift } : {}),
  };
}

function friendlyError(err: unknown): string {
  if (err instanceof LumiError && err.status === 403) return 'Changing AI decision settings requires site admin access.';
  return 'Failed to save AI decision settings.';
}

export function AiDecisionsSettingsPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const ids = { enabled: useId(), pilot: useId(), mode: useId(), flows: useId(), drift: useId() };

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
    mutationFn: async ({ next, automation }: { next: FormState; message: string; automation?: Record<string, unknown> }) =>
      client.settings.set(AI_DECISIONS_KEY, {
        ...mergeDecisionSettings(settingQuery.data ?? null, next),
        ...(automation ? { automation } : {}),
      }),
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

  // Keeps the gate and thresholds: only `mode` changes, so going live again
  // later is the same deliberate write it was before.
  const onReturnToShadow = () => {
    const raw = settingQuery.data?.automation;
    if (!isPlainObject(raw)) return;
    setSaved(null);
    setError(null);
    saveMutation.mutate({
      next: formFrom(settingQuery.data ?? null),
      automation: { ...raw, mode: 'shadow' },
      message: 'Automation is back in shadow. Thresholds and the gate record are kept.',
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
  const automation = summarizeAutomation(settingQuery.data?.automation);
  const thresholdText = Object.entries(automation.thresholds)
    .map(([locale, count]) => `${locale}: ${count}`)
    .join(', ');

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
              : 'Draft-review pilot is off.'}{' '}
            {`Flows decisions ${active.flows ? 'on' : 'off'}. Semantic drift ${active.drift ? 'on' : 'off'}.`}
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

          <section className="space-y-3 rounded-xl border bg-background p-5">
            <label htmlFor={ids.flows} className="flex items-start gap-3">
              <input
                id={ids.flows}
                type="checkbox"
                className="mt-1"
                checked={form.flows}
                onChange={(e) => setForm((prev) => ({ ...prev, flows: e.target.checked }))}
              />
              <span>
                <span className="block text-sm font-medium">Allow decisions in Flows</span>
                <span className="block text-xs text-muted-foreground">
                  Lets <code>ai:decision</code> nodes and Jev automation (tagging, review-queue routing) ask the
                  decision provider. Needs the switch above.
                </span>
              </span>
            </label>
            <label htmlFor={ids.drift} className="flex items-start gap-3">
              <input
                id={ids.drift}
                type="checkbox"
                className="mt-1"
                checked={form.drift}
                onChange={(e) => setForm((prev) => ({ ...prev, drift: e.target.checked }))}
              />
              <span>
                <span className="block text-sm font-medium">Evaluate semantic drift rules</span>
                <span className="block text-xs text-muted-foreground">
                  Lets Content Intent scans judge semantic rules. When off, those rules are reported as not
                  evaluated and existing drift is kept. Needs the switch above.
                </span>
              </span>
            </label>
          </section>

          <section className="space-y-2 rounded-xl border bg-background p-5" aria-labelledby={`${ids.flows}-automation`}>
            <h2 id={`${ids.flows}-automation`} className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Jev automation
            </h2>
            <p className="text-sm" data-testid="ai-automation-status">
              {automation.malformed
                ? 'Shadow: the stored automation settings cannot be read, so nothing is written.'
                : automation.mode === 'live'
                  ? 'Configured mode: live. Only decisions matching a measured threshold are proposed, and each becomes an approval.'
                  : 'Shadow: proposals are recorded, nothing is written.'}
            </p>
            {!automation.malformed && (
              <p className="text-xs text-muted-foreground">
                Gate record: {automation.hasGate ? 'present' : 'none'}. Thresholds: {thresholdText || 'none'}.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Going live needs a gate record citing a measured benchmark report, so it is set through the settings
              API, not here.
            </p>
            {automation.mode === 'live' && !automation.malformed && (
              <button
                type="button"
                onClick={onReturnToShadow}
                disabled={saveMutation.isPending}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
              >
                Return to shadow
              </button>
            )}
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
