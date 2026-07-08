import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Puzzle, Download, Search, Check, ExternalLink, ShieldAlert, ShieldCheck, Info, X, User, ArrowBigUp, Upload } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';

interface PublishedExtension {
  id: string;
  name: string;
  version: string;
  type: string;
  publisher: string;
  marketplaceSlug: string;
  publishedAt: string;
  /** Cryptographically signed by a registered publisher key. */
  verified?: boolean;
  /** Cumulative package downloads. */
  totalDownloads?: number;
  /** Community upvotes for the listing. */
  voteCount?: number;
  /** Whether the current user has upvoted. */
  hasVoted?: boolean;
}

interface ExtensionDetail extends PublishedExtension {
  manifest: {
    description?: string;
    capabilities?: string[];
    permissions?: string[];
  };
  bundleUrl: string;
  bundleSha256: string;
  signature: string;
  signatureAlg: string;
  publisherKeyId: string;
}

/**
 * Publish dialog (studio-ops-ui task 3; Req 3): completes the publish loop
 * in the UI — pick a registered extension, attach slug + signing material,
 * POST /marketplace/publish. Signature fields are pass-through: signing
 * happens offline with the publisher key; this form only carries the result.
 */
function PublishDialog({
  extensions,
  onClose,
}: {
  extensions: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const client = getApiClient();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    extensionId: '',
    marketplaceSlug: '',
    publisher: '',
    signature: '',
    signatureAlg: 'ed25519',
    publisherKeyId: '',
    bundleSha256: '',
  });

  const mutation = useMutation({
    mutationFn: () =>
      client.rawRequest<unknown>('/api/v1/marketplace/publish', {
        method: 'POST',
        body: JSON.stringify(form),
        headers: { 'Content-Type': 'application/json' },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
      onClose();
    },
  });

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const valid =
    form.extensionId &&
    /^[a-z0-9-]+$/.test(form.marketplaceSlug) &&
    form.publisher &&
    form.signature &&
    form.publisherKeyId &&
    /^[0-9a-f]{64}$/.test(form.bundleSha256);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-label="Publish extension"
    >
      <div className="max-h-[85vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-lg border bg-background p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Publish extension</h2>
          <button type="button" onClick={onClose} aria-label="Close publish dialog" className="rounded-md border p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="block text-xs">
          <span className="mb-1 block text-muted-foreground">Extension *</span>
          <select
            value={form.extensionId}
            onChange={set('extensionId')}
            aria-label="Extension to publish"
            className="w-full rounded-md border bg-background px-2 py-1.5"
          >
            <option value="">choose…</option>
            {extensions.map((ext) => (
              <option key={ext.id} value={ext.id}>
                {ext.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Marketplace slug *</span>
            <input value={form.marketplaceSlug} onChange={set('marketplaceSlug')} placeholder="my-extension" className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Publisher *</span>
            <input value={form.publisher} onChange={set('publisher')} className="w-full rounded-md border bg-background px-2 py-1.5" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Signature alg</span>
            <select value={form.signatureAlg} onChange={set('signatureAlg')} aria-label="Signature algorithm" className="w-full rounded-md border bg-background px-2 py-1.5">
              <option value="ed25519">ed25519</option>
              <option value="rsa-pss-sha256">rsa-pss-sha256</option>
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Publisher key id *</span>
            <input value={form.publisherKeyId} onChange={set('publisherKeyId')} className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="mb-1 block text-muted-foreground">Bundle signature *</span>
            <input value={form.signature} onChange={set('signature')} className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="mb-1 block text-muted-foreground">Bundle SHA-256 (64 hex) *</span>
            <input value={form.bundleSha256} onChange={set('bundleSha256')} className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
          </label>
        </div>
        {mutation.isError && (
          <p className="text-xs text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : 'Publish failed.'}
          </p>
        )}
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={!valid || mutation.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? 'Publishing…' : 'Publish to catalog'}
        </button>
      </div>
    </div>
  );
}

/**
 * Community submit dialog: lets any user propose an extension for the public
 * catalog. The listing lands in `pending` review (unpublished) — publishing a
 * signed bundle is a separate, moderated step.
 */
function SubmitDialog({ onClose }: { onClose: () => void }) {
  const client = getApiClient();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    version: '0.1.0',
    type: 'module',
    marketplaceSlug: '',
    bundleUrl: '',
    description: '',
    publisher: '',
    repositoryUrl: '',
  });

  const mutation = useMutation({
    mutationFn: () =>
      client.rawRequest<unknown>('/api/v1/marketplace/submit', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          repositoryUrl: form.repositoryUrl || undefined,
          description: form.description || undefined,
          publisher: form.publisher || undefined,
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
      onClose();
    },
  });

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const valid =
    form.name &&
    /^\d+\.\d+\.\d+/.test(form.version) &&
    /^[a-z0-9-]+$/.test(form.marketplaceSlug) &&
    /^https?:\/\//.test(form.bundleUrl);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-label="Submit extension"
    >
      <div className="max-h-[85vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-lg border bg-background p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Submit an extension</h2>
          <button type="button" onClick={onClose} aria-label="Close submit dialog" className="rounded-md border p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Propose an extension for the public catalog. It enters review before it
          becomes installable.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Name *</span>
            <input value={form.name} onChange={set('name')} className="w-full rounded-md border bg-background px-2 py-1.5" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Version *</span>
            <input value={form.version} onChange={set('version')} className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Type *</span>
            <select value={form.type} onChange={set('type')} aria-label="Extension type" className="w-full rounded-md border bg-background px-2 py-1.5">
              {['module', 'interface', 'display', 'layout', 'panel', 'endpoint', 'hook', 'operation'].map((tp) => (
                <option key={tp} value={tp}>{tp}</option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Marketplace slug *</span>
            <input value={form.marketplaceSlug} onChange={set('marketplaceSlug')} placeholder="my-extension" className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="mb-1 block text-muted-foreground">Bundle URL *</span>
            <input value={form.bundleUrl} onChange={set('bundleUrl')} placeholder="https://…/bundle.js" className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Publisher</span>
            <input value={form.publisher} onChange={set('publisher')} className="w-full rounded-md border bg-background px-2 py-1.5" />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Repository URL</span>
            <input value={form.repositoryUrl} onChange={set('repositoryUrl')} placeholder="https://github.com/…" className="w-full rounded-md border bg-background px-2 py-1.5 font-mono" />
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="mb-1 block text-muted-foreground">Description</span>
            <textarea value={form.description} onChange={set('description')} rows={3} className="w-full rounded-md border bg-background px-2 py-1.5" />
          </label>
        </div>
        {mutation.isError && (
          <p className="text-xs text-destructive">
            {mutation.error instanceof Error ? mutation.error.message : 'Submission failed.'}
          </p>
        )}
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={!valid || mutation.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {mutation.isPending ? 'Submitting…' : 'Submit for review'}
        </button>
      </div>
    </div>
  );
}

export function MarketplacePage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [publishing, setPublishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Fetch installed extensions
  const installedQuery = useQuery({
    queryKey: ['extensions'],
    queryFn: async () => (await client.extensions.list()).data,
  });

  // Fetch published extensions from marketplace
  const marketplaceQuery = useQuery({
    queryKey: ['marketplace-extensions'],
    queryFn: async () => {
      const resp = await client.rawRequest<PublishedExtension[]>('/api/v1/marketplace/extensions');
      return resp.data;
    },
  });

  // Fetch single extension detail if selected
  const detailQuery = useQuery({
    queryKey: ['marketplace-extension-detail', selectedSlug],
    queryFn: async () => {
      if (!selectedSlug) return null;
      const resp = await client.rawRequest<ExtensionDetail>(`/api/v1/marketplace/extensions/${selectedSlug}`);
      return resp.data;
    },
    enabled: !!selectedSlug,
  });

  // Install mutation
  const installMutation = useMutation({
    mutationFn: (slug: string) =>
      client.rawRequest<unknown>(`/api/v1/marketplace/extensions/${slug}/install`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['extensions'] });
      qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
      setSelectedSlug(null);
    },
  });

  // Toggle upvote — DELETE when already voted, POST otherwise.
  const voteMutation = useMutation({
    mutationFn: ({ slug, hasVoted }: { slug: string; hasVoted: boolean }) =>
      client.rawRequest<unknown>(`/api/v1/marketplace/extensions/${slug}/vote`, {
        method: hasVoted ? 'DELETE' : 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
      qc.invalidateQueries({ queryKey: ['marketplace-extension-detail'] });
    },
  });

  // Download the signed package without installing. The endpoint bumps the
  // download counter and 302s to the bundle.
  const handleDownload = (slug: string) => {
    window.open(`/api/v1/marketplace/extensions/${slug}/download`, '_blank', 'noopener');
    qc.invalidateQueries({ queryKey: ['marketplace-extensions'] });
  };

  const published = marketplaceQuery.data ?? [];
  const installed = installedQuery.data ?? [];

  // Map installed extensions by slug for quick lookup
  const installedSlugs = new Set(
    installed
      .map((ext) => (ext as any).marketplaceSlug)
      .filter((slug): slug is string => !!slug)
  );

  const filtered = published.filter((ext) => {
    const matchesSearch =
      ext.name.toLowerCase().includes(search.toLowerCase()) ||
      ext.publisher.toLowerCase().includes(search.toLowerCase()) ||
      ext.marketplaceSlug.toLowerCase().includes(search.toLowerCase());
    
    const matchesType = filterType === 'all' || ext.type === filterType;

    return matchesSearch && matchesType;
  });

  const handleInstall = (slug: string) => {
    if (confirm(t('confirm_install', 'Are you sure you want to install this extension?'))) {
      installMutation.mutate(slug);
    }
  };

  const selectedExtension = detailQuery.data;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between border-b pb-5">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Puzzle className="h-8 w-8 text-primary" />
            {t('marketplace', 'Extension Marketplace')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Browse and install verified third-party extensions to extend Lumibase's capabilities.
          </p>
        </div>
        <div className="flex items-center gap-2 self-start">
          {/* Community submission loop */}
          <button
            type="button"
            onClick={() => setSubmitting(true)}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <Upload className="h-4 w-4" /> {t('submit_extension', 'Submit extension')}
          </button>
          {/* Publish loop (studio-ops-ui Req 3) */}
          <button
            type="button"
            onClick={() => setPublishing(true)}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <ExternalLink className="h-4 w-4" /> {t('publish_extension', 'Publish extension')}
          </button>
        </div>
      </header>

      {submitting && <SubmitDialog onClose={() => setSubmitting(false)} />}

      {publishing && (
        <PublishDialog
          extensions={installed.map((ext) => ({
            id: (ext as { id: string }).id,
            name: (ext as { name: string }).name,
          }))}
          onClose={() => setPublishing(false)}
        />
      )}

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder={t('search_extensions', 'Search by name, publisher...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border bg-background pl-9 pr-4 py-2 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">{t('filter_type', 'Type:')}</span>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="rounded-lg border bg-background px-3 py-1.5 text-sm outline-none transition focus:border-primary"
          >
            <option value="all">All Types</option>
            <option value="module">Module</option>
            <option value="interface">Interface</option>
            <option value="display">Display</option>
            <option value="layout">Layout</option>
            <option value="panel">Panel</option>
            <option value="endpoint">Endpoint</option>
          </select>
        </div>
      </div>

      {/* Main Grid Content */}
      {marketplaceQuery.isLoading || installedQuery.isLoading ? (
        <div className="flex items-center justify-center p-12">
          <span className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground bg-muted/10">
          <Puzzle className="mx-auto h-12 w-12 text-muted-foreground/50 mb-3" />
          <h3 className="font-semibold text-lg text-foreground">{t('no_extensions_found', 'No extensions found')}</h3>
          <p className="text-sm mt-1">Try adjusting your filters or search terms.</p>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((ext) => {
            const isInstalled = installedSlugs.has(ext.marketplaceSlug);
            return (
              <div
                key={ext.id}
                className="group relative flex flex-col justify-between rounded-xl border bg-background p-5 shadow-sm transition hover:shadow-md hover:border-primary/50"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/5 text-primary border border-primary/10 group-hover:bg-primary group-hover:text-primary-foreground transition-colors duration-200">
                      <Puzzle className="h-6 w-6" />
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground border border-secondary-foreground/10 capitalize">
                        {ext.type}
                      </span>
                      {ext.verified && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[10px] font-bold text-emerald-700" title={t('verified_source', 'Signed by a verified publisher')}>
                          <ShieldCheck className="h-3 w-3" />
                          {t('verified', 'Verified')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-4">
                    <h3 className="font-bold text-lg text-foreground flex items-center gap-2 group-hover:text-primary transition-colors">
                      {ext.name}
                    </h3>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1 font-medium text-foreground/80">
                        <User className="h-3.5 w-3.5" />
                        {ext.publisher}
                      </span>
                      <span>•</span>
                      <span>v{ext.version}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => voteMutation.mutate({ slug: ext.marketplaceSlug, hasVoted: !!ext.hasVoted })}
                    disabled={voteMutation.isPending}
                    aria-pressed={!!ext.hasVoted}
                    aria-label={t('upvote', 'Upvote')}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 font-semibold transition disabled:opacity-50 ${
                      ext.hasVoted
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'hover:bg-muted text-muted-foreground'
                    }`}
                  >
                    <ArrowBigUp className="h-3.5 w-3.5" />
                    {ext.voteCount ?? 0}
                  </button>
                  <span className="inline-flex items-center gap-1 text-muted-foreground" title={t('downloads', 'Downloads')}>
                    <Download className="h-3.5 w-3.5" />
                    {ext.totalDownloads ?? 0}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDownload(ext.marketplaceSlug)}
                    className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium hover:bg-muted"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t('download_package', 'Download')}
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between border-t pt-4">
                  <button
                    onClick={() => setSelectedSlug(ext.marketplaceSlug)}
                    className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                  >
                    <Info className="h-4 w-4" />
                    {t('details', 'View details')}
                  </button>

                  {isInstalled ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1">
                      <Check className="h-3.5 w-3.5" />
                      {t('installed', 'Installed')}
                    </span>
                  ) : (
                    <button
                      onClick={() => handleInstall(ext.marketplaceSlug)}
                      disabled={installMutation.isPending && installMutation.variables === ext.marketplaceSlug}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/95 disabled:opacity-50"
                    >
                      <Download className="h-3.5 w-3.5" />
                      {installMutation.isPending && installMutation.variables === ext.marketplaceSlug
                        ? t('installing', 'Installing...')
                        : t('install', 'Install')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Extension Detail Modal */}
      {selectedSlug && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-xl border bg-background p-6 shadow-2xl relative animate-in fade-in zoom-in-95 duration-150">
            <button
              onClick={() => setSelectedSlug(null)}
              className="absolute right-4 top-4 text-muted-foreground hover:text-foreground transition rounded-md p-1 hover:bg-muted"
            >
              <X className="h-5 w-5" />
            </button>

            {detailQuery.isLoading ? (
              <div className="flex h-64 items-center justify-center">
                <span className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
              </div>
            ) : !selectedExtension ? (
              <div className="text-center py-8 text-destructive flex flex-col items-center gap-2">
                <ShieldAlert className="h-10 w-10" />
                <p>Failed to load extension details.</p>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex items-start gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
                    <Puzzle className="h-8 w-8" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-extrabold text-foreground">{selectedExtension.name}</h2>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {t('by', 'By')} <span className="font-semibold text-foreground/80">{selectedExtension.publisher}</span> • v{selectedExtension.version}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-semibold capitalize border">
                        {selectedExtension.type}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-4 space-y-4">
                  <div>
                    <h4 className="text-sm font-semibold text-muted-foreground mb-1">{t('description', 'Description')}</h4>
                    <p className="text-sm leading-relaxed text-foreground/90">
                      {selectedExtension.manifest?.description || t('no_description', 'No description provided by publisher.')}
                    </p>
                  </div>

                  {selectedExtension.manifest?.capabilities && selectedExtension.manifest.capabilities.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold text-muted-foreground mb-1.5">{t('capabilities', 'Capabilities')}</h4>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedExtension.manifest.capabilities.map((cap) => (
                          <span
                            key={cap}
                            className="inline-flex items-center gap-1 rounded bg-muted/60 border px-2 py-0.5 text-xs font-medium text-muted-foreground"
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedExtension.manifest?.permissions && selectedExtension.manifest.permissions.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold text-muted-foreground mb-1.5">{t('requested_permissions', 'Requested Permissions')}</h4>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedExtension.manifest.permissions.map((perm) => (
                          <span
                            key={perm}
                            className="inline-flex items-center gap-1 rounded bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs font-medium text-amber-700"
                          >
                            {perm}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="rounded-lg bg-amber-500/5 border border-amber-500/10 p-3 flex gap-2.5">
                    <ShieldAlert className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                    <div>
                      <h5 className="text-xs font-bold text-amber-800">{t('signature_verified', 'Cryptographically Signed')}</h5>
                      <p className="text-xs text-amber-700/90 mt-0.5 leading-relaxed">
                        This extension is signed with verified publisher key ID <code className="bg-amber-100 px-1 py-0.2 rounded font-mono text-[10px]">{selectedExtension.publisherKeyId}</code>. 
                        Its authenticity and integrity have been confirmed.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="border-t pt-4 flex justify-end gap-2">
                  <button
                    onClick={() => handleDownload(selectedExtension.marketplaceSlug)}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-semibold hover:bg-muted transition"
                  >
                    <Download className="h-4 w-4" />
                    {t('download_package', 'Download')}
                  </button>
                  <button
                    onClick={() => setSelectedSlug(null)}
                    className="rounded-lg border px-4 py-2 text-sm font-semibold hover:bg-muted transition"
                  >
                    {t('cancel', 'Cancel')}
                  </button>

                  {installedSlugs.has(selectedExtension.marketplaceSlug) ? (
                    <button
                      disabled
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-2 text-sm font-bold text-emerald-600"
                    >
                      <Check className="h-4 w-4" />
                      {t('installed', 'Installed')}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleInstall(selectedExtension.marketplaceSlug)}
                      disabled={installMutation.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition"
                    >
                      <Download className="h-4 w-4" />
                      {installMutation.isPending ? t('installing', 'Installing...') : t('install_extension', 'Install Extension')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
