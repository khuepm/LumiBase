import {
  type Change,
  type DiffToken,
  diffFields,
  diffKindOf,
  jsonPathDiff,
  listDiff,
  wordDiff,
} from '@lumibase/contracts';
import { RotateCcw } from 'lucide-react';
import { useMemo } from 'react';

interface RevisionsDiffProps {
  before: Record<string, unknown> | null | undefined;
  after: Record<string, unknown> | null | undefined;
  /** Show fields whose before/after are equal (default: hidden). */
  showUnchanged?: boolean;
  /** Labels for the two columns (default "Before" / "After"). */
  beforeLabel?: string;
  afterLabel?: string;
  /** Offer a per-field restore of the *before* value (#686). */
  onRestore?: (field: string) => void;
  /** Field currently being restored (button shows progress). */
  restoring?: string | null;
}

/**
 * Side-by-side, field-aware diff between two `data` snapshots (#686).
 *
 * Each top-level field is one row (the unit the revision engine records).
 * Inside a row the value is diffed by shape: text word by word, lists of
 * ids/tags as added/removed members, objects and block arrays as a list of
 * changed leaf paths, anything else as before/after values.
 */
export function RevisionsDiff({
  before,
  after,
  showUnchanged,
  beforeLabel = 'Before',
  afterLabel = 'After',
  onRestore,
  restoring,
}: RevisionsDiffProps) {
  const changes = useMemo(() => diffFields(before, after), [before, after]);

  const visible = showUnchanged ? changes : changes.filter((c) => c.state !== 'unchanged');
  if (visible.length === 0) {
    return <p className="text-sm text-muted-foreground">No field changes recorded.</p>;
  }

  return (
    <div className="space-y-2" data-testid="revisions-diff">
      <div className="grid grid-cols-2 gap-2 px-1 text-[10px] font-medium uppercase text-muted-foreground">
        <span>{beforeLabel}</span>
        <span>{afterLabel}</span>
      </div>
      {visible.map((c) => (
        <DiffRow
          key={c.key}
          change={c}
          onRestore={onRestore && c.state !== 'unchanged' ? () => onRestore(c.key) : undefined}
          restoring={restoring === c.key}
        />
      ))}
    </div>
  );
}

function DiffRow({
  change,
  onRestore,
  restoring,
}: {
  change: Change;
  onRestore?: () => void;
  restoring?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border" data-field-diff={change.key}>
      <header className="flex items-center justify-between gap-2 border-b bg-muted/30 px-2 py-1">
        <span className="font-mono text-xs">{change.key}</span>
        <span className="flex items-center gap-2">
          <StateBadge state={change.state} />
          {onRestore && (
            <button
              type="button"
              onClick={onRestore}
              disabled={restoring}
              title="Set this field back to the left-hand value"
              className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-accent disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3" />
              {restoring ? 'Restoring…' : 'Restore'}
            </button>
          )}
        </span>
      </header>
      <ChangeBody change={change} />
    </div>
  );
}

/** Renders one field's change by value shape. Exported for tests. */
export function ChangeBody({ change }: { change: Change }) {
  if (change.state === 'unchanged') {
    return <Pane tone="muted">{formatValue(change.after)}</Pane>;
  }
  const kind = diffKindOf(change.before, change.after);
  if (kind === 'text') {
    const tokens = wordDiff(String(change.before ?? ''), String(change.after ?? ''));
    return (
      <div className="grid grid-cols-2 divide-x">
        <TokenPane tokens={tokens} side="before" />
        <TokenPane tokens={tokens} side="after" />
      </div>
    );
  }
  if (kind === 'list') {
    const d = listDiff((change.before as unknown[]) ?? [], (change.after as unknown[]) ?? []);
    return (
      <div className="space-y-1 px-3 py-1.5 text-[11px]">
        {d.removed.length > 0 && (
          <p>
            <span className="me-1 text-muted-foreground">Removed:</span>
            {d.removed.map((v, i) => (
              <Chip key={`r${i}`} tone="remove">{formatValue(v)}</Chip>
            ))}
          </p>
        )}
        {d.added.length > 0 && (
          <p>
            <span className="me-1 text-muted-foreground">Added:</span>
            {d.added.map((v, i) => (
              <Chip key={`a${i}`} tone="add">{formatValue(v)}</Chip>
            ))}
          </p>
        )}
        {d.reordered && <p className="text-muted-foreground">Order changed.</p>}
      </div>
    );
  }
  if (kind === 'json') {
    const paths = jsonPathDiff(change.before, change.after);
    return (
      <table className="w-full text-[11px]">
        <tbody>
          {paths.map((p) => (
            <tr key={p.path} className="border-t first:border-t-0 align-top">
              <td className="w-1/4 px-2 py-1 font-mono text-muted-foreground">{p.path || '(value)'}</td>
              <td className="w-[37.5%] px-2 py-1">
                {p.state !== 'added' && <Pane tone="remove">{formatValue(p.before)}</Pane>}
              </td>
              <td className="w-[37.5%] px-2 py-1">
                {p.state !== 'removed' && <Pane tone="add">{formatValue(p.after)}</Pane>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <div className="grid grid-cols-2 divide-x">
      {change.state === 'added' ? <Pane tone="muted">{''}</Pane> : <Pane tone="remove">{formatValue(change.before)}</Pane>}
      {change.state === 'removed' ? <Pane tone="muted">{''}</Pane> : <Pane tone="add">{formatValue(change.after)}</Pane>}
    </div>
  );
}

function TokenPane({ tokens, side }: { tokens: DiffToken[]; side: 'before' | 'after' }) {
  const hidden = side === 'before' ? 'insert' : 'delete';
  const marked = side === 'before' ? 'delete' : 'insert';
  return (
    <pre className="whitespace-pre-wrap break-words px-3 py-1.5 font-mono text-[11px]">
      {tokens
        .filter((t) => t.op !== hidden)
        .map((t, i) =>
          t.op === marked ? (
            side === 'before' ? (
              <del key={i} className="bg-destructive/15 text-destructive">
                {t.text}
              </del>
            ) : (
              <ins key={i} className="bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-900/40 dark:text-emerald-100">
                {t.text}
              </ins>
            )
          ) : (
            <span key={i}>{t.text}</span>
          ),
        )}
    </pre>
  );
}

function Pane({ tone, children }: { tone: 'add' | 'remove' | 'muted'; children: string }) {
  const cls =
    tone === 'add'
      ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100'
      : tone === 'remove'
        ? 'bg-destructive/5 text-destructive'
        : 'bg-muted/10 text-muted-foreground';
  return <pre className={`whitespace-pre-wrap break-words px-3 py-1.5 font-mono text-[11px] ${cls}`}>{children}</pre>;
}

function Chip({ tone, children }: { tone: 'add' | 'remove'; children: string }) {
  return (
    <span
      className={`me-1 inline-block rounded px-1.5 py-0.5 font-mono ${
        tone === 'add' ? 'bg-emerald-100 text-emerald-900' : 'bg-destructive/10 text-destructive line-through'
      }`}
    >
      {children}
    </span>
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
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${m.cls}`}>{m.label}</span>;
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
