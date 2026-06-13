import { Bot, UserRound } from 'lucide-react';
import type { RevisionRow } from '@lumibase/sdk';
import { cn } from '@/lib/cn';

/**
 * Provenance surfaces for revisions (content-os-ui task 5.2; Req 4.2-4.4).
 * Lineage is a distribution feature of the Content OS (vision P5): every
 * byte answers "who made this and who is accountable" — these components
 * make that answer visible instead of leaving it in the database.
 */

export function provenanceTooltip(rev: RevisionRow): string {
  if (rev.authorType !== 'agent') return 'Written by a human.';
  const parts = ['Written by an agent.'];
  if (rev.model) parts.push(`Model: ${rev.model}`);
  if (rev.createdByRunId) parts.push(`Run: ${rev.createdByRunId}`);
  if (rev.constitutionHash) parts.push(`Constitution: ${rev.constitutionHash.slice(0, 12)}…`);
  if (typeof rev.confidence === 'number') parts.push(`Confidence: ${rev.confidence.toFixed(2)}`);
  return parts.join(' ');
}

export function ProvenanceBadge({
  revision,
  className,
}: {
  revision: Pick<RevisionRow, 'authorType' | 'model' | 'createdByRunId' | 'constitutionHash' | 'confidence'>;
  className?: string;
}) {
  const isAgent = revision.authorType === 'agent';
  return (
    <span
      title={provenanceTooltip(revision as RevisionRow)}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        isAgent ? 'bg-violet-100 text-violet-800' : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {isAgent ? <Bot className="h-3 w-3" /> : <UserRound className="h-3 w-3" />}
      {isAgent ? 'agent' : 'human'}
    </span>
  );
}

/** Detail block for an agent-authored revision — renders only known fields. */
export function ProvenancePanel({ revision }: { revision: RevisionRow }) {
  if (revision.authorType !== 'agent') return null;
  const rows: Array<[string, string]> = [];
  if (revision.model) rows.push(['Model', revision.model]);
  if (revision.createdByRunId) rows.push(['Run', revision.createdByRunId]);
  if (revision.constitutionHash)
    rows.push(['Constitution', `${revision.constitutionHash.slice(0, 16)}…`]);
  if (typeof revision.confidence === 'number')
    rows.push(['Confidence', revision.confidence.toFixed(2)]);

  return (
    <div className="rounded-md border bg-violet-50/50 p-2">
      <h4 className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-violet-800">
        <Bot className="h-3 w-3" /> Provenance
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Created by an agent — no further detail recorded.</p>
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-0.5 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
