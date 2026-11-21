import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LumiError } from '@lumibase/sdk';
import { useState, type FormEvent, type ReactNode } from 'react';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Audience (epic #672): members, tiers, saved segments, newsletters,
 * email sequences, custom sending domains and the member Portal settings.
 *
 * Every call goes through `getApiClient()` so the shell's API base and bearer
 * apply (shell contract C2). Segment counts and send progress refetch on an
 * interval: a segment is a live filter, so its count moves as members sign up
 * or open mail without anyone pressing refresh.
 */

const M = '/api/v1/members';
const DOMAINS = '/api/v1/email/sending-domains';

type Tab = 'members' | 'segments' | 'tiers' | 'newsletters' | 'sequences' | 'domains' | 'portal';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'members', label: 'Members' },
  { id: 'segments', label: 'Segments' },
  { id: 'tiers', label: 'Tiers' },
  { id: 'newsletters', label: 'Newsletters' },
  { id: 'sequences', label: 'Sequences' },
  { id: 'domains', label: 'Sending domains' },
  { id: 'portal', label: 'Portal' },
];

export interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  status: 'free' | 'paid' | 'comped';
  tier: { id: string; key: string; name: string } | null;
  labels: string[];
  newsletters: Array<{ id: string; name: string }>;
  emailOpenRate: number | null;
  hasAccount: boolean;
}
export interface SegmentRow {
  id: string;
  name: string;
  count: number;
  filter: unknown;
}
export interface TierRow {
  id: string;
  key: string;
  name: string;
  kind: 'free' | 'paid';
  active: boolean;
  memberCount: number;
}
export interface NewsletterRow {
  id: string;
  key: string;
  name: string;
  status: string;
  subscriberCount: number;
  senderEmail: string | null;
}
export interface SendRow {
  id: string;
  subject: string;
  status: string;
  counters: { recipients: number; sent: number; failed: number; skipped: number; opened: number; clicked: number };
}
export interface SequenceRow {
  id: string;
  key: string;
  name: string;
  trigger: string;
  status: 'draft' | 'active' | 'paused';
  enrollments: Record<string, number>;
}
export interface DomainRecord {
  purpose: string;
  host: string;
  valueChunks: string;
  status: 'ok' | 'missing' | 'mismatch' | 'unchecked' | 'removable';
  note?: string;
}
export interface DomainRow {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  dkimSelector: string;
  rotation: { state: string; nextSelector: string | null; previousSelector: string | null };
  checks: { problems?: string[]; dmarcAligned?: boolean; dmarcPolicy?: string | null };
  records: DomainRecord[];
  lastCheckedAt: string | null;
}

export function messageOf(err: unknown): string {
  if (err instanceof LumiError) {
    const first = (err.body as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message;
    if (first) return first;
  }
  return err instanceof Error ? err.message : 'Request failed.';
}

function useApi() {
  const client = getApiClient();
  return {
    get: async <T,>(path: string) => (await client.rawRequest<T>(path)).data,
    send: async <T,>(path: string, method: string, body?: unknown) =>
      (await client.rawRequest<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).data,
  };
}

function Badge({ tone = 'muted', children }: { tone?: 'muted' | 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-xs',
        tone === 'ok' && 'bg-emerald-500/10 text-emerald-700',
        tone === 'warn' && 'bg-amber-500/10 text-amber-700',
        tone === 'bad' && 'bg-destructive/10 text-destructive',
        tone === 'muted' && 'bg-muted',
      )}
    >
      {children}
    </span>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {messageOf(error)}
    </p>
  );
}

const input = 'rounded border bg-background px-2 py-1 text-sm';
const button = 'rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50';

// ── Members ────────────────────────────────────────────────────────────────

function MembersTab() {
  const api = useApi();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [email, setEmail] = useState('');
  const segments = useQuery({ queryKey: ['member-segments'], queryFn: () => api.get<SegmentRow[]>(`${M}/segments`) });
  const tiers = useQuery({ queryKey: ['member-tiers'], queryFn: () => api.get<TierRow[]>(`${M}/tiers`) });
  const params = new URLSearchParams({ limit: '50', ...(search ? { search } : {}), ...(segmentId ? { segmentId } : {}) });
  const list = useQuery({
    queryKey: ['members', search, segmentId],
    queryFn: async () => (await getApiClient().rawRequest<MemberRow[]>(`${M}?${params}`)) as unknown as { data: MemberRow[]; meta: { total: number } },
  });
  const create = useMutation({
    mutationFn: () => api.send(M, 'POST', { email, status: 'free' }),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
  });
  const update = useMutation({
    mutationFn: (v: { id: string; status: string; tierId?: string | null }) => api.send(`${M}/${v.id}`, 'PATCH', { status: v.status, ...(v.tierId !== undefined ? { tierId: v.tierId } : {}) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.send(`${M}/${id}`, 'DELETE'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members'] }),
  });
  const paidTiers = (tiers.data ?? []).filter((t) => t.kind === 'paid');

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Search members" className={input} placeholder="Search email or name" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Segment" className={input} value={segmentId} onChange={(e) => setSegmentId(e.target.value)}>
          <option value="">All members</option>
          {(segments.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.count})
            </option>
          ))}
        </select>
        <span className="text-sm text-muted-foreground">{list.data?.meta.total ?? 0} members</span>
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input aria-label="New member email" type="email" required className={input} placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className={button} disabled={!email || create.isPending}>
          Add member
        </button>
      </form>
      <ErrorLine error={create.error ?? update.error ?? remove.error ?? list.error} />
      <table className="w-full text-sm">
        <thead>
          <tr className="text-start text-xs text-muted-foreground">
            <th className="text-start">Email</th>
            <th className="text-start">Status</th>
            <th className="text-start">Tier</th>
            <th className="text-start">Newsletters</th>
            <th className="text-start">Open rate</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(list.data?.data ?? []).map((m) => (
            <tr key={m.id} className="border-t">
              <td className="py-1">
                {m.email}
                {m.name ? <span className="ms-1 text-muted-foreground">({m.name})</span> : null}
              </td>
              <td>
                <select
                  aria-label={`Status of ${m.email}`}
                  className={input}
                  value={m.status}
                  onChange={(e) => {
                    const status = e.target.value;
                    update.mutate({ id: m.id, status, tierId: status === 'free' ? null : paidTiers[0]?.id ?? null });
                  }}
                >
                  <option value="free">free</option>
                  <option value="paid">paid</option>
                  <option value="comped">comped</option>
                </select>
              </td>
              <td>{m.tier?.name ?? '—'}</td>
              <td>{m.newsletters.map((n) => n.name).join(', ') || '—'}</td>
              <td>{m.emailOpenRate === null ? '—' : `${m.emailOpenRate}%`}</td>
              <td className="text-end">
                <button type="button" className="text-xs text-destructive" onClick={() => remove.mutate(m.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// ── Segments ───────────────────────────────────────────────────────────────

const EXAMPLE_FILTER = JSON.stringify({ match: 'all', conditions: [{ field: 'last_email_opened_at', op: 'older_than_days', value: 60 }] }, null, 2);

function SegmentsTab() {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [filter, setFilter] = useState(EXAMPLE_FILTER);
  // Live: counts re-evaluate server-side on every read.
  const list = useQuery({ queryKey: ['member-segments'], queryFn: () => api.get<SegmentRow[]>(`${M}/segments`), refetchInterval: 15_000 });
  const parsed = (() => {
    try {
      return { ok: true as const, value: JSON.parse(filter) as unknown };
    } catch {
      return { ok: false as const };
    }
  })();
  const preview = useQuery({
    queryKey: ['segment-preview', filter],
    enabled: parsed.ok,
    queryFn: () => api.send<{ count: number }>(`${M}/segments/preview`, 'POST', { filter: parsed.ok ? parsed.value : {}, limit: 1 }),
  });
  const create = useMutation({
    mutationFn: () => api.send(`${M}/segments`, 'POST', { name, filter: parsed.ok ? parsed.value : {} }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['member-segments'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.send(`${M}/segments/${id}`, 'DELETE'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['member-segments'] }),
  });
  return (
    <section className="space-y-3">
      <ul>
        {(list.data ?? []).map((s) => (
          <li key={s.id} className="flex items-center justify-between border-t py-1 text-sm">
            <span>
              {s.name} <Badge>{s.count}</Badge>
            </span>
            <button type="button" className="text-xs text-destructive" onClick={() => remove.mutate(s.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      <form
        className="space-y-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input aria-label="Segment name" className={input} placeholder="Segment name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea aria-label="Segment filter" className={cn(input, 'block h-32 w-full font-mono')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <p className="text-sm text-muted-foreground" data-testid="segment-preview">
          {!parsed.ok ? 'Filter is not valid JSON.' : preview.error ? messageOf(preview.error) : `Matches ${preview.data?.count ?? '…'} members now.`}
        </p>
        <button className={button} disabled={!name || !parsed.ok || create.isPending}>
          Save segment
        </button>
        <ErrorLine error={create.error} />
      </form>
    </section>
  );
}

// ── Tiers ──────────────────────────────────────────────────────────────────

function TiersTab() {
  const api = useApi();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [grant, setGrant] = useState<Record<string, string>>({});
  const list = useQuery({ queryKey: ['member-tiers'], queryFn: () => api.get<TierRow[]>(`${M}/tiers`) });
  const create = useMutation({
    mutationFn: () => api.send(`${M}/tiers`, 'POST', { key, name, kind: 'paid' }),
    onSuccess: () => {
      setKey('');
      setName('');
      void qc.invalidateQueries({ queryKey: ['member-tiers'] });
    },
  });
  const access = useMutation({ mutationFn: (v: { id: string; collection: string }) => api.send(`${M}/tiers/${v.id}/access`, 'PUT', { collection: v.collection }) });
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">Each tier owns a policy. Grant read on a collection here, or shape the policy in Access → Policies.</p>
      <ul>
        {(list.data ?? []).map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-2 border-t py-1 text-sm">
            <span className="font-medium">{t.name}</span> <Badge>{t.kind}</Badge> <span className="text-muted-foreground">{t.memberCount} members</span>
            <input aria-label={`Collection for ${t.name}`} className={cn(input, 'ms-auto')} placeholder="collection" value={grant[t.id] ?? ''} onChange={(e) => setGrant({ ...grant, [t.id]: e.target.value })} />
            <button type="button" className={button} disabled={!grant[t.id]} onClick={() => access.mutate({ id: t.id, collection: grant[t.id]! })}>
              Grant read
            </button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input aria-label="Tier key" className={input} placeholder="gold" value={key} onChange={(e) => setKey(e.target.value)} />
        <input aria-label="Tier name" className={input} placeholder="Gold" value={name} onChange={(e) => setName(e.target.value)} />
        <button className={button} disabled={!key || !name || create.isPending}>
          Add paid tier
        </button>
      </form>
      <ErrorLine error={create.error ?? access.error} />
    </section>
  );
}

// ── Newsletters ────────────────────────────────────────────────────────────

function SendForm({ newsletter }: { newsletter: NewsletterRow }) {
  const api = useApi();
  const qc = useQueryClient();
  const [collection, setCollection] = useState('posts');
  const [itemId, setItemId] = useState('');
  const [publish, setPublish] = useState(false);
  const sends = useQuery({
    queryKey: ['newsletter-sends', newsletter.id],
    queryFn: () => api.get<SendRow[]>(`${M}/newsletters/${newsletter.id}/sends`),
    refetchInterval: (q) => ((q.state.data ?? []).some((s) => s.status === 'queued' || s.status === 'sending') ? 3_000 : false),
  });
  const send = useMutation({
    mutationFn: () => api.send(`${M}/newsletters/${newsletter.id}/sends`, 'POST', { collection, itemId, publish }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['newsletter-sends', newsletter.id] }),
  });
  return (
    <div className="space-y-2 ps-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          send.mutate();
        }}
      >
        <input aria-label="Collection" className={input} value={collection} onChange={(e) => setCollection(e.target.value)} />
        <input aria-label="Item id" className={input} placeholder="item id" value={itemId} onChange={(e) => setItemId(e.target.value)} />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish &amp; send
        </label>
        <button className={button} disabled={!itemId || send.isPending}>
          Send
        </button>
      </form>
      <ErrorLine error={send.error} />
      <ul className="text-xs">
        {(sends.data ?? []).map((s) => (
          <li key={s.id}>
            {s.subject} — <Badge tone={s.status === 'sent' ? 'ok' : s.status === 'failed' ? 'bad' : 'muted'}>{s.status}</Badge> {s.counters.sent}/{s.counters.recipients} sent
            {s.counters.opened ? `, ${s.counters.opened} opened` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NewslettersTab() {
  const api = useApi();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const list = useQuery({ queryKey: ['newsletters'], queryFn: () => api.get<NewsletterRow[]>(`${M}/newsletters`) });
  const create = useMutation({
    mutationFn: () => api.send(`${M}/newsletters`, 'POST', { key, name }),
    onSuccess: () => {
      setKey('');
      setName('');
      void qc.invalidateQueries({ queryKey: ['newsletters'] });
    },
  });
  return (
    <section className="space-y-3">
      {(list.data ?? []).map((n) => (
        <div key={n.id} className="space-y-1 border-t pt-2">
          <div className="text-sm">
            <span className="font-medium">{n.name}</span> <Badge>{n.subscriberCount} subscribers</Badge> {n.status !== 'active' ? <Badge tone="warn">{n.status}</Badge> : null}
          </div>
          <SendForm newsletter={n} />
        </div>
      ))}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input aria-label="Newsletter key" className={input} placeholder="weekly" value={key} onChange={(e) => setKey(e.target.value)} />
        <input aria-label="Newsletter name" className={input} placeholder="Weekly digest" value={name} onChange={(e) => setName(e.target.value)} />
        <button className={button} disabled={!key || !name || create.isPending}>
          Add newsletter
        </button>
      </form>
      <ErrorLine error={create.error} />
    </section>
  );
}

// ── Sequences ──────────────────────────────────────────────────────────────

function SequencesTab() {
  const api = useApi();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['sequences'], queryFn: () => api.get<SequenceRow[]>(`${M}/sequences`) });
  const templates = useQuery({ queryKey: ['sequence-templates'], queryFn: () => api.get<Array<{ key: string; name: string; description: string }>>(`${M}/sequences/templates`) });
  const fromTemplate = useMutation({
    mutationFn: (template: string) => api.send(`${M}/sequences/from-template`, 'POST', { template }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sequences'] }),
  });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: string }) => api.send(`${M}/sequences/${v.id}`, 'PATCH', { status: v.status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sequences'] }),
  });
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(templates.data ?? []).map((t) => (
          <button key={t.key} type="button" className={button} title={t.description} onClick={() => fromTemplate.mutate(t.key)}>
            + {t.name}
          </button>
        ))}
      </div>
      <ErrorLine error={fromTemplate.error ?? setStatus.error} />
      <ul>
        {(list.data ?? []).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 border-t py-1 text-sm">
            <span className="font-medium">{s.name}</span> <Badge>{s.trigger}</Badge>
            <Badge tone={s.status === 'active' ? 'ok' : 'muted'}>{s.status}</Badge>
            <span className="text-xs text-muted-foreground">
              {Object.entries(s.enrollments)
                .map(([k, v]) => `${v} ${k}`)
                .join(' · ') || 'no enrolments'}
            </span>
            <button type="button" className={cn(button, 'ms-auto')} onClick={() => setStatus.mutate({ id: s.id, status: s.status === 'active' ? 'paused' : 'active' })}>
              {s.status === 'active' ? 'Pause' : 'Activate'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Sending domains ────────────────────────────────────────────────────────

const RECORD_TONE: Record<DomainRecord['status'], 'ok' | 'warn' | 'bad' | 'muted'> = { ok: 'ok', missing: 'bad', mismatch: 'bad', unchecked: 'muted', removable: 'warn' };

export function DomainsTab() {
  const api = useApi();
  const qc = useQueryClient();
  const [domain, setDomain] = useState('');
  const list = useQuery({ queryKey: ['sending-domains'], queryFn: () => api.get<DomainRow[]>(DOMAINS) });
  const add = useMutation({
    mutationFn: () => api.send(DOMAINS, 'POST', { domain }),
    onSuccess: () => {
      setDomain('');
      void qc.invalidateQueries({ queryKey: ['sending-domains'] });
    },
  });
  const action = useMutation({
    mutationFn: (v: { id: string; op: 'check' | 'rotate' }) => api.send(`${DOMAINS}/${v.id}/${v.op}`, 'POST'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sending-domains'] }),
  });
  return (
    <section className="space-y-4">
      {(list.data ?? []).map((d) => (
        <div key={d.id} className="space-y-2 border-t pt-2" data-testid={`domain-${d.domain}`}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{d.domain}</span>
            <Badge tone={d.status === 'verified' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn'}>{d.status}</Badge>
            {d.checks.dmarcAligned === false ? <Badge tone="warn">DMARC not aligned</Badge> : null}
            {d.rotation.state !== 'idle' ? <Badge>{d.rotation.state.replace(/_/g, ' ')}</Badge> : null}
            <button type="button" className={cn(button, 'ms-auto')} onClick={() => action.mutate({ id: d.id, op: 'check' })}>
              Check DNS
            </button>
            <button type="button" className={button} disabled={!!d.rotation.nextSelector || d.status !== 'verified'} onClick={() => action.mutate({ id: d.id, op: 'rotate' })}>
              Rotate DKIM
            </button>
          </div>
          <table className="w-full table-fixed text-xs">
            <tbody>
              {d.records.map((r) => (
                <tr key={`${r.purpose}-${r.host}`} className="border-t align-top">
                  <td className="w-24 py-1">
                    {r.purpose} <Badge tone={RECORD_TONE[r.status]}>{r.status}</Badge>
                  </td>
                  <td className="w-56 break-all font-mono">{r.host}</td>
                  <td className="break-all font-mono">
                    {r.valueChunks}
                    {r.note ? <div className="font-sans text-muted-foreground">{r.note}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(d.checks.problems ?? []).map((p) => (
            <p key={p} className="text-xs text-amber-700">
              {p}
            </p>
          ))}
        </div>
      ))}
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <input aria-label="Sending domain" className={input} placeholder="news.example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <button className={button} disabled={!domain || add.isPending}>
          Add domain
        </button>
      </form>
      <ErrorLine error={add.error ?? action.error} />
    </section>
  );
}

// ── Portal ─────────────────────────────────────────────────────────────────

interface PortalSettings {
  portalEnabled: boolean;
  allowSelfSignup: boolean;
  redirectUris: string[];
  signupCopy: Record<string, Record<string, string>>;
}

function PortalTab() {
  const api = useApi();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['member-settings'], queryFn: () => api.get<PortalSettings>(`${M}/settings`) });
  const [draft, setDraft] = useState<{ uris: string; copy: string } | null>(null);
  const current = draft ?? {
    uris: (settings.data?.redirectUris ?? []).join('\n'),
    copy: JSON.stringify(settings.data?.signupCopy ?? {}, null, 2),
  };
  const save = useMutation({
    mutationFn: (patch: Partial<PortalSettings>) => api.send(`${M}/settings`, 'PATCH', patch),
    onSuccess: () => {
      setDraft(null);
      void qc.invalidateQueries({ queryKey: ['member-settings'] });
    },
  });
  const install = useMutation({ mutationFn: () => api.send<{ created: boolean }>(`${M}/signup-card/install`, 'POST') });
  let copyError: string | null = null;
  let copyValue: Record<string, Record<string, string>> = {};
  try {
    copyValue = JSON.parse(current.copy) as Record<string, Record<string, string>>;
  } catch {
    copyError = 'Signup copy must be JSON: { "vi": { "button": "Đăng ký" } }';
  }
  return (
    <section className="space-y-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!settings.data?.portalEnabled} onChange={(e) => save.mutate({ portalEnabled: e.target.checked })} /> Enable the member Portal
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!settings.data?.allowSelfSignup} onChange={(e) => save.mutate({ allowSelfSignup: e.target.checked })} /> Visitors may sign up
      </label>
      <label className="block">
        Magic-link landing URLs (one per line, exact match)
        <textarea aria-label="Landing URLs" className={cn(input, 'block h-20 w-full font-mono')} value={current.uris} onChange={(e) => setDraft({ ...current, uris: e.target.value })} />
      </label>
      <label className="block">
        Signup card copy per locale
        <textarea aria-label="Signup copy" className={cn(input, 'block h-32 w-full font-mono')} value={current.copy} onChange={(e) => setDraft({ ...current, copy: e.target.value })} />
      </label>
      {copyError ? <p className="text-destructive">{copyError}</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          disabled={!!copyError || save.isPending}
          onClick={() => save.mutate({ redirectUris: current.uris.split('\n').map((s) => s.trim()).filter(Boolean), signupCopy: copyValue })}
        >
          Save
        </button>
        <button type="button" className={button} onClick={() => install.mutate()}>
          Install signup card block
        </button>
      </div>
      {install.data ? <p className="text-muted-foreground">Signup card block {install.data.created ? 'installed' : 'already installed'}.</p> : null}
      <ErrorLine error={save.error ?? install.error} />
    </section>
  );
}

export function AudiencePage({ initialTab = 'members' }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">Audience</h1>
      <div role="tablist" className="flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            className={cn('px-3 py-1 text-sm', tab === t.id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'members' && <MembersTab />}
      {tab === 'segments' && <SegmentsTab />}
      {tab === 'tiers' && <TiersTab />}
      {tab === 'newsletters' && <NewslettersTab />}
      {tab === 'sequences' && <SequencesTab />}
      {tab === 'domains' && <DomainsTab />}
      {tab === 'portal' && <PortalTab />}
    </div>
  );
}
