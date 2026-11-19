import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Download, FileJson, LayoutTemplate, Loader2, Upload } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { getActiveSite, getApiClient, setActiveSite } from '@/lib/api';
import { getAdminBase } from '@/lib/admin-base';
import {
  TemplateApiError,
  templatesApi,
  type Installation,
  type PlanResult,
  type TemplateIssue,
  type TemplateSummary,
} from './api';
import {
  EMPTY_CHOICES,
  choicesKey,
  describeTemplateError,
  installKey,
  isPreviewCurrent,
  missingChoices,
  planRequest,
  type InstallChoices,
} from './install-state';

/**
 * Backend templates in Studio (#908, epic #900 BT08): the catalog (official
 * and this site's private templates), JSON import, export, capture, and the
 * install review — template + exact revision → explicit target site → plan
 * preview → install. Every step calls the same REST routes as the API and
 * MCP; the server decides and enforces.
 */

const BUTTON = 'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY = 'inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const INPUT = 'w-full rounded-md border bg-background px-2 py-1.5 text-sm';

export interface SiteOption {
  id: string;
  name: string;
}

/** Sites the admin can pick as a target: the active site, plus those of their organizations. */
async function loadSiteOptions(): Promise<SiteOption[]> {
  const active = getActiveSite();
  const options = new Map<string, SiteOption>([[active, { id: active, name: active }]]);
  try {
    const client = getApiClient();
    const orgs = await client.orgs.list();
    for (const org of orgs) {
      const sites = await client.orgs.sites.list(org.id).catch(() => []);
      for (const site of sites) options.set(site.id, { id: site.id, name: site.name });
    }
  } catch {
    // Not an organization member: the active site remains the only option.
  }
  return [...options.values()];
}

export function TemplatesPage({ loadSites = loadSiteOptions }: { loadSites?: () => Promise<SiteOption[]> } = {}) {
  const [choices, setChoices] = useState<InstallChoices>(EMPTY_CHOICES);
  return (
    <div className="space-y-6 p-6">
      <header className="flex items-start gap-3">
        <LayoutTemplate className="mt-1 h-5 w-5" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold">Backend templates</h1>
          <p className="text-sm text-muted-foreground">
            Reusable JSON definitions of collections, fields, relations and optional demo content. Installing one
            creates a new, independent backend in the site you choose; it never changes the template.
          </p>
        </div>
      </header>
      <Catalog onPick={(pick) => setChoices({ ...EMPTY_CHOICES, ...pick })} />
      <InstallReview choices={choices} onChange={setChoices} loadSites={loadSites} />
    </div>
  );
}

// ── Catalog ────────────────────────────────────────────────────────────────

function Catalog({ onPick }: { onPick: (pick: Partial<InstallChoices>) => void }) {
  const site = getActiveSite();
  const official = useQuery({ queryKey: ['backend-templates', 'official', site], queryFn: () => templatesApi.official(site) });
  const mine = useQuery({ queryKey: ['backend-templates', 'site', site], queryFn: () => templatesApi.list(site) });
  const rows: TemplateSummary[] = [...(official.data ?? []), ...(mine.data ?? [])];
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['backend-templates', 'site', site] });

  return (
    <section aria-labelledby="templates-catalog" className="space-y-3 rounded-lg border p-4">
      <h2 id="templates-catalog" className="text-base font-semibold">Catalog</h2>
      {(official.isError || mine.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {describeError(official.error ?? mine.error)}
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-start text-muted-foreground">
            <th scope="col" className="py-1">Template</th>
            <th scope="col">Source</th>
            <th scope="col">Published versions</th>
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={`${t.source}:${t.id}`} className="border-t">
              <td className="py-2">
                <span className="font-medium">{t.displayName}</span>{' '}
                <code className="text-xs text-muted-foreground">{t.slug}</code>
              </td>
              <td>{t.source === 'official' ? 'Official' : 'This site'}</td>
              <td>{t.versions.length > 0 ? t.versions.join(', ') : 'Draft only'}</td>
              <td className="space-x-2 py-2 text-end">
                <button
                  type="button"
                  className={BUTTON}
                  disabled={t.versions.length === 0}
                  onClick={() =>
                    onPick({
                      source: t.source,
                      sourceSiteId: t.source === 'site' ? site : null,
                      slug: t.slug,
                      version: t.versions[t.versions.length - 1] ?? '',
                    })
                  }
                >
                  Install…
                </button>
                {t.source === 'site' && t.versions.length > 0 && <ExportButton template={t} site={site} />}
                {t.source === 'site' && t.draftRevision !== null && (
                  <PublishButton template={t} site={site} onDone={refresh} />
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && !official.isLoading && !mine.isLoading && (
            <tr>
              <td colSpan={4} className="py-3 text-muted-foreground">No templates yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="grid gap-4 md:grid-cols-2">
        <ImportForm site={site} onDone={refresh} />
        <CaptureForm site={site} onDone={refresh} />
      </div>
    </section>
  );
}

function ExportButton({ template, site }: { template: TemplateSummary; site: string }) {
  const version = template.versions[template.versions.length - 1]!;
  const exporter = useMutation({
    mutationFn: () => templatesApi.revision(template.id, version, site),
    onSuccess: (revision) => download(`${template.slug}-${version}.template.json`, revision.document),
  });
  return (
    <button type="button" className={BUTTON} onClick={() => exporter.mutate()} disabled={exporter.isPending}>
      <Download className="h-4 w-4" aria-hidden /> Export {version}
    </button>
  );
}

function PublishButton({ template, site, onDone }: { template: TemplateSummary; site: string; onDone: () => void }) {
  const publish = useMutation({
    mutationFn: () => templatesApi.publish(template.id, template.draftRevision!, site),
    onSuccess: onDone,
  });
  return (
    <>
      <button type="button" className={BUTTON} onClick={() => publish.mutate()} disabled={publish.isPending}>
        Publish draft
      </button>
      {publish.isError && (
        <span role="alert" className="block text-xs text-destructive">
          {describeError(publish.error)}
        </span>
      )}
    </>
  );
}

function ImportForm({ site, onDone }: { site: string; onDone: () => void }) {
  const id = useId();
  const [text, setText] = useState('');
  const create = useMutation({ mutationFn: () => templatesApi.create(text, site), onSuccess: () => { setText(''); onDone(); } });
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h3 className="text-sm font-semibold"><FileJson className="me-1 inline h-4 w-4" aria-hidden />Import JSON</h3>
      <label htmlFor={`${id}-json`} className="text-xs text-muted-foreground">Template JSON</label>
      <textarea id={`${id}-json`} className={`${INPUT} h-28 font-mono`} value={text} onChange={(e) => setText(e.target.value)} />
      <label htmlFor={`${id}-file`} className="text-xs text-muted-foreground">or a .json file</label>
      <input
        id={`${id}-file`}
        type="file"
        accept="application/json,.json"
        className="block text-xs"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (file) setText(await file.text());
        }}
      />
      <button type="submit" className={PRIMARY} disabled={text.trim().length < 2 || create.isPending}>
        <Upload className="h-4 w-4" aria-hidden /> Import as draft
      </button>
      {create.isSuccess && <p role="status" className="text-xs text-emerald-700">Imported as a draft.</p>}
      {create.isError && <ErrorPanel error={create.error} />}
    </form>
  );
}

function CaptureForm({ site, onDone }: { site: string; onDone: () => void }) {
  const id = useId();
  const [collections, setCollections] = useState('');
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const names = collections.split(',').map((s) => s.trim()).filter(Boolean);
  const capture = useMutation({
    mutationFn: () => templatesApi.capture({ collections: names, slug, displayName }, site),
    onSuccess: onDone,
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        capture.mutate();
      }}
    >
      <h3 className="text-sm font-semibold">Capture from this site (schema only)</h3>
      <label htmlFor={`${id}-cols`} className="block text-xs text-muted-foreground">Collections (comma separated)</label>
      <input id={`${id}-cols`} className={INPUT} value={collections} onChange={(e) => setCollections(e.target.value)} />
      <label htmlFor={`${id}-slug`} className="block text-xs text-muted-foreground">Template slug</label>
      <input id={`${id}-slug`} className={INPUT} value={slug} onChange={(e) => setSlug(e.target.value)} />
      <label htmlFor={`${id}-name`} className="block text-xs text-muted-foreground">Display name</label>
      <input id={`${id}-name`} className={INPUT} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      <button type="submit" className={BUTTON} disabled={names.length === 0 || !slug || !displayName || capture.isPending}>
        Capture as draft
      </button>
      {capture.isSuccess && <p role="status" className="text-xs text-emerald-700">Captured as a draft.</p>}
      {capture.isError && <ErrorPanel error={capture.error} />}
    </form>
  );
}

// ── Install review ─────────────────────────────────────────────────────────

function InstallReview({
  choices,
  onChange,
  loadSites,
}: {
  choices: InstallChoices;
  onChange: (next: InstallChoices) => void;
  loadSites: () => Promise<SiteOption[]>;
}) {
  const id = useId();
  const site = getActiveSite();
  const official = useQuery({ queryKey: ['backend-templates', 'official', site], queryFn: () => templatesApi.official(site) });
  const mine = useQuery({ queryKey: ['backend-templates', 'site', site], queryFn: () => templatesApi.list(site) });
  const sites = useQuery({ queryKey: ['backend-templates', 'target-sites'], queryFn: loadSites });
  const templates = useMemo(
    () => [...(official.data ?? []), ...(mine.data ?? [])].filter((t) => t.versions.length > 0),
    [official.data, mine.data],
  );
  const selected = templates.find((t) => t.source === choices.source && t.slug === choices.slug);

  const [preview, setPreview] = useState<{ key: string; plan: PlanResult } | null>(null);
  const [installation, setInstallation] = useState<Installation | null>(null);
  const current = isPreviewCurrent(preview?.key ?? null, choices);
  // One install request per plan, however often Install is pressed.
  const inFlight = useRef<string | null>(null);

  const planMutation = useMutation({
    mutationFn: async () => {
      const key = choicesKey(choices);
      const plan = await templatesApi.plan(planRequest(choices));
      return { key, plan };
    },
    onMutate: () => {
      setPreview(null);
      setInstallation(null);
    },
    onSuccess: (result) => setPreview(result),
  });

  const installMutation = useMutation({
    mutationFn: async (plan: PlanResult) => {
      const { data } = await templatesApi.install(plan.report.targetSiteId, plan.id, installKey(plan.id));
      return data;
    },
    onSuccess: (data) => setInstallation(data),
    onSettled: () => {
      inFlight.current = null;
    },
  });

  const update = (patch: Partial<InstallChoices>) => {
    installMutation.reset();
    onChange({ ...choices, ...patch });
  };
  const missing = missingChoices(choices);

  return (
    <section aria-labelledby="templates-install" className="space-y-4 rounded-lg border p-4">
      <h2 id="templates-install" className="text-base font-semibold">Install into a site</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor={`${id}-template`} className="block text-xs font-medium">Template</label>
          <select
            id={`${id}-template`}
            className={INPUT}
            value={selected ? `${selected.source}:${selected.slug}` : ''}
            onChange={(e) => {
              const pick = templates.find((t) => `${t.source}:${t.slug}` === e.target.value);
              update({
                source: pick?.source ?? 'official',
                sourceSiteId: pick?.source === 'site' ? site : null,
                slug: pick?.slug ?? '',
                version: pick?.versions[pick.versions.length - 1] ?? '',
              });
            }}
          >
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={`${t.source}:${t.slug}`} value={`${t.source}:${t.slug}`}>
                {t.displayName} ({t.source === 'official' ? 'official' : 'this site'})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-version`} className="block text-xs font-medium">Revision</label>
          <select id={`${id}-version`} className={INPUT} value={choices.version} onChange={(e) => update({ version: e.target.value })}>
            <option value="">Choose a version…</option>
            {(selected?.versions ?? []).map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-site`} className="block text-xs font-medium">Target site (required)</label>
          <select id={`${id}-site`} className={INPUT} value={choices.targetSiteId} onChange={(e) => update({ targetSiteId: e.target.value })}>
            <option value="">Choose the site to install into…</option>
            {(sites.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name === s.id ? s.id : `${s.name} (${s.id})`}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-prefix`} className="block text-xs font-medium">Collection name prefix (optional)</label>
          <input
            id={`${id}-prefix`}
            className={INPUT}
            value={choices.prefix}
            placeholder="e.g. blog_"
            onChange={(e) => update({ prefix: e.target.value })}
          />
        </div>
        <div className="md:col-span-2">
          <div className="flex items-center gap-2">
            <input
              id={`${id}-seed`}
              type="checkbox"
              checked={choices.seedPack !== ''}
              onChange={(e) => update({ seedPack: e.target.checked ? 'demo' : '' })}
            />
            <label htmlFor={`${id}-seed`} className="text-sm">Also install demo content (seed pack)</label>
          </div>
          {choices.seedPack !== '' && (
            <div className="mt-2 max-w-xs">
              <label htmlFor={`${id}-pack`} className="block text-xs font-medium">Seed pack</label>
              <input id={`${id}-pack`} className={INPUT} value={choices.seedPack} onChange={(e) => update({ seedPack: e.target.value })} />
            </div>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Off by default: without a seed pack only the schema is created and every collection starts empty.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={BUTTON}
          disabled={missing.length > 0 || planMutation.isPending}
          onClick={() => planMutation.mutate()}
        >
          {planMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Preview
        </button>
        <button
          type="button"
          className={PRIMARY}
          disabled={!current || !preview || preview.plan.report.conflicts.length > 0 || installMutation.isPending || installation !== null}
          onClick={() => {
            if (!preview || !current) return;
            if (inFlight.current === preview.plan.id) return;
            inFlight.current = preview.plan.id;
            installMutation.mutate(preview.plan);
          }}
        >
          {installMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Install
        </button>
        {missing.length > 0 && (
          <span className="text-xs text-muted-foreground">
            Choose {missing.map((m) => (m === 'targetSiteId' ? 'a target site' : `a ${m}`)).join(', ')} to preview.
          </span>
        )}
      </div>

      <div aria-live="polite">
        {preview && !current && (
          <p role="status" className="text-sm text-amber-700">
            The choices changed since this preview. Preview again before installing.
          </p>
        )}
        {planMutation.isError && <ErrorPanel error={planMutation.error} />}
        {preview && current && <PlanPreview plan={preview.plan} />}
        {installMutation.isError && <ErrorPanel error={installMutation.error} retry={() => preview && installMutation.mutate(preview.plan)} />}
        {installation && <InstallResult installation={installation} targetSiteId={preview?.plan.report.targetSiteId ?? ''} />}
      </div>
      <p className="text-xs text-muted-foreground">
        Installing here runs with your own site-admin rights. An install requested by an agent over MCP waits for a
        human approval in Mission Control → Inbox and is bound to its plan.
      </p>
    </section>
  );
}

function PlanPreview({ plan }: { plan: PlanResult }) {
  const r = plan.report;
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm" data-testid="plan-preview">
      <p>
        <span className="font-medium">{r.template.displayName}</span> {r.template.version} →{' '}
        <span className="font-medium">{r.targetSiteId}</span>
      </p>
      <p className="break-all text-xs text-muted-foreground">Digest {r.template.digest}</p>
      <ul className="grid grid-cols-2 gap-1 md:grid-cols-4">
        <li>Collections: {r.counts.collections}</li>
        <li>Fields: {r.counts.fields}</li>
        <li>Relations: {r.counts.relations}</li>
        <li>Seed records: {r.counts.seedRecords}</li>
      </ul>
      <details>
        <summary className="cursor-pointer text-xs">Collections and relations</summary>
        <p className="text-xs">{r.components.collections.join(', ')}</p>
        <ul className="text-xs">
          {r.components.relations.map((rel) => (
            <li key={`${rel.from}>${rel.to}`}>{rel.from} → {rel.to} ({rel.type})</li>
          ))}
        </ul>
      </details>
      {r.conflicts.length > 0 && (
        <div role="alert" className="text-destructive">
          These collections already exist in the target site: {r.conflicts.join(', ')}. Choose a prefix.
        </div>
      )}
      {r.unrelatedCollections > 0 && (
        <p className="text-xs text-muted-foreground">{r.unrelatedCollections} existing collections are left untouched.</p>
      )}
      <p className="text-xs text-muted-foreground">This preview expires at {new Date(plan.expiresAt).toLocaleTimeString()}.</p>
    </div>
  );
}

function InstallResult({ installation, targetSiteId }: { installation: Installation; targetSiteId: string }) {
  const open = (collection: string) => {
    // Links land in the TARGET site, which may not be the active one.
    setActiveSite(targetSiteId);
    const base = getAdminBase(window.location.pathname);
    window.location.assign(`${base}/data-model/${encodeURIComponent(collection)}`);
  };
  return (
    <div role="status" className="space-y-2 rounded-md border border-emerald-600/40 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden /> Installed in {targetSiteId}
      </p>
      <p className="text-xs">
        {installation.resources.collections.length} collections, {installation.resources.seedRecords} seed records ·
        installation {installation.id}
      </p>
      <ul className="flex flex-wrap gap-2">
        {installation.resources.collections.map((c) => (
          <li key={c}>
            <button type="button" className={BUTTON} onClick={() => open(c)}>Open {c}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Errors ─────────────────────────────────────────────────────────────────

function describeError(error: unknown): string {
  if (error instanceof TemplateApiError) return describeTemplateError(error.code, error.message);
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function ErrorPanel({ error, retry }: { error: unknown; retry?: () => void }) {
  const issues: TemplateIssue[] = error instanceof TemplateApiError ? error.details.issues ?? [] : [];
  const conflicts = error instanceof TemplateApiError ? error.details.conflicts ?? [] : [];
  return (
    <div role="alert" className="mt-2 space-y-1 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
      <p className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" aria-hidden /> {describeError(error)}
        {error instanceof TemplateApiError && <code className="text-xs">({error.code})</code>}
      </p>
      {conflicts.length > 0 && <p className="text-xs">Existing collections: {conflicts.join(', ')}</p>}
      {issues.length > 0 && (
        <ul className="list-inside list-disc text-xs">
          {issues.map((issue, i) => (
            <li key={i}>
              <code>{Array.isArray(issue.path) ? issue.path.join('.') : issue.path}</code>: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {retry && error instanceof TemplateApiError && error.code === 'NETWORK' && (
        <button type="button" className={BUTTON} onClick={retry}>Retry</button>
      )}
    </div>
  );
}

function download(filename: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
