import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { createPipeline } from './api';
import { recommendApproach } from './recommender';
import { CONNECTOR_LABELS } from './presentation';
import {
  CDC_CONNECTOR_TYPES,
  emptyPipelineForm,
  requiresIntermediaryConnection,
  toCreatePayload,
  usesSyncSchedule,
  validatePipelineForm,
  type PipelineFormErrors,
  type PipelineFormValues,
  type SyncMode,
} from './pipeline-form';
import type { CdcConnectorType } from './types';

type Step = 1 | 2 | 3;

/**
 * CDC pipeline creation wizard — a multi-step form with approach-specific
 * configuration fields (ClickHouse CDC — task 13.3; design "Studio CDC Panel"
 * §6).
 *
 * Steps:
 *   1. Approach — volume/latency inputs drive a live recommendation
 *      (Req 6.3, via {@link recommendApproach}); the operator picks a
 *      connector type.
 *   2. Connection — name, source/sink connections, replication tables, and
 *      approach-specific fields (Kafka URL, Airbyte API + sync schedule)
 *      (Req 6.2).
 *   3. Review — summary + create.
 *
 * Field-level validation (Req 6.7) is delegated entirely to the pure
 * {@link validatePipelineForm} in `./pipeline-form.ts`. Crucially, validation
 * NEVER resets the form — errors are stored separately and the entered values
 * are preserved, so a failed submit re-renders with everything the user typed
 * still in place.
 */
export function CdcPipelineWizardPage() {
  const [step, setStep] = useState<Step>(1);
  const [values, setValues] = useState<PipelineFormValues>(emptyPipelineForm);
  const [errors, setErrors] = useState<PipelineFormErrors>({});

  // Step-1 recommendation inputs (Req 6.3). Kept separate from the form
  // values since they only steer the suggestion, not the created pipeline.
  const [rowsPerSecond, setRowsPerSecond] = useState('1000');
  const [maxLatencySeconds, setMaxLatencySeconds] = useState('30');
  const [hasKafka, setHasKafka] = useState(false);
  const [preferManaged, setPreferManaged] = useState(false);

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const recommendation = useMemo(
    () =>
      recommendApproach({
        estimatedRowsPerSecond: Number.parseInt(rowsPerSecond, 10) || 0,
        maxLatencySeconds: Number.parseInt(maxLatencySeconds, 10) || 0,
        hasKafkaInfrastructure: hasKafka,
        preferManagedService: preferManaged,
      }),
    [rowsPerSecond, maxLatencySeconds, hasKafka, preferManaged],
  );

  const create = useMutation({
    mutationFn: () => createPipeline(toCreatePayload(values)),
    onSuccess: (pipeline) => {
      queryClient.invalidateQueries({ queryKey: ['cdc', 'pipelines'] });
      navigate({ to: '/cdc/$id', params: { id: pipeline.id } });
    },
  });

  // Helper to update a single field while preserving the rest (Req 6.7).
  function setField<K extends keyof PipelineFormValues>(
    key: K,
    value: PipelineFormValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
    // Clear that field's error optimistically; full re-validation runs on
    // step advance / submit. Other fields' errors are left untouched.
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  /** Validate before leaving the connection step or submitting (Req 6.7). */
  function runValidation(): boolean {
    const result = validatePipelineForm(values);
    setErrors(result.errors);
    return result.valid;
  }

  function goToReview() {
    if (runValidation()) setStep(3);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">New CDC pipeline</h1>
        <p className="text-sm text-muted-foreground">
          Step {step} of 3 —{' '}
          {step === 1 ? 'approach' : step === 2 ? 'connection' : 'review'}
        </p>
      </header>

      <ol className="flex gap-2">
        {([1, 2, 3] as const).map((s) => (
          <li
            key={s}
            className={`h-1 flex-1 rounded ${s <= step ? 'bg-primary' : 'bg-muted'}`}
          />
        ))}
      </ol>

      {step === 1 && (
        <ApproachStep
          rowsPerSecond={rowsPerSecond}
          maxLatencySeconds={maxLatencySeconds}
          hasKafka={hasKafka}
          preferManaged={preferManaged}
          connectorType={values.connectorType}
          recommendationType={recommendation.recommended}
          recommendationRationale={recommendation.rationale}
          onRowsChange={setRowsPerSecond}
          onLatencyChange={setMaxLatencySeconds}
          onKafkaChange={setHasKafka}
          onManagedChange={setPreferManaged}
          onSelectConnector={(t) => setField('connectorType', t)}
          error={errors.connectorType}
        />
      )}

      {step === 2 && (
        <ConnectionStep values={values} errors={errors} setField={setField} />
      )}

      {step === 3 && (
        <ReviewStep values={values} error={create.error} />
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={() =>
            step > 1 ? setStep((step - 1) as Step) : navigate({ to: '/cdc' })
          }
          className="rounded-md border px-4 py-2 text-sm"
        >
          {step === 1 ? 'Cancel' : 'Back'}
        </button>
        {step === 1 && (
          <button
            type="button"
            disabled={values.connectorType === ''}
            onClick={() => setStep(2)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Next
          </button>
        )}
        {step === 2 && (
          <button
            type="button"
            onClick={goToReview}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Review
          </button>
        )}
        {step === 3 && (
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create pipeline'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Step 1: approach + recommendation ─────────────────────────────────────

interface ApproachStepProps {
  rowsPerSecond: string;
  maxLatencySeconds: string;
  hasKafka: boolean;
  preferManaged: boolean;
  connectorType: CdcConnectorType | '';
  recommendationType: CdcConnectorType;
  recommendationRationale: string;
  onRowsChange: (v: string) => void;
  onLatencyChange: (v: string) => void;
  onKafkaChange: (v: boolean) => void;
  onManagedChange: (v: boolean) => void;
  onSelectConnector: (t: CdcConnectorType) => void;
  error?: string;
}

function ApproachStep(props: ApproachStepProps) {
  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            Estimated volume (rows/sec)
          </span>
          <input
            type="number"
            min={0}
            value={props.rowsPerSecond}
            onChange={(e) => props.onRowsChange(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            Max latency (seconds)
          </span>
          <input
            type="number"
            min={0}
            value={props.maxLatencySeconds}
            onChange={(e) => props.onLatencyChange(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={props.hasKafka}
            onChange={(e) => props.onKafkaChange(e.target.checked)}
          />
          <span className="text-sm">Kafka infrastructure available</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={props.preferManaged}
            onChange={(e) => props.onManagedChange(e.target.checked)}
          />
          <span className="text-sm">Prefer a managed service</span>
        </label>
      </div>

      {/* Live recommendation (Req 6.3). */}
      <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
        <p className="font-medium">
          Recommended: {CONNECTOR_LABELS[props.recommendationType]}
        </p>
        <p className="mt-1 text-muted-foreground">{props.recommendationRationale}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Connector type</legend>
        {CDC_CONNECTOR_TYPES.map((type) => (
          <label
            key={type}
            className="flex items-center gap-2 rounded-md border p-2 text-sm"
          >
            <input
              type="radio"
              name="connectorType"
              checked={props.connectorType === type}
              onChange={() => props.onSelectConnector(type)}
            />
            <span>{CONNECTOR_LABELS[type]}</span>
            {props.recommendationType === type && (
              <span className="ml-auto rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                recommended
              </span>
            )}
          </label>
        ))}
        {props.error && (
          <p role="alert" className="text-xs text-destructive">
            {props.error}
          </p>
        )}
      </fieldset>
    </div>
  );
}

// ── Step 2: connection + approach-specific fields ─────────────────────────

interface ConnectionStepProps {
  values: PipelineFormValues;
  errors: PipelineFormErrors;
  setField: <K extends keyof PipelineFormValues>(
    key: K,
    value: PipelineFormValues[K],
  ) => void;
}

function ConnectionStep({ values, errors, setField }: ConnectionStepProps) {
  function setTable(index: number, value: string) {
    const next = [...values.replicationTables];
    next[index] = value;
    setField('replicationTables', next);
  }
  function addTable() {
    setField('replicationTables', [...values.replicationTables, '']);
  }
  function removeTable(index: number) {
    const next = values.replicationTables.filter((_, i) => i !== index);
    setField('replicationTables', next.length > 0 ? next : ['']);
  }

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <TextField
        label="Pipeline name"
        value={values.pipelineName}
        onChange={(v) => setField('pipelineName', v)}
        error={errors.pipelineName}
        placeholder="analytics-replica"
      />

      <TextField
        label="Source database connection"
        value={values.sourceConnection}
        onChange={(v) => setField('sourceConnection', v)}
        error={errors.sourceConnection}
        placeholder="postgresql://user:pass@host:5432/db"
      />

      <TextField
        label="ClickHouse sink connection"
        value={values.sinkConnection}
        onChange={(v) => setField('sinkConnection', v)}
        error={errors.sinkConnection}
        placeholder="clickhouse://user:pass@host:8123/db"
      />

      {requiresIntermediaryConnection(values.connectorType) && (
        <TextField
          label={
            values.connectorType === 'debezium_kafka'
              ? 'Kafka broker connection'
              : 'Airbyte API connection'
          }
          value={values.intermediaryConnection}
          onChange={(v) => setField('intermediaryConnection', v)}
          error={errors.intermediaryConnection}
          placeholder={
            values.connectorType === 'debezium_kafka'
              ? 'kafka://host:9092'
              : 'https://airbyte.internal/api'
          }
        />
      )}

      {usesSyncSchedule(values.connectorType) && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Sync interval (seconds)"
            value={values.syncIntervalSeconds}
            onChange={(v) => setField('syncIntervalSeconds', v)}
            error={errors.syncIntervalSeconds}
            placeholder="300"
            type="number"
          />
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Sync mode</span>
            <select
              value={values.syncMode}
              onChange={(e) => setField('syncMode', e.target.value as SyncMode)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">Select…</option>
              <option value="incremental_cdc">Incremental (CDC)</option>
              <option value="full_refresh">Full refresh</option>
            </select>
            {errors.syncMode && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {errors.syncMode}
              </p>
            )}
          </label>
        </div>
      )}

      <div>
        <span className="mb-1 block text-sm font-medium">Replication tables</span>
        <div className="space-y-2">
          {values.replicationTables.map((table, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={table}
                onChange={(e) => setTable(i, e.target.value)}
                placeholder="public.users"
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
              <button
                type="button"
                onClick={() => removeTable(i)}
                className="rounded-md border px-3 text-sm text-muted-foreground hover:text-destructive"
                aria-label="Remove table"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addTable}
          className="mt-2 text-sm text-primary hover:underline"
        >
          + Add table
        </button>
        {errors.replicationTables && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {errors.replicationTables}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Step 3: review ────────────────────────────────────────────────────────

function ReviewStep({
  values,
  error,
}: {
  values: PipelineFormValues;
  error: unknown;
}) {
  const tables = values.replicationTables.filter((t) => t.trim().length > 0);
  return (
    <div className="space-y-3 rounded-lg border p-6 text-sm">
      <SummaryRow label="Name" value={values.pipelineName} />
      <SummaryRow
        label="Connector"
        value={
          values.connectorType === ''
            ? '—'
            : CONNECTOR_LABELS[values.connectorType]
        }
      />
      <SummaryRow label="Tables" value={tables.join(', ') || '—'} />
      {usesSyncSchedule(values.connectorType) && (
        <SummaryRow
          label="Sync"
          value={`${values.syncIntervalSeconds}s · ${values.syncMode || '—'}`}
        />
      )}
      {error != null && (
        <p role="alert" className="text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}:</span>{' '}
      <span className="font-medium">{value}</span>
    </div>
  );
}

// ── shared text field ─────────────────────────────────────────────────────

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  type?: 'text' | 'number';
}

function TextField({
  label,
  value,
  onChange,
  error,
  placeholder,
  type = 'text',
}: TextFieldProps) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={error ? 'true' : 'false'}
        className={`w-full rounded-md border bg-background px-3 py-2 text-sm ${error ? 'border-destructive' : ''
          }`}
      />
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </label>
  );
}
