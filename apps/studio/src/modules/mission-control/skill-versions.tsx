import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { missionControlApi, type SiteSkill, type SiteSkillVersion } from './api';

/**
 * Version history of one Site Skill (#712). Restoring never rewrites
 * history: the server writes the old content back as a NEW version.
 */
export function SkillVersions({
  skill,
  onRestored,
}: {
  skill: SiteSkill;
  onRestored: (skill: SiteSkill) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['mc-skill-versions', skill.id],
    queryFn: () => missionControlApi.skillVersions(skill.id),
  });

  const restoreMutation = useMutation({
    mutationFn: (version: number) => missionControlApi.restoreSkillVersion(skill.id, version),
    onSuccess: (restored) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['mc-skill-versions', skill.id] });
      onRestored(restored);
    },
    onError: (err: Error) => setError(err.message),
  });

  const versions = versionsQuery.data ?? [];

  return (
    <section className="space-y-2" aria-label="Version history">
      <h3 className="text-sm font-semibold">Version history</h3>
      <p className="text-xs text-muted-foreground">
        Restoring writes the old content as a new version
        {skill.status === 'active' ? ' — and takes effect on agents immediately.' : '.'}
      </p>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {versionsQuery.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {versionsQuery.isError && (
        <p role="alert" className="text-xs text-destructive">
          {versionsQuery.error.message}
        </p>
      )}
      {versionsQuery.isSuccess && versions.length === 0 && (
        <p className="text-xs text-muted-foreground">No versions recorded.</p>
      )}
      <ul className="space-y-2">
        {versions.map((version) => (
          <li key={version.id} className="rounded-lg border p-2 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>v{version.version}</strong>
                {version.version === skill.version && (
                  <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                    current
                  </span>
                )}
                <code className="ml-2 text-[10px] text-muted-foreground">
                  {version.hash.slice(0, 12)}
                </code>
              </span>
              {version.version !== skill.version && (
                <button
                  type="button"
                  onClick={() => restoreMutation.mutate(version.version)}
                  disabled={restoreMutation.isPending}
                  aria-label={`Restore version ${version.version}`}
                  className="rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
                >
                  Restore
                </button>
              )}
            </div>
            <p className="mt-1 text-muted-foreground">
              {authorOf(version)} · via {version.source}
              {version.sourceRef ? ` (${version.sourceRef})` : ''} ·{' '}
              {new Date(version.createdAt).toLocaleString()}
            </p>
            {version.changeNote && <p className="mt-1">{version.changeNote}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function authorOf(version: SiteSkillVersion): string {
  return version.authorLabel ?? version.authorId ?? 'unknown author';
}
