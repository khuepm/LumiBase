import { type Change, diffFields } from '@lumibase/contracts';
import { useMemo } from 'react';

interface RevisionsDiffProps {
  before: Record<string, unknown> | null | undefined;
  after: Record<string, unknown> | null | undefined;
  /** Show fields whose before/after are equal (default: hidden). */
  showUnchanged?: boolean;
}

/**
 * Per-field diff between two `data` snapshots from a revision delta.
 *
 * Comparison is shallow over the top-level keys — that matches how the
 * revision engine records changes (each top-level field is the unit of
 * `meta.options.fields` in the schema). Nested objects are stringified for
 * the visual diff; authors who need a deeper view can flip the panel back
 * to raw JSON.
 */
export function RevisionsDiff({ before, after, showUnchanged }: RevisionsDiffProps) {
  const changes = useMemo(() => diffFields(before, after), [before, after]);

  const visible = showUnchanged ? changes : changes.filter((c) => c.state !== 'unchanged');
  if (visible.length === 0) {
    return <p className="text-sm text-muted-foreground">No field changes recorded.</p>;
  }

  return (
    <div className="space-y-2">
      {visible.map((c) => (
        <DiffRow key={c.key} change={c} />
      ))}
    </div>
  );
}

function DiffRow({ change }: { change: Change }) {
  const beforeText = formatValue(change.before);
  const afterText = formatValue(change.after);

  return (
    <div className="overflow-hidden rounded-md border">
      <header className="flex items-center justify-between border-b bg-muted/30 px-2 py-1">
        <span className="font-mono text-xs">{change.key}</span>
        <StateBadge state={change.state} />
      </header>
      {change.state === 'added' && (
        <DiffPane tone="add" prefix="+">{afterText}</DiffPane>
      )}
      {change.state === 'removed' && (
        <DiffPane tone="remove" prefix="−">{beforeText}</DiffPane>
      )}
      {change.state === 'changed' && (
        <div className="grid grid-cols-2 divide-x">
          <DiffPane tone="remove" prefix="−">{beforeText}</DiffPane>
          <DiffPane tone="add" prefix="+">{afterText}</DiffPane>
        </div>
      )}
      {change.state === 'unchanged' && (
        <DiffPane tone="muted" prefix=" ">{afterText}</DiffPane>
      )}
    </div>
  );
}

function DiffPane({
  tone,
  prefix,
  children,
}: {
  tone: 'add' | 'remove' | 'muted';
  prefix: string;
  children: string;
}) {
  const cls =
    tone === 'add'
      ? 'bg-emerald-50 text-emerald-900'
      : tone === 'remove'
        ? 'bg-destructive/5 text-destructive'
        : 'bg-muted/10 text-muted-foreground';
  return (
    <pre className={`whitespace-pre-wrap break-words px-3 py-1.5 font-mono text-[11px] ${cls}`}>
      <span className="select-none opacity-60">{prefix} </span>
      {children}
    </pre>
  );
}

function StateBadge({ state }: { state: Change['state'] }) {
  const map: Record<Change['state'], { label: string; cls: string }> = {
    added: { label: 'added', cls: 'bg-emerald-100 text-emerald-700' },
    removed: { label: 'removed', cls: 'bg-destructive/10 text-destructive' },
    changed: { label: 'changed', cls: 'bg-amber-100 text-amber-700' },
    unchanged: { label: 'unchanged', cls: 'bg-muted text-muted-foreground' },
  };
  const m = map[state];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${m.cls}`}>{m.label}</span>
  );
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
