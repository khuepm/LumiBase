import { useQuery } from '@tanstack/react-query';
import { Check, Pencil, RefreshCw, Sparkles, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import {
  listReviewProfiles,
  type DecisionAnswer,
  type DecisionPayload,
  type DecisionQuestion,
  type FieldResource,
  type PermissionAction,
  type ReviewProfile,
  type ReviewRun,
} from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { jsonEqual } from '@/lib/json-equal';
import type { PermissionHelpers } from '@/lib/use-permissions';
import { projectReviewFields } from './draft-review-hash';
import { useDraftReviewT, type DraftReviewT } from './draft-review-i18n';
import {
  stateFromError,
  useDraftReview,
  type DraftReviewFeedbackState,
  type DraftReviewState,
  type DraftReviewTarget,
} from './use-draft-review';

/**
 * Draft review panel (Jev J08, #515): runs a site review profile on the item
 * being edited and lists its suggestions, one per question.
 *
 * - Accept / Edit on a suggestion records feedback, then — only for a
 *   `choice` question whose key names a field of this collection — sets that
 *   field in the editor's draft through `onApply`. It never saves or
 *   publishes: the editor keeps the existing Save and editorial actions.
 * - Pinned fields and fields the editor may not write show the suggestion
 *   read-only; Apply is disabled.
 * - A change to the reviewed content after a review started makes the result
 *   stale: Accept and Edit are disabled until the review is run again.
 * - Answers carry no reasoning, so the panel shows the profile's criteria and
 *   the answer's probabilities only.
 */

export interface DraftReviewPanelProps {
  collection: string;
  /** The saved item; absent on the new-item form. */
  itemId?: string;
  /** The editor's current draft. */
  values: Record<string, unknown>;
  /** The saved item values. With `itemId`, an unchanged draft is reviewed as the saved item. */
  savedValues?: Record<string, unknown>;
  /** Fields of the collection shown in the editor. */
  fields: FieldResource[];
  /** Field permission that makes a value writable: `create` on the new-item form. */
  writeAction: Extract<PermissionAction, 'create' | 'update'>;
  perms: PermissionHelpers;
  /** Law Zero pins: fields a suggestion may not change. */
  pinnedFields: string[];
  /** Sets one field of the draft. Not a save. */
  onApply: (field: string, value: unknown) => void;
}

const ABSTAIN_CHOICES = new Set(['other', 'unknown']);

function percent(p: number | undefined): number {
  return Math.round((p ?? 0) * 100);
}

function payloadText(payload: DecisionPayload | null | undefined): string | null {
  if (payload === null || payload === undefined) return null;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function questionLabel(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function argmax(probabilities: Record<string, number>): string | null {
  let best: string | null = null;
  for (const [key, p] of Object.entries(probabilities)) {
    if (best === null || p > (probabilities[best] ?? 0)) best = key;
  }
  return best;
}

export function DraftReviewPanel(props: DraftReviewPanelProps) {
  const { collection } = props;
  const t = useDraftReviewT();
  const headingId = useId();
  const profilesQuery = useQuery({
    queryKey: ['review-profiles', collection],
    queryFn: ({ signal }) => listReviewProfiles({ collection }, { signal })(getApiClient()),
    retry: false,
    staleTime: 60_000,
  });
  const profiles = profilesQuery.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const profile = profiles.find((p) => p.key === selected) ?? profiles[0] ?? null;

  let body: React.ReactNode;
  if (profilesQuery.isLoading) {
    body = <p className="text-xs text-muted-foreground">{t('loadingProfiles')}</p>;
  } else if (profilesQuery.error) {
    body = <StateMessage t={t} state={stateFromError(profilesQuery.error)} />;
  } else if (!profile) {
    body = <StateMessage t={t} state={{ status: 'unconfigured' }} />;
  } else {
    body = (
      <>
        {profiles.length > 1 && (
          <label className="block text-xs text-muted-foreground">
            {t('profile')}
            <select
              value={profile.key}
              onChange={(e) => setSelected(e.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            >
              {profiles.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key} (v{p.version})
                </option>
              ))}
            </select>
          </label>
        )}
        <ProfileReview key={`${profile.key}@${profile.version}`} {...props} profile={profile} t={t} />
      </>
    );
  }

  return (
    <section aria-labelledby={headingId} className="space-y-2" data-testid="draft-review-panel">
      <h2 id={headingId} className="flex items-center gap-1 text-xs font-semibold uppercase text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
        {t('title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('description')}</p>
      {body}
    </section>
  );
}

function ProfileReview({
  collection,
  itemId,
  values,
  savedValues,
  fields,
  writeAction,
  perms,
  pinnedFields,
  onApply,
  profile,
  t,
}: DraftReviewPanelProps & { profile: ReviewProfile; t: DraftReviewT }) {
  const fieldNames = useMemo(() => new Set(fields.map((f) => f.name)), [fields]);
  const canWrite = (field: string) => perms.fieldAllowed(collection, writeAction, field);

  // Fields an unsaved snapshot may carry: the CMS refuses any the caller
  // cannot both read and write, so they are left out rather than sent.
  const snapshotFields = profile.fields.filter(
    (f) => fieldNames.has(f) && perms.fieldAllowed(collection, 'read', f) && canWrite(f),
  );
  const projectedDraft = projectReviewFields(values, profile.fields);
  const dirty = itemId !== undefined && !jsonEqual(projectedDraft, projectReviewFields(savedValues, profile.fields));
  const snapshotMode = itemId === undefined || dirty;
  const snapshot = snapshotMode ? projectReviewFields(values, snapshotFields) : undefined;
  const target: DraftReviewTarget = snapshot
    ? { ...(itemId ? { itemId } : {}), snapshot, projected: snapshot }
    : { itemId, projected: projectedDraft };
  const notSent = snapshotMode ? profile.fields.filter((f) => !snapshotFields.includes(f)) : [];
  const empty = snapshot !== undefined && Object.keys(snapshot).length === 0;

  const review = useDraftReview({ collection, profile, target });
  const { state } = review;
  const loading = state.status === 'loading';

  return (
    <div className="space-y-2">
      {dirty && <p className="text-xs text-muted-foreground">{t('unsaved')}</p>}
      {empty && (
        <p className="text-xs text-muted-foreground">{t('emptyDraft', { fields: snapshotFields.join(', ') || profile.fields.join(', ') })}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {loading ? (
          <button
            type="button"
            onClick={review.cancel}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {t('cancel')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void review.run()}
            disabled={empty}
            className="inline-flex items-center gap-1 rounded-md border border-primary/50 px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          >
            {review.hasRun ? <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
            {review.hasRun ? t('runAgain') : t('run')}
          </button>
        )}
        {loading && (
          <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {t('loading')}
          </span>
        )}
      </div>

      <StateMessage t={t} state={state} />

      {(state.status === 'success' || state.status === 'abstained' || (state.status === 'stale' && state.run)) && (
        <RunResult
          run={state.run!}
          profile={profile}
          state={state}
          t={t}
          notSent={notSent}
          targetFieldOf={(key, question) => (question.type === 'choice' && fieldNames.has(key) ? key : null)}
          canWrite={canWrite}
          pinnedFields={pinnedFields}
          feedbackFor={review.feedbackFor}
          onVerdict={async (key, verdict, value, targetField) => {
            const recorded = await review.submitFeedback(key, verdict, value);
            if (recorded && targetField && value !== undefined) onApply(targetField, value);
          }}
        />
      )}
    </div>
  );
}

function StateMessage({ t, state }: { t: DraftReviewT; state: DraftReviewState }) {
  switch (state.status) {
    case 'disabled':
      return <Notice tone="muted" text={t('states.disabled')} />;
    case 'unconfigured':
      return <Notice tone="muted" text={t('states.unconfigured')} />;
    case 'stale':
      return <Notice tone="warning" text={t('states.stale')} />;
    case 'abstained':
      return <Notice tone="warning" text={t('states.abstained')} />;
    case 'error': {
      const text =
        state.code === 'quota' && state.retryAfter !== null
          ? t('errors.quotaRetry', { seconds: state.retryAfter })
          : t(`errors.${ERROR_KEY[state.code]}`);
      return <Notice tone="error" text={text} />;
    }
    default:
      return null;
  }
}

const ERROR_KEY: Record<Extract<DraftReviewState, { status: 'error' }>['code'], string> = {
  forbidden: 'forbidden',
  quota: 'quota',
  timeout: 'timeout',
  unavailable: 'unavailable',
  field_not_allowed: 'fieldNotAllowed',
  too_large: 'tooLarge',
  not_found: 'notFound',
  failed: 'failed',
};

function Notice({ tone, text }: { tone: 'muted' | 'warning' | 'error'; text: string }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border p-2 text-xs',
        tone === 'muted' && 'border-border bg-background text-muted-foreground',
        tone === 'warning' && 'border-amber-300 bg-amber-50 text-amber-800',
        tone === 'error' && 'border-destructive/40 bg-destructive/10 text-destructive',
      )}
    >
      {text}
    </p>
  );
}

type Verdict = (key: string, verdict: 'accept' | 'edit' | 'reject', value: unknown, targetField: string | null) => Promise<void>;

function RunResult({
  run,
  profile,
  state,
  t,
  notSent,
  targetFieldOf,
  canWrite,
  pinnedFields,
  feedbackFor,
  onVerdict,
}: {
  run: ReviewRun;
  profile: ReviewProfile;
  state: DraftReviewState;
  t: DraftReviewT;
  notSent: string[];
  targetFieldOf: (key: string, question: DecisionQuestion) => string | null;
  canWrite: (field: string) => boolean;
  pinnedFields: string[];
  feedbackFor: (key: string) => DraftReviewFeedbackState | undefined;
  onVerdict: Verdict;
}) {
  const notReviewed = [...new Set([...run.omittedFields, ...notSent])];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        {run.provider && run.model && <span>{t('source', { provider: run.provider, model: run.model })}</span>}
        {run.calibrated !== null && (
          <span
            className={cn(
              'rounded-full border px-1.5 py-0.5',
              run.calibrated ? 'border-emerald-300 text-emerald-700' : 'border-border text-muted-foreground',
            )}
          >
            {run.calibrated ? t('calibrated') : t('notCalibrated')}
          </span>
        )}
      </div>
      {run.note && <p className="text-[11px] italic text-muted-foreground">{run.note}</p>}
      {notReviewed.length > 0 && (
        <p className="text-[11px] text-muted-foreground">{t('notReviewed', { fields: notReviewed.join(', ') })}</p>
      )}
      <ul className="space-y-2">
        {Object.entries(profile.questions).map(([key, question]) => {
          const answer = run.answers?.[key];
          if (!answer) return null;
          const targetField = targetFieldOf(key, question);
          return (
            <Suggestion
              key={key}
              questionKey={key}
              question={question}
              answer={answer}
              targetField={targetField}
              writable={targetField === null || canWrite(targetField)}
              pinned={targetField !== null && pinnedFields.includes(targetField)}
              state={state}
              feedback={feedbackFor(key)}
              t={t}
              onVerdict={onVerdict}
            />
          );
        })}
      </ul>
    </div>
  );
}

/** Values an editor can pick instead of the suggestion. */
function editOptions(question: DecisionQuestion, t: DraftReviewT, targetField: string | null) {
  switch (question.type) {
    case 'choice':
      return Object.keys(question.criteria)
        .filter((option) => !(targetField && ABSTAIN_CHOICES.has(option)))
        .map((option) => ({ id: option, label: option, value: option as unknown }));
    case 'score':
      return question.criteria.map((level, i) => ({ id: String(i), label: payloadText(level) ?? String(i), value: i as unknown }));
    case 'noul':
      return [
        { id: 'true', label: t('answer.yes'), value: true as unknown },
        { id: 'false', label: t('answer.no'), value: false as unknown },
      ];
  }
}

function Suggestion({
  questionKey,
  question,
  answer,
  targetField,
  writable,
  pinned,
  state,
  feedback,
  t,
  onVerdict,
}: {
  questionKey: string;
  question: DecisionQuestion;
  answer: DecisionAnswer;
  targetField: string | null;
  writable: boolean;
  pinned: boolean;
  state: DraftReviewState;
  feedback: DraftReviewFeedbackState | undefined;
  t: DraftReviewT;
  onVerdict: Verdict;
}) {
  const label = questionLabel(questionKey);
  const selectId = useId();
  const [editing, setEditing] = useState(false);
  const options = editOptions(question, t, targetField);
  const [editValue, setEditValue] = useState<string>(options[0]?.id ?? '');

  const abstainedChoice = answer.type === 'choice' && ABSTAIN_CHOICES.has(answer.choice);
  // The value Accept would write; null when accepting only records agreement.
  const acceptValue = targetField && answer.type === 'choice' && !abstainedChoice ? answer.choice : null;
  const stale = state.status === 'stale';
  const blocked = targetField !== null && (pinned || !writable);
  const done = feedback !== undefined && feedback.status !== 'error';
  const busy = feedback?.status === 'pending';
  const canAccept = !stale && !done && !blocked && !(state.status === 'abstained' && acceptValue !== null);
  const canEdit = !stale && !done && !blocked && options.length > 0;
  const canReject = !done;

  let summary: React.ReactNode;
  if (answer.type === 'choice') {
    const description = question.type === 'choice' ? payloadText(question.criteria[answer.choice]) : null;
    const headline =
      answer.choice === 'unknown'
        ? t('answer.notEnoughInfo')
        : answer.choice === 'other'
          ? t('answer.noneFits')
          : t('answer.suggested', { value: answer.choice });
    const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3);
    summary = (
      <>
        <p className="text-sm font-medium">
          {headline}{' '}
          <span className="text-xs font-normal text-muted-foreground">
            {t('answer.probability', { percent: percent(answer.probabilities[answer.choice]) })} ·{' '}
            {t('answer.confidence', { percent: percent(answer.confidence) })}
          </span>
        </p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
          {ranked.map(([option, p]) => (
            <li key={option} className="flex justify-between gap-2">
              <span className="truncate">{option}</span>
              <span>{t('answer.probability', { percent: percent(p) })}</span>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (answer.type === 'score') {
    const levels = question.type === 'score' ? question.criteria : [];
    const likely = argmax(answer.probabilities);
    const likelyLabel = likely !== null ? (payloadText(levels[Number(likely)]) ?? likely) : '—';
    summary = (
      <>
        <p className="text-sm font-medium">
          {t('answer.likelyLevel', { level: likelyLabel })}{' '}
          <span className="text-xs font-normal text-muted-foreground">
            {t('answer.confidence', { percent: percent(answer.confidence) })}
          </span>
        </p>
        <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground" aria-label={t('answer.levels')}>
          {levels.map((level, i) => (
            <li key={i} className={cn('flex justify-between gap-2', String(i) === likely && 'font-medium text-foreground')}>
              <span className="truncate">{payloadText(level)}</span>
              <span>{t('answer.probability', { percent: percent(answer.probabilities[String(i)]) })}</span>
            </li>
          ))}
        </ul>
      </>
    );
  } else {
    const yes = answer.noul >= 0.5;
    const criterion = question.type === 'noul' ? payloadText(yes ? question.criteria.true : question.criteria.false) : null;
    summary = (
      <>
        <p className="text-sm font-medium">
          {t('answer.noulLikely', {
            label: yes ? t('answer.yes') : t('answer.no'),
            percent: percent(yes ? answer.noul : 1 - answer.noul),
          })}
        </p>
        {criterion && <p className="text-xs text-muted-foreground">{criterion}</p>}
      </>
    );
  }

  const valueOf = (id: string) => options.find((o) => o.id === id)?.value;

  return (
    <li className="rounded-md border bg-background p-2" data-testid={`suggestion-${questionKey}`}>
      <p className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</p>
      {summary}
      <p className="mt-1 text-[11px] text-muted-foreground">
        {targetField === null
          ? t('answer.feedbackOnly')
          : pinned
            ? t('answer.pinned', { field: targetField })
            : !writable
              ? t('answer.readOnly', { field: targetField })
              : t('answer.appliesTo', { field: targetField })}
      </p>

      {editing && canEdit ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label htmlFor={selectId} className="block w-full text-[11px] text-muted-foreground sm:w-auto">
            {t('actions.editLabel', { question: label })}
          </label>
          <select
            id={selectId}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              await onVerdict(questionKey, 'edit', valueOf(editValue), targetField);
              setEditing(false);
            }}
            className="rounded-md border border-primary/50 px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            {t('actions.confirmEdit')}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
          >
            {t('actions.cancelEdit')}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          <ActionButton
            label={t('actions.accept')}
            aria={t('actions.acceptAria', { question: label })}
            icon={<Check className="h-3 w-3" aria-hidden="true" />}
            disabled={!canAccept || busy}
            onClick={() => void onVerdict(questionKey, 'accept', acceptValue ?? undefined, acceptValue !== null ? targetField : null)}
          />
          <ActionButton
            label={t('actions.edit')}
            aria={t('actions.editAria', { question: label })}
            icon={<Pencil className="h-3 w-3" aria-hidden="true" />}
            disabled={!canEdit || busy}
            onClick={() => setEditing(true)}
          />
          <ActionButton
            label={t('actions.reject')}
            aria={t('actions.rejectAria', { question: label })}
            icon={<X className="h-3 w-3" aria-hidden="true" />}
            disabled={!canReject || busy}
            onClick={() => void onVerdict(questionKey, 'reject', undefined, null)}
          />
        </div>
      )}

      {feedback?.status === 'saved' && (
        <p role="status" className="mt-1 text-[11px] text-emerald-700">
          {t(`verdict.${feedback.verdict}`)}
          {feedback.verdict !== 'reject' && targetField && (feedback.verdict === 'edit' || acceptValue !== null)
            ? ` · ${t('verdict.applied', { field: targetField })}`
            : ''}
        </p>
      )}
      {feedback?.status === 'error' && (
        <p role="alert" className="mt-1 text-[11px] text-destructive">
          {t('errors.feedback')}
        </p>
      )}
    </li>
  );
}

function ActionButton({
  label,
  aria,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  aria: string;
  icon: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={aria}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
    >
      {icon}
      {label}
    </button>
  );
}
