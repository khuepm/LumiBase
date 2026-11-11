import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { missionControlApi, type SiteSkill, type SiteSkillStatus } from './api';
import { MissionControlLayout } from './layout';
import { BLANK_SKILL, HOUSE_STYLE_TEMPLATE, SkillEditor, type SkillDraft } from './skill-editor';
import { SkillMatchPreview } from './skill-match-preview';
import { SkillVersions } from './skill-versions';

/**
 * Site Skills sub-route (#712): editorial playbooks a site writes for its
 * agents. List + editor + version history + match preview. The list is
 * fetched whole and filtered client-side so a skill stays selected when a
 * lifecycle action moves it out of the current status filter.
 */

type StatusFilter = 'all' | SiteSkillStatus;
type LifecycleAction = 'activate' | 'archive' | 'draft';
type View =
  | { kind: 'none' }
  | { kind: 'create'; initial: SkillDraft; nonce: number }
  | { kind: 'edit'; id: string };

const FILTERS: readonly StatusFilter[] = ['all', 'draft', 'active', 'archived'];
const SKILLS_KEY = ['mc-skills'] as const;

const STATUS_STYLES: Record<SiteSkillStatus, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  draft: 'bg-sky-100 text-sky-800',
  archived: 'bg-muted text-muted-foreground',
};

const LIFECYCLE: Record<SiteSkillStatus, Array<{ action: LifecycleAction; label: string }>> = {
  draft: [
    { action: 'activate', label: 'Activate' },
    { action: 'archive', label: 'Archive' },
  ],
  active: [
    { action: 'draft', label: 'Back to draft' },
    { action: 'archive', label: 'Archive' },
  ],
  archived: [
    { action: 'activate', label: 'Activate' },
    { action: 'draft', label: 'Back to draft' },
  ],
};

/** "copilot · tool: x · collection: articles", or "Everywhere" when unscoped. */
function scopeSummary(skill: SiteSkill): string {
  const parts: string[] = [];
  if (skill.surfaces.length > 0) parts.push(skill.surfaces.join(', '));
  if (skill.tools.length > 0) parts.push(`tools: ${skill.tools.join(', ')}`);
  if (skill.collections.length > 0) parts.push(`collections: ${skill.collections.join(', ')}`);
  const scope = parts.length > 0 ? parts.join(' · ') : 'Everywhere';
  return skill.triggers.length > 0 ? `${scope} · on: ${skill.triggers.join(', ')}` : scope;
}

export function SkillsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [view, setView] = useState<View>({ kind: 'none' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const skillsQuery = useQuery({
    queryKey: SKILLS_KEY,
    queryFn: () => missionControlApi.skills(),
  });

  const skills = skillsQuery.data ?? [];
  const visible = filter === 'all' ? skills : skills.filter((s) => s.status === filter);
  const selected = view.kind === 'edit' ? skills.find((s) => s.id === view.id) : undefined;

  /** Put a server-returned row in the cache right away, then reconcile. */
  function applySkill(skill: SiteSkill) {
    queryClient.setQueryData<SiteSkill[]>(SKILLS_KEY, (current) => {
      if (!current) return [skill];
      return current.some((s) => s.id === skill.id)
        ? current.map((s) => (s.id === skill.id ? skill : s))
        : [...current, skill];
    });
    queryClient.invalidateQueries({ queryKey: SKILLS_KEY });
    queryClient.invalidateQueries({ queryKey: ['mc-skill-versions', skill.id] });
  }

  function open(next: View) {
    setView(next);
    setConfirmDelete(false);
    setActionError(null);
  }

  function startCreate(initial: SkillDraft) {
    open({ kind: 'create', initial, nonce: Date.now() });
  }

  const statusMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: LifecycleAction }) =>
      missionControlApi.setSkillStatus(id, action),
    onSuccess: (skill) => {
      setActionError(null);
      applySkill(skill);
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => missionControlApi.deleteSkill(id),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<SiteSkill[]>(SKILLS_KEY, (current) =>
        current?.filter((s) => s.id !== id),
      );
      queryClient.invalidateQueries({ queryKey: SKILLS_KEY });
      open({ kind: 'none' });
    },
    onError: (err: Error) => {
      setConfirmDelete(false);
      setActionError(err.message);
    },
  });

  const busy = statusMutation.isPending || deleteMutation.isPending;

  return (
    <MissionControlLayout>
      <div className="space-y-4">
        <div className="rounded-lg border bg-background p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">Skills</h2>
              <p className="text-xs text-muted-foreground">
                Editorial playbooks for this site&apos;s agents. Only active skills are injected
                into runs.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs">
                <span className="sr-only">Filter by status</span>
                <select
                  aria-label="Filter by status"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as StatusFilter)}
                  className="rounded-md border bg-background px-2 py-1.5"
                >
                  {FILTERS.map((f) => (
                    <option key={f} value={f}>
                      {f === 'all' ? 'All statuses' : f}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => startCreate(BLANK_SKILL)}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                <Plus className="h-3.5 w-3.5" /> New skill
              </button>
            </div>
          </div>

          {skillsQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {skillsQuery.isError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
            >
              {skillsQuery.error.message}
            </p>
          )}

          {skillsQuery.isSuccess && skills.length === 0 && (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <p className="text-sm font-medium">No skills yet</p>
              <p className="mx-auto mt-1 max-w-xl text-xs text-muted-foreground">
                A skill is a Markdown playbook — house style, review checklists, how to write for a
                collection — that matching agent runs receive as instructions. It guides agents; it
                never grants them permissions.
              </p>
              <button
                type="button"
                onClick={() => startCreate(HOUSE_STYLE_TEMPLATE)}
                className="mt-3 rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
              >
                Start from house-style template
              </button>
            </div>
          )}

          {skills.length > 0 && visible.length === 0 && (
            <p className="text-sm text-muted-foreground">No {filter} skills.</p>
          )}

          {visible.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1.5 pr-3 font-medium">Skill</th>
                    <th className="py-1.5 pr-3 font-medium">Status</th>
                    <th className="py-1.5 pr-3 font-medium">Risk</th>
                    <th className="py-1.5 pr-3 font-medium">Version</th>
                    <th className="py-1.5 pr-3 font-medium">Priority</th>
                    <th className="py-1.5 font-medium">Scope</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((skill) => (
                    <tr
                      key={skill.id}
                      className={cn('border-b last:border-0', selected?.id === skill.id && 'bg-muted/40')}
                    >
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          onClick={() => open({ kind: 'edit', id: skill.id })}
                          aria-current={selected?.id === skill.id ? 'true' : undefined}
                          className="text-left font-medium hover:underline"
                        >
                          {skill.name}
                        </button>
                        <code className="block text-[11px] text-muted-foreground">{skill.slug}</code>
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={cn('rounded-full px-2 py-0.5 text-xs', STATUS_STYLES[skill.status])}
                        >
                          {skill.status}
                        </span>
                      </td>
                      <td
                        className={cn(
                          'py-2 pr-3 text-xs',
                          skill.riskClass === 'high' && 'font-medium text-destructive',
                        )}
                      >
                        {skill.riskClass}
                      </td>
                      <td className="py-2 pr-3 text-xs">v{skill.version}</td>
                      <td className="py-2 pr-3 text-xs">{skill.priority}</td>
                      <td className="py-2 text-xs text-muted-foreground">{scopeSummary(skill)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {view.kind === 'create' && (
          <div className="rounded-lg border bg-background p-4">
            <h2 className="mb-3 text-base font-semibold">New skill</h2>
            <SkillEditor
              key={view.nonce}
              initial={view.initial}
              onSaved={(skill) => {
                applySkill(skill);
                open({ kind: 'edit', id: skill.id });
              }}
              onCancel={() => open({ kind: 'none' })}
            />
          </div>
        )}

        {selected && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="space-y-3 rounded-lg border bg-background p-4 lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">
                  {selected.name}{' '}
                  <span className="text-xs font-normal text-muted-foreground">
                    v{selected.version} · {selected.status}
                  </span>
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  {LIFECYCLE[selected.status].map(({ action, label }) => (
                    <button
                      key={action}
                      type="button"
                      onClick={() => statusMutation.mutate({ id: selected.id, action })}
                      disabled={busy}
                      className={cn(
                        'rounded-md px-2 py-1 text-xs disabled:opacity-50',
                        action === 'activate'
                          ? 'bg-primary text-primary-foreground'
                          : 'border hover:bg-muted',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                  {confirmDelete ? (
                    <>
                      <span className="text-xs text-destructive">
                        Delete this skill and its history?
                      </span>
                      <button
                        type="button"
                        onClick={() => deleteMutation.mutate(selected.id)}
                        disabled={busy}
                        className="rounded-md bg-destructive px-2 py-1 text-xs text-destructive-foreground disabled:opacity-50"
                      >
                        Confirm delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      disabled={busy}
                      className="rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
              {actionError && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
                >
                  {actionError}
                </p>
              )}
              {/* Re-seed the form whenever a new version lands (save, restore). */}
              <SkillEditor
                key={`${selected.id}:${selected.version}`}
                skill={selected}
                onSaved={applySkill}
              />
            </div>
            <div className="rounded-lg border bg-background p-4">
              <SkillVersions skill={selected} onRestored={applySkill} />
            </div>
          </div>
        )}

        <div className="rounded-lg border bg-background p-4">
          <SkillMatchPreview />
        </div>
      </div>
    </MissionControlLayout>
  );
}
