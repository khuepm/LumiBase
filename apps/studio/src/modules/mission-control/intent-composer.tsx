import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { FillIcon } from '@/components/fill-icon';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { missionControlApi } from './api';

/**
 * Intent composer v2 (content-os-ui task 12; Req 11.1-11.6) — the primary
 * CTA of Mission Control: describe the desired state, review the compiled
 * rules as STRUCTURED CARDS (one editor per intent-rule.v1 type), tune the
 * metadata, then confirm. Compilation never auto-activates (content-os
 * Req 5.5). A raw-JSON toggle remains as the secondary escape hatch.
 *
 * v2 also fixes the v1 contract bug: the compile route validates
 * `{description, collection}`; v1 sent `{text}` and could never compile.
 */

const RULE_TYPES = [
  'required_fields',
  'freshness',
  'translations',
  'link_health',
  'field_constraint',
  'glossary_compliance',
] as const;
type RuleType = (typeof RULE_TYPES)[number];

type RuleDraft = { type: RuleType } & Record<string, unknown>;

const RULE_DEFAULTS: Record<RuleType, RuleDraft> = {
  required_fields: { type: 'required_fields', fields: ['title'] },
  freshness: { type: 'freshness', maxAgeDays: 90 },
  translations: { type: 'translations', locales: ['en'] },
  link_health: { type: 'link_health' },
  field_constraint: { type: 'field_constraint', field: 'title', maxLength: 160 },
  glossary_compliance: { type: 'glossary_compliance' },
};

const LEVEL_LABELS = ['L0 shadow', 'L1 propose', 'L2 co-sign', 'L3 veto-window', 'L4 autopilot'];

const DEFAULT_BUDGET = { maxGoalsPerCycle: 10, maxWritesPerMinute: 60, maxCostUsd: 1 };

const parseList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const joinList = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');

function ListInput({
  label,
  value,
  onChange,
  optional,
}: {
  label: string;
  value: unknown;
  onChange: (list: string[]) => void;
  optional?: boolean;
}) {
  return (
    <label className="block text-xs text-muted-foreground">
      {label} {optional && <span className="opacity-60">(optional, comma separated)</span>}
      <input
        defaultValue={joinList(value)}
        onChange={(e) => onChange(parseList(e.target.value))}
        className="mt-0.5 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  optional,
}: {
  label: string;
  value: unknown;
  onChange: (n: number | undefined) => void;
  optional?: boolean;
}) {
  return (
    <label className="block text-xs text-muted-foreground">
      {label} {optional && <span className="opacity-60">(optional)</span>}
      <input
        type="number"
        defaultValue={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className="mt-0.5 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function TextInput({
  label,
  value,
  onChange,
  optional,
}: {
  label: string;
  value: unknown;
  onChange: (s: string | undefined) => void;
  optional?: boolean;
}) {
  return (
    <label className="block text-xs text-muted-foreground">
      {label} {optional && <span className="opacity-60">(optional)</span>}
      <input
        defaultValue={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="mt-0.5 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
      />
    </label>
  );
}

/** One structured editor per intent-rule.v1 type (Req 11.2). */
function RuleCard({
  rule,
  onChange,
  onRemove,
}: {
  rule: RuleDraft;
  onChange: (next: RuleDraft) => void;
  onRemove: () => void;
}) {
  const set = (patch: Record<string, unknown>) => onChange({ ...rule, ...patch });

  return (
    <li className="rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-medium">
          {rule.type}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${rule.type} rule`}
          className="rounded-md border p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rule.type === 'required_fields' && (
          <ListInput label="Fields" value={rule.fields} onChange={(fields) => set({ fields })} />
        )}
        {rule.type === 'freshness' && (
          <NumberInput
            label="Max age (days)"
            value={rule.maxAgeDays}
            onChange={(maxAgeDays) => set({ maxAgeDays })}
          />
        )}
        {rule.type === 'translations' && (
          <>
            <ListInput label="Locales" value={rule.locales} onChange={(locales) => set({ locales })} />
            <ListInput
              label="Fields"
              value={rule.fields}
              optional
              onChange={(fields) => set({ fields: fields.length ? fields : undefined })}
            />
          </>
        )}
        {rule.type === 'link_health' && (
          <ListInput
            label="Fields"
            value={rule.fields}
            optional
            onChange={(fields) => set({ fields: fields.length ? fields : undefined })}
          />
        )}
        {rule.type === 'field_constraint' && (
          <>
            <TextInput label="Field" value={rule.field} onChange={(field) => set({ field })} />
            <NumberInput
              label="Min length"
              value={rule.minLength}
              optional
              onChange={(minLength) => set({ minLength })}
            />
            <NumberInput
              label="Max length"
              value={rule.maxLength}
              optional
              onChange={(maxLength) => set({ maxLength })}
            />
            <TextInput
              label="Pattern"
              value={rule.pattern}
              optional
              onChange={(pattern) => set({ pattern })}
            />
          </>
        )}
        {rule.type === 'glossary_compliance' && (
          <>
            <TextInput
              label="Glossary"
              value={rule.glossary}
              optional
              onChange={(glossary) => set({ glossary })}
            />
            <ListInput
              label="Fields"
              value={rule.fields}
              optional
              onChange={(fields) => set({ fields: fields.length ? fields : undefined })}
            />
          </>
        )}
      </div>
    </li>
  );
}

export function IntentComposer({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [collection, setCollection] = useState('');
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('0 6 * * *');
  const [autonomyCap, setAutonomyCap] = useState(2);
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  const collectionsQuery = useQuery({
    queryKey: ['mc-collections'],
    queryFn: async () => (await getApiClient().schema.listCollections()).data,
    retry: false,
  });

  const payload = () => ({ name, collection, rules, schedule, autonomyCap, budget });

  const compileMutation = useMutation({
    mutationFn: () => missionControlApi.compileIntent(description.trim(), collection),
    onSuccess: (data) => {
      setRules((data.rules ?? []) as RuleDraft[]);
      if (data.schedule) setSchedule(data.schedule);
      setWarnings(data.warnings ?? []);
      if (!name) setName(`${collection}: ${description.trim().slice(0, 80)}`);
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const body = rawMode ? (JSON.parse(rawJson) as Record<string, unknown>) : payload();
      return missionControlApi.createIntent(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mc-intents'] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Raw JSON is the secondary path (Req 11.5): entering serializes the form,
  // leaving parses it back — invalid JSON keeps you in raw mode with the error.
  const toggleRaw = () => {
    if (!rawMode) {
      setRawJson(JSON.stringify(payload(), null, 2));
      setRawMode(true);
      return;
    }
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      setName(String(parsed.name ?? ''));
      setCollection(String(parsed.collection ?? ''));
      setSchedule(String(parsed.schedule ?? '0 6 * * *'));
      setAutonomyCap(Number(parsed.autonomyCap ?? 2));
      if (parsed.budget) setBudget(parsed.budget as typeof DEFAULT_BUDGET);
      setRules((Array.isArray(parsed.rules) ? parsed.rules : []) as RuleDraft[]);
      setRawMode(false);
      setError(null);
    } catch {
      setError('Raw JSON is not valid — fix it or stay in raw mode.');
    }
  };

  const addRule = (type: RuleType) => setRules((rs) => [...rs, { ...RULE_DEFAULTS[type] }]);

  const canConfirm = rawMode
    ? rawJson.trim().length > 0
    : Boolean(name.trim() && collection && rules.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border bg-background p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-base font-semibold">
            <FillIcon icon={Sparkles} className="h-4 w-4 text-primary" /> Compose a content intent
          </h2>
          <button
            type="button"
            onClick={toggleRaw}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
              rawMode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            <Braces className="h-3 w-3" /> {rawMode ? 'Back to form' : 'Raw JSON'}
          </button>
        </div>

        {error && (
          <p className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {rawMode ? (
          <textarea
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            rows={16}
            aria-label="Raw intent JSON"
            className="w-full rounded-md border bg-background p-2 font-mono text-xs"
          />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_14rem]">
              <label className="block text-xs font-medium text-muted-foreground">
                Describe the desired state of your content
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder='e.g. "All published articles must have a meta description and be fresher than 90 days."'
                  className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                Collection
                {collectionsQuery.isError ? (
                  <input
                    value={collection}
                    onChange={(e) => setCollection(e.target.value)}
                    placeholder="collection name"
                    className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
                  />
                ) : (
                  <select
                    value={collection}
                    onChange={(e) => setCollection(e.target.value)}
                    className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
                  >
                    <option value="">Select…</option>
                    {(collectionsQuery.data ?? []).map((c: { name: string; label?: string | null }) => (
                      <option key={c.name} value={c.name}>
                        {c.label ?? c.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            </div>

            <button
              type="button"
              onClick={() => compileMutation.mutate()}
              disabled={!description.trim() || !collection || compileMutation.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {compileMutation.isPending ? 'Compiling…' : 'Compile to rules'}
            </button>

            {warnings.length > 0 && (
              <ul className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                {warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">Rules</h3>
                <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Plus className="h-3 w-3" /> Add rule
                  <select
                    value=""
                    aria-label="Add rule"
                    onChange={(e) => e.target.value && addRule(e.target.value as RuleType)}
                    className="rounded-md border bg-background px-1 py-0.5 text-xs"
                  >
                    <option value="">type…</option>
                    {RULE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {rules.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Compile from the description above, or add rules by hand.
                </p>
              ) : (
                <ul className="space-y-2">
                  {rules.map((rule, i) => (
                    <RuleCard
                      key={i}
                      rule={rule}
                      onChange={(next) => setRules((rs) => rs.map((r, j) => (j === i ? next : r)))}
                      onRemove={() => setRules((rs) => rs.filter((_, j) => j !== i))}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-muted-foreground">
                Name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
                />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                Schedule (cron)
                <input
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-2 font-mono text-sm"
                />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                Autonomy cap — {LEVEL_LABELS[autonomyCap]}
                <input
                  type="range"
                  min={0}
                  max={4}
                  value={autonomyCap}
                  onChange={(e) => setAutonomyCap(Number(e.target.value))}
                  className="mt-2 w-full"
                />
              </label>
              <div className="grid grid-cols-3 gap-2">
                <NumberInput
                  label="Goals/cycle"
                  value={budget.maxGoalsPerCycle}
                  onChange={(n) => setBudget((b) => ({ ...b, maxGoalsPerCycle: n ?? b.maxGoalsPerCycle }))}
                />
                <NumberInput
                  label="Writes/min"
                  value={budget.maxWritesPerMinute}
                  onChange={(n) => setBudget((b) => ({ ...b, maxWritesPerMinute: n ?? b.maxWritesPerMinute }))}
                />
                <NumberInput
                  label="Max $"
                  value={budget.maxCostUsd}
                  onChange={(n) => setBudget((b) => ({ ...b, maxCostUsd: n ?? b.maxCostUsd }))}
                />
              </div>
            </section>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={!canConfirm || createMutation.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {createMutation.isPending ? 'Creating…' : 'Confirm & create intent'}
          </button>
        </div>
      </div>
    </div>
  );
}
