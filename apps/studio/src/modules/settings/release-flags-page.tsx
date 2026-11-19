import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LumiError } from '@lumibase/sdk';
import { useState } from 'react';
import { getActiveSite } from '@/lib/api';
import {
  isReleaseFlagDetail,
  releaseFlagsQueryKey,
  saveSiteReleaseFlags,
  useReleaseFlags,
  type ReleaseFlagDetail,
  type ReleaseFlagEntry,
} from '@/lib/release-flags';
import { useReleaseFlagsT, type ReleaseFlagsT } from './release-flags-i18n';

/**
 * Settings → System → Release flags (#895, epic #869).
 *
 * Site admins see every declared flag: stage, whether the deployment released
 * it and why (`releasedBy`), the effective state for this site and why
 * (`enabledBy`), owner and removal date — and switch released `siteToggle`
 * flags for their site, or clear the choice back to the default. Members see
 * the released flags only. Managing the signed manifest is not part of
 * Studio; it stays an API for the bootstrap admin.
 */
export function ReleaseFlagsPage() {
  const t = useReleaseFlagsT();
  const query = useReleaseFlags();
  const flags = query.data ?? [];
  const isAdmin = flags.length > 0 && flags.every(isReleaseFlagDetail);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{isAdmin ? t('intro') : t('memberIntro')}</p>
      </header>

      {query.isLoading && <p className="text-sm text-muted-foreground">{t('loading')}</p>}
      {query.error && <p className="text-sm text-destructive">{t('error')}</p>}
      {query.isSuccess && flags.length === 0 && <p className="text-sm text-muted-foreground">{t('memberEmpty')}</p>}

      {query.isSuccess && flags.length > 0 &&
        (isAdmin ? <AdminTable flags={flags as ReleaseFlagDetail[]} t={t} /> : <MemberList flags={flags} t={t} />)}
    </div>
  );
}

function MemberList({ flags, t }: { flags: ReleaseFlagEntry[]; t: ReleaseFlagsT }) {
  return (
    <ul className="divide-y rounded-xl border">
      {flags.map((flag) => (
        <li key={flag.key} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
          <code className="font-mono">{flag.key}</code>
          <span className={flag.enabled ? 'font-medium text-primary' : 'text-muted-foreground'}>
            {flag.enabled ? t('enabled.on') : t('enabled.off')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function describeSaveError(err: unknown, t: ReleaseFlagsT): string {
  if (err instanceof LumiError && err.status === 403) return t('forbidden');
  return t('saveError');
}

function AdminTable({ flags, t }: { flags: ReleaseFlagDetail[]; t: ReleaseFlagsT }) {
  const qc = useQueryClient();
  const siteId = getActiveSite();
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (change: { key: string; value: boolean | null }) =>
      saveSiteReleaseFlags({ [change.key]: change.value }),
    onSuccess: async (_data, change) => {
      setLastSaved(change.key);
      // The server recomputes the effective state (release gate + choice).
      await qc.invalidateQueries({ queryKey: releaseFlagsQueryKey(siteId) });
    },
  });

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('columns.flag')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('columns.stage')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('columns.release')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('columns.site')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('columns.owner')}</th>
              <th scope="col" className="px-4 py-2 text-start font-medium">{t('columns.removeBy')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {flags.map((flag) => (
              <FlagRow
                key={flag.key}
                flag={flag}
                t={t}
                busy={save.isPending && save.variables?.key === flag.key}
                onChange={(value) => save.mutate({ key: flag.key, value })}
              />
            ))}
          </tbody>
        </table>
      </div>
      <p aria-live="polite" className="min-h-5 text-sm">
        {save.isPending && <span className="text-muted-foreground">{t('saving')}</span>}
        {save.isError && <span className="text-destructive">{describeSaveError(save.error, t)}</span>}
        {save.isSuccess && lastSaved && <span className="text-muted-foreground">{t('saved')}</span>}
      </p>
    </div>
  );
}

function FlagRow({
  flag,
  t,
  busy,
  onChange,
}: {
  flag: ReleaseFlagDetail;
  t: ReleaseFlagsT;
  busy: boolean;
  onChange: (value: boolean | null) => void;
}) {
  const switchable = flag.siteToggle && flag.released;
  const hintId = `release-flag-${flag.key}-hint`;
  const hint = !flag.siteToggle ? t('notSwitchable') : !flag.released ? t('gateClosed') : null;

  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        <code className="font-mono text-sm">{flag.key}</code>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">{flag.description}</p>
      </td>
      <td className="px-4 py-3">{t(`stage.${flag.stage}`)}</td>
      <td className="px-4 py-3">
        <span className={flag.released ? 'font-medium' : 'text-muted-foreground'}>
          {flag.released ? t('released.yes') : t('released.no')}
        </span>
        <p className="text-xs text-muted-foreground">{t(`releasedBy.${flag.releasedBy}`)}</p>
      </td>
      <td className="px-4 py-3">
        {flag.siteToggle ? (
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              checked={flag.enabled}
              disabled={!switchable || busy}
              aria-describedby={hint ? hintId : undefined}
              aria-label={t('toggle', { key: flag.key })}
              onChange={(event) => onChange(event.target.checked)}
            />
            <span>{flag.enabled ? t('enabled.on') : t('enabled.off')}</span>
          </label>
        ) : (
          <span>{flag.enabled ? t('enabled.on') : t('enabled.off')}</span>
        )}
        <p className="text-xs text-muted-foreground">{t(`enabledBy.${flag.enabledBy}`)}</p>
        {hint && (
          <p id={hintId} className="mt-1 text-xs text-muted-foreground">
            {hint}
          </p>
        )}
        {switchable && flag.siteValue !== null && (
          <button
            type="button"
            className="mt-1 text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={() => onChange(null)}
          >
            {t('useDefault', { value: flag.siteDefault ? t('enabled.on') : t('enabled.off') })}
          </button>
        )}
      </td>
      <td className="px-4 py-3">{flag.owner}</td>
      <td className="px-4 py-3 whitespace-nowrap">{flag.removeBy}</td>
    </tr>
  );
}
