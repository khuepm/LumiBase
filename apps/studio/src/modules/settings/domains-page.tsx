import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DomainResource } from '@lumibase/sdk';
import {
  Globe,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Check,
  Copy,
  AlertTriangle,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api';

/** Free subdomain suffix offered to every site. Mirrors the CMS default. */
const FREE_SUFFIX = 'lumibase.dev';

/** Link to the enterprise docs section for custom domains. */
const DOCS_URL = 'https://docs.lumibase.dev/enterprise/custom-domains/setup-custom-domain';

export function DomainsSettingsPage() {
  const client = getApiClient();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['domains'],
    queryFn: async () => (await client.domains.list()).data,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['domains'] });

  const verify = useMutation({
    mutationFn: (id: string) => client.domains.verify(id),
    onSuccess: invalidate,
  });
  const setPrimary = useMutation({
    mutationFn: (id: string) => client.domains.setPrimary(id),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.domains.delete(id),
    onSuccess: invalidate,
  });

  const [dialogOpen, setDialogOpen] = useState(false);

  const domains = query.data ?? [];
  const subdomains = domains.filter((d) => d.kind === 'subdomain');
  const custom = domains.filter((d) => d.kind === 'custom');

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Domains</h1>
          <p className="text-sm text-muted-foreground">
            Every site gets a free <code className="font-mono">{FREE_SUFFIX}</code> address. Connect
            your own domain and we provision the SSL certificate automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Setup domain
        </button>
      </header>

      {query.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : query.isError ? (
        <p className="text-destructive">Failed to load domains.</p>
      ) : (
        <>
          <Section icon={Globe} title="Free subdomain">
            {subdomains.length === 0 ? (
              <EmptyHint>
                No free subdomain yet. Use <strong>Setup domain</strong> and pick “Free subdomain”.
              </EmptyHint>
            ) : (
              <ul className="space-y-2">
                {subdomains.map((d) => (
                  <DomainRow
                    key={d.id}
                    domain={d}
                    onVerify={() => verify.mutate(d.id)}
                    onPrimary={() => setPrimary.mutate(d.id)}
                    onRemove={() => remove.mutate(d.id)}
                    busy={verify.isPending || setPrimary.isPending || remove.isPending}
                  />
                ))}
              </ul>
            )}
          </Section>

          <Section icon={Globe} title="Custom domains">
            {custom.length === 0 ? (
              <EmptyHint>
                Connect a domain you own (e.g. <code className="font-mono">cms.acme.com</code>).
              </EmptyHint>
            ) : (
              <ul className="space-y-4">
                {custom.map((d) => (
                  <DomainRow
                    key={d.id}
                    domain={d}
                    onVerify={() => verify.mutate(d.id)}
                    onPrimary={() => setPrimary.mutate(d.id)}
                    onRemove={() => remove.mutate(d.id)}
                    busy={verify.isPending || setPrimary.isPending || remove.isPending}
                    showRecords
                  />
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      {dialogOpen ? (
        <SetupDialog
          onClose={() => setDialogOpen(false)}
          onCreated={() => {
            invalidate();
            setDialogOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

// ── Domain row ─────────────────────────────────────────────────────────────
function DomainRow({
  domain,
  onVerify,
  onPrimary,
  onRemove,
  busy,
  showRecords,
}: {
  domain: DomainResource;
  onVerify: () => void;
  onPrimary: () => void;
  onRemove: () => void;
  busy: boolean;
  showRecords?: boolean;
}) {
  return (
    <li className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-sm">{domain.hostname}</span>
          {domain.isPrimary ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <Star className="h-3 w-3" /> Primary
            </span>
          ) : null}
          <StatusBadge status={domain.status} />
        </div>
        <div className="flex items-center gap-1">
          {domain.status !== 'active' ? (
            <IconBtn label="Verify" onClick={onVerify} disabled={busy} icon={RefreshCw} />
          ) : !domain.isPrimary ? (
            <IconBtn label="Set primary" onClick={onPrimary} disabled={busy} icon={Star} />
          ) : null}
          <IconBtn label="Remove" onClick={onRemove} disabled={busy} icon={Trash2} danger />
        </div>
      </div>

      {domain.statusReason ? (
        <p className="mt-2 text-xs text-destructive">{domain.statusReason}</p>
      ) : null}

      {showRecords && domain.status !== 'active' && domain.verification.records.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Add these records at your DNS provider, then click Verify:
          </p>
          <DnsRecords records={domain.verification.records} />
        </div>
      ) : null}
    </li>
  );
}

// ── Setup dialog ─────────────────────────────────────────────────────────────
function SetupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const client = getApiClient();
  const kindId = useId();
  const hostId = useId();
  const [kind, setKind] = useState<'subdomain' | 'custom'>('custom');
  const [hostname, setHostname] = useState('');
  const [created, setCreated] = useState<DomainResource | null>(null);

  const create = useMutation({
    mutationFn: () => client.domains.create({ kind, hostname: hostname.trim().toLowerCase() }),
    onSuccess: (res) => setCreated(res.data),
  });

  const errorMsg = create.isError
    ? /DOMAIN_TAKEN/i.test(String(create.error))
      ? 'That domain is already in use.'
      : /VALIDATION/i.test(String(create.error))
        ? kind === 'subdomain'
          ? 'Enter a single label like “acme”.'
          : 'Enter a valid domain like cms.example.com.'
        : 'Could not create the domain.'
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border bg-background p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {created ? (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">
              {created.status === 'active' ? 'Domain ready' : 'Almost there'}
            </h2>
            {created.status === 'active' ? (
              <p className="text-sm text-muted-foreground">
                <code className="font-mono">{created.hostname}</code> is live.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Add these records at your DNS provider for{' '}
                  <code className="font-mono">{created.hostname}</code>. SSL is issued automatically
                  once they propagate — usually a few minutes.
                </p>
                <DnsRecords records={created.verification.records} />
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Step-by-step guide <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onCreated}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <h2 className="text-lg font-semibold">Setup a domain</h2>

            <div className="space-y-1">
              <label htmlFor={kindId} className="block text-sm font-medium">
                Type
              </label>
              <select
                id={kindId}
                value={kind}
                onChange={(e) => setKind(e.target.value as 'subdomain' | 'custom')}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="custom">Custom domain (your own)</option>
                <option value="subdomain">Free subdomain ({FREE_SUFFIX})</option>
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor={hostId} className="block text-sm font-medium">
                {kind === 'subdomain' ? 'Subdomain label' : 'Domain'}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={hostId}
                  autoFocus
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder={kind === 'subdomain' ? 'acme' : 'cms.acme.com'}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                />
                {kind === 'subdomain' ? (
                  <span className="shrink-0 font-mono text-sm text-muted-foreground">
                    .{FREE_SUFFIX}
                  </span>
                ) : null}
              </div>
              {errorMsg ? <p className="text-xs text-destructive">{errorMsg}</p> : null}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border px-4 py-2 text-sm hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={create.isPending || hostname.trim().length === 0}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {create.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ── DNS records table ─────────────────────────────────────────────────────────
function DnsRecords({ records }: { records: DomainResource['verification']['records'] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">Type</th>
            <th className="px-2 py-1.5 font-medium">Name</th>
            <th className="px-2 py-1.5 font-medium">Value</th>
            <th className="px-2 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={`${r.type}-${i}`} className="border-t">
              <td className="px-2 py-1.5 font-mono">{r.type}</td>
              <td className="max-w-[8rem] truncate px-2 py-1.5 font-mono" title={r.name}>
                {r.name}
              </td>
              <td className="max-w-[12rem] truncate px-2 py-1.5 font-mono" title={r.value}>
                {r.value}
              </td>
              <td className="px-2 py-1.5">
                <CopyButton value={r.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy value"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

// ── Primitives ─────────────────────────────────────────────────────────────
const STATUS_STYLE: Record<DomainResource['status'], { label: string; cls: string }> = {
  active: { label: 'Active', cls: 'bg-emerald-500/10 text-emerald-600' },
  verifying: { label: 'Verifying', cls: 'bg-amber-500/10 text-amber-600' },
  pending_dns: { label: 'Pending DNS', cls: 'bg-amber-500/10 text-amber-600' },
  failed: { label: 'Failed', cls: 'bg-destructive/10 text-destructive' },
};

function StatusBadge({ status }: { status: DomainResource['status'] }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  icon: Icon,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon: LucideIcon;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md p-2 transition hover:bg-accent disabled:opacity-40 ${
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export default DomainsSettingsPage;
