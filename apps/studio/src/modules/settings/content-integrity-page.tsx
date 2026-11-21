import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Save, ShieldAlert } from 'lucide-react';
import { LumiError } from '@lumibase/sdk';
import { getActiveSite, getActiveToken, getApiClient } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';

/**
 * Settings → Content integrity (#989).
 *
 * Edits the `contentIntegrity` site setting the monitor reads on every
 * publish, and shows the "what went live" digest for the last 7 days: what
 * was published, by which account, and which alerts fired. The digest is the
 * check that does not depend on the scan catching anything.
 */
export const CONTENT_INTEGRITY_KEY = 'contentIntegrity';

export interface IntegrityForm {
  enabled: boolean;
  action: 'notify' | 'unpublish';
  allowedHosts: string;
  burstThreshold: string;
  burstWindowMinutes: string;
  firstPublishSignal: boolean;
  weeklyDigest: boolean;
}

interface Digest {
  from: string;
  to: string;
  published: {
    total: number;
    byPrincipal: Array<{ userId: string | null; email: string | null; count: number }>;
    items: Array<{ collection: string; itemId: string; firstPublishedAt: string; userId: string | null }>;
  };
  alerts: { total: number; bySignal: Record<string, number> };
}

const SIGNAL_LABELS: Record<string, string> = {
  download_link: 'Download link',
  offsite_seo_url: 'Off-site canonical / OG URL',
  publish_burst: 'Publish burst',
  first_publish_by_principal: 'First publish by an account',
};

export function formFromSetting(value: unknown): IntegrityForm {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const num = (v: unknown, fallback: number) => String(typeof v === 'number' && v > 0 ? Math.floor(v) : fallback);
  return {
    enabled: raw.enabled !== false,
    action: raw.action === 'unpublish' ? 'unpublish' : 'notify',
    allowedHosts: Array.isArray(raw.allowedHosts) ? raw.allowedHosts.filter((h) => typeof h === 'string').join('\n') : '',
    burstThreshold: num(raw.burstThreshold, 25),
    burstWindowMinutes: num(raw.burstWindowMinutes, 10),
    firstPublishSignal: raw.firstPublishSignal !== false,
    weeklyDigest: raw.weeklyDigest !== false,
  };
}

/** The setting value to store, or an error message. Keeps unknown keys of `previous`. */
export function settingFromForm(form: IntegrityForm, previous: unknown): { value: Record<string, unknown> } | { error: string } {
  const threshold = Number(form.burstThreshold);
  const windowMinutes = Number(form.burstWindowMinutes);
  if (!Number.isInteger(threshold) || threshold < 1) return { error: 'The burst threshold must be a whole number of at least 1.' };
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1) return { error: 'The burst window must be a whole number of minutes, at least 1.' };
  const hosts = form.allowedHosts.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
  const bad = hosts.find((h) => !/^[a-z0-9.-]+$/.test(h));
  if (bad) return { error: `"${bad}" is not a host name. Enter host names only, such as cdn.example.com.` };
  if (hosts.length > 100) return { error: 'Enter at most 100 allowed hosts.' };
  const base = previous && typeof previous === 'object' ? (previous as Record<string, unknown>) : {};
  return {
    value: {
      ...base,
      enabled: form.enabled,
      action: form.action,
      allowedHosts: hosts,
      burstThreshold: threshold,
      burstWindowMinutes: windowMinutes,
      firstPublishSignal: form.firstPublishSignal,
      weeklyDigest: form.weeklyDigest,
    },
  };
}

async function fetchDigest(): Promise<Digest> {
  const res = await fetch(`${getApiBaseUrl()}/api/v1/admin/security/content-integrity/digest?days=7`, {
    headers: {
      Accept: 'application/json',
      'X-Lumi-Site': getActiveSite(),
      'X-Lumi-Client': 'studio',
      Authorization: `Bearer ${getActiveToken()}`,
    },
  });
  if (!res.ok) throw new Error(res.status === 403 ? 'The digest is available to site admins.' : 'Failed to load the digest.');
  return ((await res.json()) as { data: Digest }).data;
}

export function ContentIntegritySettingsPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const ids = { enabled: useId(), action: useId(), hosts: useId(), threshold: useId(), window: useId(), first: useId(), digest: useId() };

  const settingQuery = useQuery({
    queryKey: ['settings', CONTENT_INTEGRITY_KEY],
    queryFn: async () => {
      try {
        return (await client.settings.get(CONTENT_INTEGRITY_KEY)).data?.value ?? null;
      } catch (err) {
        if (err instanceof LumiError && err.status === 404) return null;
        throw err;
      }
    },
  });
  const digestQuery = useQuery({ queryKey: ['content-integrity-digest'], queryFn: fetchDigest });

  const [form, setForm] = useState<IntegrityForm>(formFromSetting(null));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settingQuery.data !== undefined) setForm(formFromSetting(settingQuery.data));
  }, [settingQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async (value: Record<string, unknown>) => client.settings.set(CONTENT_INTEGRITY_KEY, value),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['settings', CONTENT_INTEGRITY_KEY] });
    },
    onError: (err) => {
      setSaved(false);
      setError(err instanceof LumiError && err.status === 403
        ? 'Changing content-integrity settings requires site admin access.'
        : 'Failed to save content-integrity settings.');
    },
  });

  const onSave = () => {
    setSaved(false);
    const next = settingFromForm(form, settingQuery.data);
    if ('error' in next) {
      setError(next.error);
      return;
    }
    setError(null);
    saveMutation.mutate(next.value);
  };

  const set = <K extends keyof IntegrityForm>(key: K, value: IntegrityForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const digest = digestQuery.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ShieldAlert className="h-5 w-5" aria-hidden="true" /> Content integrity
        </h1>
        <p className="text-sm text-muted-foreground">
          Every publish is checked for download links, off-site canonical or social URLs, publish bursts and accounts publishing for the first time. Alerts appear in the security audit log under <span className="font-mono">content_integrity_alert</span>.
        </p>
      </header>

      <section aria-labelledby={ids.digest} className="space-y-3 rounded-md border border-border bg-background p-4">
        <h2 id={ids.digest} className="font-medium">What went live in the last 7 days</h2>
        {digestQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : digestQuery.isError ? (
          <p role="alert" className="text-sm text-red-600">{(digestQuery.error as Error).message}</p>
        ) : digest ? (
          <div className="space-y-3 text-sm">
            <p>
              <strong>{digest.published.total}</strong> item(s) published for the first time, <strong>{digest.alerts.total}</strong> alert(s).
            </p>
            {digest.published.byPrincipal.length > 0 ? (
              <table className="w-full text-start text-sm">
                <thead><tr className="text-muted-foreground"><th className="py-1 font-medium">Account</th><th className="py-1 font-medium">Items</th></tr></thead>
                <tbody>
                  {digest.published.byPrincipal.map((p) => (
                    <tr key={p.userId ?? 'none'} className="border-t border-border">
                      <td className="py-1">{p.email ?? p.userId ?? 'API key or system'}</td>
                      <td className="py-1">{p.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {Object.keys(digest.alerts.bySignal).length > 0 ? (
              <ul className="list-disc ps-5">
                {Object.entries(digest.alerts.bySignal).map(([kind, n]) => (
                  <li key={kind}>{SIGNAL_LABELS[kind] ?? kind}: {n}</li>
                ))}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Do you recognise every account and every item? If not, follow the response runbook in the content-injection guide.
            </p>
          </div>
        ) : null}
      </section>

      {settingQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <section className="space-y-4 rounded-md border border-border bg-background p-4">
          <h2 className="font-medium">Policy</h2>
          <label htmlFor={ids.enabled} className="flex items-center gap-2 text-sm">
            <input id={ids.enabled} type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            Check content when it goes live
          </label>
          <div className="space-y-1">
            <label htmlFor={ids.action} className="block text-sm font-medium">When a download link or off-site SEO URL is found</label>
            <select id={ids.action} value={form.action} onChange={(e) => set('action', e.target.value === 'unpublish' ? 'unpublish' : 'notify')} className="rounded-md border px-3 py-2 text-sm">
              <option value="notify">Record an alert, keep the item live</option>
              <option value="unpublish">Record an alert and return the item to draft</option>
            </select>
            <p className="text-xs text-muted-foreground">Bursts and first publishes only record an alert.</p>
          </div>
          <div className="space-y-1">
            <label htmlFor={ids.hosts} className="block text-sm font-medium">Allowed hosts</label>
            <textarea id={ids.hosts} rows={3} value={form.allowedHosts} onChange={(e) => set('allowedHosts', e.target.value)} placeholder="cdn.example.com" className="w-full rounded-md border px-3 py-2 font-mono text-sm" />
            <p className="text-xs text-muted-foreground">One per line. Links to these hosts, and to the site&apos;s own domains, are never flagged.</p>
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <label htmlFor={ids.threshold} className="block text-sm font-medium">Burst threshold (items)</label>
              <input id={ids.threshold} type="number" min="1" value={form.burstThreshold} onChange={(e) => set('burstThreshold', e.target.value)} className="w-32 rounded-md border px-3 py-2 text-sm" />
            </div>
            <div className="space-y-1">
              <label htmlFor={ids.window} className="block text-sm font-medium">Burst window (minutes)</label>
              <input id={ids.window} type="number" min="1" value={form.burstWindowMinutes} onChange={(e) => set('burstWindowMinutes', e.target.value)} className="w-32 rounded-md border px-3 py-2 text-sm" />
            </div>
          </div>
          <label htmlFor={ids.first} className="flex items-center gap-2 text-sm">
            <input id={ids.first} type="checkbox" checked={form.firstPublishSignal} onChange={(e) => set('firstPublishSignal', e.target.checked)} />
            Alert when an account publishes on this site for the first time
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.weeklyDigest} onChange={(e) => set('weeklyDigest', e.target.checked)} />
            Send site admins a weekly &ldquo;what went live&rdquo; notification
          </label>

          {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
          {saved ? <p role="status" className="text-sm text-emerald-700">Settings saved.</p> : null}

          <div className="flex justify-end">
            <button type="button" onClick={onSave} disabled={saveMutation.isPending} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
              <Save className="h-4 w-4" aria-hidden="true" /> {saveMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
