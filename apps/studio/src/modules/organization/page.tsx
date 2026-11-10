import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { canOrg, type OrgRole } from '@lumibase/contracts';
import { getActiveSite, getApiClient, getSessionGeneration } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import type {
  Organization,
  OrganizationApproval,
} from '@/lib/organization-api';
import { useOrganization } from './use-organizations';

const input =
  'rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60';
const button =
  'rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50';
function errorMessage(error: unknown) {
  const value = error as {
    body?: { errors?: Array<{ code?: string }> };
    message?: string;
  } | null;
  const code = value?.body?.errors?.[0]?.code;
  const messages: Record<string, string> = {
    LAST_OWNER: 'At least one owner must remain.',
    ORGANIZATION_NOT_EMPTY:
      'Move or delete all sites before deleting this organization.',
    ORGANIZATION_FORBIDDEN:
      'Your current organization role does not allow this action.',
    NOT_FOUND: 'This resource is no longer available to your account.',
    REQUESTER_REVOKED:
      'The requester no longer has access. Reject this request and ask for a new one.',
    MCP_DISABLED:
      'Organization MCP is disabled. Enable it before approving requests.',
    APPROVAL_ALREADY_DECIDED:
      'Someone already decided this request. Refresh to see the result.',
    VALIDATION: 'Check the entered values and try again.',
    CONFLICT: 'That name or identifier is already in use.',
  };
  return (
    (code && messages[code]) ||
    value?.message ||
    'The action could not be completed.'
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Secret({
  token,
  onDismiss,
}: {
  token: string;
  onDismiss: () => void;
}) {
  const [message, setMessage] = useState('');
  return (
    <section
      className="space-y-2 rounded-lg border border-amber-500 p-4"
      aria-label="Organization key receipt"
    >
      <h3 className="font-medium">Save your organization key</h3>
      <p className="text-sm text-muted-foreground">
        Anyone with this key can administer this organization. Store it
        securely.
      </p>
      <textarea
        aria-label="New organization key"
        readOnly
        value={token}
        className={`${input} w-full font-mono`}
      />
      <div className="flex gap-2">
        <button
          className={button}
          onClick={async () => {
            try {
              if (!navigator.clipboard?.writeText) throw new Error();
              await navigator.clipboard.writeText(token);
              setMessage('Copied.');
            } catch {
              setMessage('Select the key above and copy it manually.');
            }
          }}
        >
          Copy key
        </button>
        <button className={button} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
export function OrganizationPage() {
  const state = useOrganization();
  if (state.isPending) return <p>Loading organizations…</p>;
  if (state.isError) return <p role="alert">{errorMessage(state.error)}</p>;
  if (!state.organization)
    return <p>No organizations are available to your account.</p>;
  return (
    <OrganizationSettings
      key={state.organization.id}
      organization={state.organization}
      organizations={state.organizations}
      setSite={state.setSite}
    />
  );
}
function OrganizationSettings({
  organization: initial,
  organizations,
  setSite,
}: {
  organization: Organization;
  organizations: Organization[];
  setSite: (id: string) => Promise<void>;
}) {
  const api = getApiClient().orgs,
    qc = useQueryClient(),
    id = initial.id;
  const scope = [getApiBaseUrl(), getSessionGeneration(), id];
  const detail = useQuery({
    queryKey: ['organization', ...scope],
    queryFn: () => api.get(id),
  });
  const org = detail.data ?? initial;
  const [tab, setTab] = useState('general'),
    [secret, setSecret] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    name: string;
    description: string;
    action: () => Promise<unknown>;
  }>();
  const [typed, setTyped] = useState('');
  const mutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      setConfirmation(undefined);
      setTyped('');
      await qc.invalidateQueries({
        predicate: (q) =>
          [
            'organizations',
            'organization',
            'organization-sites',
            'organization-members',
            'organization-keys',
            'organization-approvals',
          ].includes(String(q.queryKey[0])),
      });
    },
  });
  const run = (action: () => Promise<unknown>) => {
    mutation.reset();
    mutation.mutate(action);
  };
  const ask = (
    name: string,
    description: string,
    action: () => Promise<unknown>,
  ) => {
    mutation.reset();
    setTyped('');
    setConfirmation({ name, description, action });
  };
  const sites = useQuery({
    queryKey: ['organization-sites', ...scope],
    queryFn: () => api.sites.list(id),
  });
  const manageMembers = canOrg(org.role, 'org:members:manage'),
    manageKeys = canOrg(org.role, 'org:keys:manage');
  const members = useQuery({
    queryKey: ['organization-members', ...scope],
    queryFn: () => api.members.list(id),
    enabled: manageMembers,
  });
  const keys = useQuery({
    queryKey: ['organization-keys', ...scope],
    queryFn: () => api.keys.list(id),
    enabled: manageKeys,
  });
  const approvals = useQuery({
    queryKey: ['organization-approvals', ...scope],
    queryFn: () => api.approvals.list(id),
    enabled: manageKeys,
  });
  const tabs = [
    'general',
    'sites',
    ...(manageMembers ? ['members'] : []),
    ...(manageKeys ? ['keys', 'approvals'] : []),
  ];
  const activeTab = tabs.includes(tab) ? tab : 'general';
  const busy = mutation.isPending;
  const receive = (result: unknown) => {
    if (
      result &&
      typeof result === 'object' &&
      'token' in result &&
      typeof result.token === 'string'
    )
      setSecret(result.token);
  };
  if (detail.isError) return <p role="alert">{errorMessage(detail.error)}</p>;
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Organization</h1>
        <p className="text-muted-foreground">
          {org.name} · {org.role}
        </p>
      </header>
      <nav
        aria-label="Organization sections"
        className="flex flex-wrap gap-2 border-b pb-3"
      >
        {tabs.map((name) => (
          <button
            key={name}
            className={`${button} capitalize ${activeTab === name ? 'bg-muted font-semibold' : ''}`}
            aria-current={activeTab === name ? 'page' : undefined}
            onClick={() => {
              setTab(name);
              mutation.reset();
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      {secret && (
        <Secret
          key={secret}
          token={secret}
          onDismiss={() => setSecret(undefined)}
        />
      )}
      {mutation.isError && (
        <p role="alert" className="text-destructive">
          {errorMessage(mutation.error)}
        </p>
      )}
      {mutation.isSuccess && (
        <p role="status" className="text-sm text-muted-foreground">
          Saved.
        </p>
      )}
      {confirmation && (
        <section
          role="alertdialog"
          aria-label="Confirm organization action"
          className="space-y-3 rounded-lg border border-destructive p-4"
        >
          <p>{confirmation.description}</p>
          <Field label={`Type ${confirmation.name} to confirm`}>
            <input
              className={input}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <button
              className={button}
              disabled={busy || typed !== confirmation.name}
              onClick={() => run(confirmation.action)}
            >
              Confirm
            </button>
            <button
              className={button}
              disabled={busy}
              onClick={() => setConfirmation(undefined)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}
      {activeTab === 'general' && (
        <General
          key={`${org.updatedAt ?? ''}-${org.name}-${org.slug}`}
          org={org}
          busy={busy}
          save={(body) => run(() => api.update(id, body))}
          remove={() =>
            ask(
              org.slug,
              `Permanently delete ${org.name}? This cannot be undone.`,
              async () => {
                await api.remove(id);
              },
            )
          }
          empty={sites.data?.length === 0}
        />
      )}
      {activeTab === 'sites' && (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Sites</h2>
          {canOrg(org.role, 'org:sites:create') && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                const name = String(data.get('name')).trim(),
                  siteId = String(data.get('id')).trim();
                run(async () => {
                  const created = await api.sites.create(id, {
                    name,
                    ...(siteId ? { id: siteId } : {}),
                  });
                  await setSite(created.id);
                });
              }}
            >
              <Field label="Site name">
                <input name="name" required maxLength={255} className={input} />
              </Field>
              <Field label="Site identifier (optional)">
                <input
                  name="id"
                  pattern="[A-Za-z0-9_-]{1,64}"
                  className={input}
                />
              </Field>
              <button className={button} disabled={busy}>
                Create site
              </button>
            </form>
          )}
          <QueryStatus query={sites} />
          {sites.data?.map((site) => (
            <div
              key={site.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-4"
            >
              <div className="mr-auto">
                <p className="font-medium">{site.name}</p>
                <p className="text-xs text-muted-foreground">
                  {site.id}
                  {getActiveSite() === site.id ? ' · Current site' : ''}
                </p>
              </div>
              {(org.role === 'owner' || org.role === 'admin') && (
                <button
                  className={button}
                  disabled={busy || getActiveSite() === site.id}
                  onClick={() => run(() => setSite(site.id))}
                >
                  Open site
                </button>
              )}
              {canOrg(org.role, 'org:sites:transfer') && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const to = String(
                      new FormData(e.currentTarget).get('destination'),
                    );
                    const destination = organizations.find((o) => o.id === to);
                    if (destination)
                      ask(
                        site.name,
                        `Move ${site.name} to ${destination.name}? Members and keys of the destination organization will gain access.`,
                        () => api.sites.transfer(id, site.id, to),
                      );
                  }}
                >
                  <select
                    name="destination"
                    aria-label={`Destination for ${site.name}`}
                    required
                    className={input}
                  >
                    <option value="">Move to…</option>
                    {organizations
                      .filter((o) => o.id !== id && o.role === 'owner')
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                  <button disabled={busy} className={button}>
                    Transfer
                  </button>
                </form>
              )}
              {canOrg(org.role, 'org:sites:delete') && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    ask(
                      site.name,
                      `Permanently delete ${site.name} and all its content?`,
                      () => api.sites.remove(id, site.id),
                    )
                  }
                >
                  Delete site
                </button>
              )}
            </div>
          ))}
          {sites.data?.length === 0 && (
            <p className="text-muted-foreground">No sites yet.</p>
          )}
        </section>
      )}
      {activeTab === 'members' && (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Members</h2>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              run(() =>
                api.members.invite(
                  id,
                  String(data.get('email')),
                  String(data.get('role')) as OrgRole,
                ),
              );
            }}
          >
            <Field label="Email">
              <input name="email" type="email" required className={input} />
            </Field>
            <RoleSelect owner={org.role === 'owner'} />
            <button disabled={busy} className={button}>
              Add member
            </button>
          </form>
          <QueryStatus query={members} />
          {members.data?.map((member) => (
            <div
              key={member.userId}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <span className="mr-auto">{member.email}</span>
              <label className="sr-only" htmlFor={`role-${member.userId}`}>
                Role for {member.email}
              </label>
              <select
                id={`role-${member.userId}`}
                className={input}
                value={member.role}
                disabled={
                  busy || (member.role === 'owner' && org.role !== 'owner')
                }
                onChange={(e) => {
                  const nextRole = e.target.value as OrgRole;
                  run(() => api.members.update(id, member.userId, nextRole));
                }}
              >
                {(['owner', 'admin', 'billing', 'member'] as const)
                  .filter(
                    (role) =>
                      org.role === 'owner' ||
                      role !== 'owner' ||
                      member.role === 'owner',
                  )
                  .map((role) => (
                    <option key={role}>{role}</option>
                  ))}
              </select>
              <button
                className={button}
                disabled={
                  busy || (member.role === 'owner' && org.role !== 'owner')
                }
                onClick={() =>
                  ask(
                    member.email,
                    `Remove ${member.email} from this organization?`,
                    () => api.members.remove(id, member.userId),
                  )
                }
              >
                Remove member
              </button>
            </div>
          ))}
        </section>
      )}
      {activeTab === 'keys' && (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Organization keys</h2>
          <p className="text-sm text-muted-foreground">
            Organization keys can administer every site in this organization.
            Site keys remain scoped to one site.
          </p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const expiry = String(data.get('expires'));
              run(async () =>
                receive(
                  await api.keys.create(
                    id,
                    String(data.get('name')),
                    expiry ? new Date(expiry).toISOString() : undefined,
                  ),
                ),
              );
            }}
          >
            <Field label="Key name">
              <input name="name" required maxLength={255} className={input} />
            </Field>
            <Field label="Expires (optional)">
              <input name="expires" type="datetime-local" className={input} />
            </Field>
            <button className={button} disabled={busy}>
              Create organization key
            </button>
          </form>
          <QueryStatus query={keys} />
          {keys.data?.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <div className="mr-auto">
                <p>{key.name}</p>
                <p className="text-xs text-muted-foreground">
                  {key.prefix}…{key.revokedAt ? ' · Revoked' : ''}
                  {key.expiresAt
                    ? ` · Expires ${new Date(key.expiresAt).toLocaleString()}`
                    : ''}
                </p>
              </div>
              <button
                className={button}
                disabled={busy || Boolean(key.revokedAt)}
                onClick={() =>
                  ask(
                    key.name,
                    `Rotate ${key.name}? The old key will stop working immediately.`,
                    async () => receive(await api.keys.rotate(id, key.id)),
                  )
                }
              >
                Rotate key
              </button>
              <button
                className={button}
                disabled={busy || Boolean(key.revokedAt)}
                onClick={() =>
                  ask(
                    key.name,
                    `Revoke ${key.name}? It will stop working immediately.`,
                    () => api.keys.revoke(id, key.id),
                  )
                }
              >
                Revoke key
              </button>
            </div>
          ))}
          {keys.data?.length === 0 && <p>No organization keys yet.</p>}
        </section>
      )}
      {activeTab === 'approvals' && (
        <section className="space-y-4">
          <h2 className="text-lg font-medium">MCP approvals</h2>
          <p className="text-sm text-muted-foreground">
            Review the requested action and its parameters before deciding.
            Approval uses your current permissions.
          </p>
          <button className={button} onClick={() => void approvals.refetch()}>
            Refresh requests
          </button>
          <QueryStatus query={approvals} />
          {approvals.data?.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              busy={busy}
              canApprove={
                (org.role === 'owner' &&
                  (approval.skillName !== 'org:transfer_site' ||
                    organizations.some(
                      (o) =>
                        o.id === approval.arguments.toOrganizationId &&
                        o.role === 'owner',
                    ))) ||
                (org.role === 'admin' &&
                  !['org:delete_site', 'org:transfer_site'].includes(
                    approval.skillName,
                  ) &&
                  approval.arguments.role !== 'owner')
              }
              decide={(decision) =>
                ask(
                  decision === 'approved' ? 'APPROVE' : 'REJECT',
                  `${decision === 'approved' ? 'Approve' : 'Reject'} this request? Review the parameters above.`,
                  async () =>
                    receive(
                      (await api.approvals.decide(id, approval.id, decision))
                        .result,
                    ),
                )
              }
              receipt={() =>
                run(async () =>
                  receive((await api.approvals.get(id, approval.id)).result),
                )
              }
            />
          ))}
          {approvals.data?.length === 0 && <p>No requests yet.</p>}
        </section>
      )}
    </div>
  );
}
function QueryStatus({
  query,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown };
}) {
  return query.isPending ? (
    <p>Loading…</p>
  ) : query.isError ? (
    <p role="alert">{errorMessage(query.error)}</p>
  ) : null;
}
function RoleSelect({ owner }: { owner: boolean }) {
  return (
    <Field label="Role">
      <select name="role" defaultValue="member" className={input}>
        {(owner
          ? ['member', 'billing', 'admin', 'owner']
          : ['member', 'billing', 'admin']
        ).map((role) => (
          <option key={role}>{role}</option>
        ))}
      </select>
    </Field>
  );
}
function General({
  org,
  busy,
  save,
  remove,
  empty,
}: {
  org: Organization;
  busy: boolean;
  save: (body: {
    name: string;
    slug?: string;
    settings: Record<string, unknown>;
  }) => void;
  remove: () => void;
  empty: boolean;
}) {
  const contentOs = org.settings?.contentOs as
    | Record<string, unknown>
    | undefined;
  const mcp = contentOs?.mcp as Record<string, unknown> | undefined;
  const [name, setName] = useState(org.name),
    [slug, setSlug] = useState(org.slug),
    [enabled, setEnabled] = useState(mcp?.allowOrganizationTools === true);
  const editable = canOrg(org.role, 'org:settings:write');
  return (
    <section className="space-y-6">
      <form
        className="max-w-xl space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save({
            name,
            ...(org.role === 'owner' ? { slug } : {}),
            settings: {
              ...org.settings,
              contentOs: {
                ...contentOs,
                mcp: { ...mcp, allowOrganizationTools: enabled },
              },
            },
          });
        }}
      >
        <Field label="Organization name">
          <input
            className={input}
            value={name}
            required
            maxLength={255}
            disabled={!editable || busy}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Organization slug">
          <input
            className={input}
            value={slug}
            required
            pattern="[a-z0-9][a-z0-9_-]{0,63}"
            disabled={org.role !== 'owner' || busy}
            onChange={(e) => setSlug(e.target.value)}
          />
        </Field>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!editable || busy}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable organization MCP tools
        </label>
        <p className="text-sm text-muted-foreground">
          Organization changes requested through MCP require human approval. A
          server-wide switch may also disable these tools.
        </p>
        {editable && (
          <button className={button} disabled={busy}>
            Save organization
          </button>
        )}
      </form>
      {canOrg(org.role, 'org:delete') && (
        <section className="space-y-2 border-t pt-4">
          <h2 className="font-medium">Delete organization</h2>
          <p className="text-sm text-muted-foreground">
            An organization must have no sites before it can be deleted.
          </p>
          <button className={button} disabled={busy || !empty} onClick={remove}>
            Delete organization
          </button>
        </section>
      )}
    </section>
  );
}
function ApprovalCard({
  approval,
  busy,
  canApprove,
  decide,
  receipt,
}: {
  approval: OrganizationApproval;
  busy: boolean;
  canApprove: boolean;
  decide: (decision: 'approved' | 'rejected') => void;
  receipt: () => void;
}) {
  return (
    <article className="space-y-3 rounded-lg border p-4">
      <header>
        <h3 className="font-medium capitalize">
          {approval.skillName.replace('org:', '').replaceAll('_', ' ')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {approval.status} · {new Date(approval.createdAt).toLocaleString()}
        </p>
      </header>
      <dl className="grid gap-1 text-sm">
        {Object.entries(approval.arguments).map(([key, value]) => (
          <div key={key} className="flex flex-wrap gap-2">
            <dt className="font-medium">{key.replace(/([A-Z])/g, ' $1')}:</dt>
            <dd className="break-all">
              {typeof value === 'string' ? value : JSON.stringify(value)}
            </dd>
          </div>
        ))}
      </dl>
      {approval.status === 'pending' ? (
        <div className="flex gap-2">
          <button
            className={button}
            disabled={busy || !canApprove}
            onClick={() => decide('approved')}
          >
            Approve request
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => decide('rejected')}
          >
            Reject request
          </button>
        </div>
      ) : approval.status === 'approved' &&
        approval.skillName === 'org:create_org_key' ? (
        // The key was shown once to whoever approved it; the stored receipt
        // keeps no plaintext. A lost key is recovered by rotating it.
        <p className="text-sm text-muted-foreground">
          The key was shown once at approval. Rotate it in Keys if it was not
          saved.
        </p>
      ) : (
        approval.status === 'approved' && (
          <button className={button} disabled={busy} onClick={receipt}>
            View receipt
          </button>
        )
      )}
    </article>
  );
}
