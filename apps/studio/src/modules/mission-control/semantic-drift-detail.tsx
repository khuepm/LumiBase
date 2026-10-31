import type { ContentDrift } from './api';

/**
 * Semantic drift provenance (Jev J12, #519). Renders only what the drift scan
 * recorded on the row — rule and profile versions, the review run, the model,
 * the revision and content hash, the answer and its threshold — and, for an
 * `unevaluated` row, the reason code as given. The decision model returns no
 * rationale, so none is shown or made up.
 */

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

function short(value: unknown, length = 12): string | null {
  const s = text(value);
  if (s === null) return null;
  return s.length > length ? `${s.slice(0, length)}…` : s;
}

export function isSemanticDrift(drift: ContentDrift): boolean {
  return drift.ruleType === 'semantic';
}

/** `rule@vN`, from the recorded detail; falls back to the stored rule key. */
export function semanticRuleLabel(drift: ContentDrift): string {
  const detail = drift.detail ?? {};
  const rule = text(detail['rule']);
  const version = text(detail['ruleVersion']);
  if (rule && version) return `${rule}@v${version}`;
  return drift.ruleKey.split(':')[0] ?? drift.ruleKey;
}

export function SemanticDriftDetail({ drift }: { drift: ContentDrift }) {
  const detail = drift.detail ?? {};
  const profileKey = text(detail['profileKey']);
  const profileVersion = text(detail['profileVersion']);
  const provider = text(detail['provider']);
  const model = text(detail['model']);
  const noul = typeof detail['noul'] === 'number' ? (detail['noul'] as number) : null;
  const threshold = typeof detail['threshold'] === 'number' ? (detail['threshold'] as number) : null;

  const rows: Array<[string, string | null]> = [
    ['Profile', profileKey ? `${profileKey}${profileVersion ? ` v${profileVersion}` : ''}` : null],
    ['Question', text(detail['questionKey'])],
    ['Context', text(detail['contextSource'])],
    ['Model', model ? (provider ? `${provider} / ${model}` : model) : null],
    ['Calibrated', text(detail['calibrated'])],
    ['Answer', noul !== null ? `${noul.toFixed(2)}${threshold !== null ? ` (threshold ${threshold})` : ''}` : null],
    ['Revision', short(detail['revisionId'])],
    ['Content', short(detail['contentHash'], 19)],
    ['Review run', short(detail['runId'])],
  ];
  const reason = text(detail['reason']);

  return (
    <div className="mt-1 w-full space-y-1">
      {drift.status === 'unevaluated' && (
        <p className="text-xs text-sky-900">
          Not evaluated{reason ? (
            <>
              {' '}
              — <code className="rounded bg-sky-50 px-1">{reason}</code>
            </>
          ) : null}
          . The drift state is unknown; earlier drift on this item is kept until a conclusive scan.
        </p>
      )}
      <dl className="grid grid-cols-1 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-2">
        {rows
          .filter((row): row is [string, string] => row[1] !== null)
          .map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}
