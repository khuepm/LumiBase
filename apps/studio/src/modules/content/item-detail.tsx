import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Check, ChevronLeft, Copy, Lock, Save, Share2, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FieldResource, ItemRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions, type PermissionHelpers } from '@/lib/use-permissions';
import { PresenceChip } from '@/components/presence-chip';
import { resolveInterface } from './interfaces/registry';
import { RawToggle } from './interfaces/raw-toggle';
import { RevisionsPanel } from './revisions-panel';
import { RawJsonPanel } from './raw-json-panel';

type Tab = 'fields' | 'revisions' | 'raw';

/**
 * Content module detail editor.
 * Phase B FE slice 2: hosts the side-panel tabs (Fields / Revisions / Raw JSON)
 * around a basic field editor. The full Interface registry lands in slice 3+.
 */
export function ItemDetailPage() {
  const { collection, id } = useParams({ from: '/admin-layout/content/$collection/$id' });
  const client = getApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const perms = usePermissions();

  const [tab, setTab] = useState<Tab>('fields');
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareRoleId, setShareRoleId] = useState('');
  const [sharePassword, setSharePassword] = useState('');
  const [shareValidUntil, setShareValidUntil] = useState('');
  const [shareMaxUses, setShareMaxUses] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [shareCopied, setShareCopied] = useState(false);

  const canRead = perms.can(collection, 'read');
  const canUpdate = perms.can(collection, 'update');
  const canDelete = perms.can(collection, 'delete');
  const canShare = perms.can(collection, 'share');

  const fieldsQuery = useQuery({
    queryKey: ['fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
  });

  const itemQuery = useQuery({
    queryKey: ['item', collection, id],
    queryFn: async () => (await client.items(collection as never).detail(id)).data as ItemRow,
    enabled: !perms.isLoading && canRead,
  });

  const shareRolesQuery = useQuery({
    queryKey: ['share-roles', collection],
    enabled: shareOpen && canShare,
    queryFn: async () => {
      const roles = (await client.roles.list()).data.filter((role) => !role.adminAccess && !role.appAccess);
      const out = [];
      for (const role of roles) {
        const detail = (await client.roles.detail(role.id)).data;
        const policyDetails = await Promise.all(
          detail.policies.map((binding) => client.policies.detail(binding.policyId).then((res) => res.data)),
        );
        const permissions = policyDetails.flatMap((policy) => policy.permissions ?? []);
        const hasRead = permissions.some((perm) => perm.collection === collection && perm.action === 'read');
        const hasNonRead = permissions.some((perm) => perm.action !== 'read');
        if (hasRead && !hasNonRead) out.push(role);
      }
      return out;
    },
  });

  // Hydrate draft from server data once.
  useEffect(() => {
    if (itemQuery.data && draft === null) {
      setDraft({ ...(itemQuery.data.data as Record<string, unknown>) });
    }
  }, [itemQuery.data, draft]);

  const fields = fieldsQuery.data ?? [];
  // Fields the user can read at all — anything else is invisible (server
  // strips it from the payload, but we'd render an empty input otherwise).
  const editable: FieldResource[] = useMemo(
    () =>
      fields
        .filter((f) => !f.hidden)
        .filter((f) => perms.fieldAllowed(collection, 'read', f.name)),
    [fields, perms, collection],
  );

  const isDirty = useMemo(() => {
    if (!itemQuery.data || draft === null) return false;
    return JSON.stringify(draft) !== JSON.stringify(itemQuery.data.data ?? {});
  }, [draft, itemQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) return null;
      const res = await client.items(collection as never).patch(id, { data: draft });
      return res.data as ItemRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', collection, id] });
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
      queryClient.invalidateQueries({ queryKey: ['revisions', collection, id] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await client.items(collection as never).delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
      navigate({ to: '/content/$collection', params: { collection } });
    },
  });

  const createShareMutation = useMutation({
    mutationFn: async () => {
      const res = await client.shares.create({
        collection,
        itemId: id,
        roleId: shareRoleId,
        password: sharePassword.trim() || undefined,
        validUntil: shareValidUntil ? new Date(shareValidUntil).toISOString() : null,
        maxUses: shareMaxUses ? Number(shareMaxUses) : null,
      });
      return res.data;
    },
    onSuccess: (share) => {
      setShareUrl(new URL(share.url, window.location.origin).toString());
      setShareCopied(false);
    },
  });

  if (!perms.isLoading && !canRead) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
        <Lock className="h-4 w-4" />
        You do not have <code className="mx-1 rounded bg-background px-1 text-xs">read</code>
        permission on this collection.
      </div>
    );
  }

  if (itemQuery.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load item.
      </div>
    );
  }

  if (!itemQuery.data || draft === null) {
    return <p className="text-sm text-muted-foreground">Loading item…</p>;
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase text-muted-foreground">
            <Link to="/" className="hover:underline">Content</Link>
            <span className="mx-1">/</span>
            <Link
              to="/content/$collection"
              params={{ collection }}
              className="hover:underline"
            >
              {collection}
            </Link>
            <span className="mx-1">/</span>
            <span className="font-mono">{id.slice(0, 8)}…</span>
          </p>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Link
              to="/content/$collection"
              params={{ collection }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Back to list"
            >
              <ChevronLeft className="h-5 w-5" />
            </Link>
            Edit item
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Presence chip — shows other users currently editing this item */}
          <PresenceChip collection={collection} itemId={id} />
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            disabled={!canShare}
            title={canShare ? undefined : 'You do not have share permission on this collection.'}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50',
              canShare
                ? 'border-border text-foreground hover:bg-muted'
                : 'cursor-not-allowed border-muted-foreground/20 text-muted-foreground',
            )}
          >
            {canShare ? <Share2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            Share
          </button>
          <button
            type="button"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending || !canDelete}
            title={canDelete ? undefined : 'You do not have delete permission on this collection.'}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50',
              canDelete
                ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
                : 'cursor-not-allowed border-muted-foreground/20 text-muted-foreground',
            )}
          >
            {canDelete ? <Trash2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            Delete
          </button>
          <button
            type="button"
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || saveMutation.isPending || !canUpdate}
            title={canUpdate ? undefined : 'You do not have update permission on this collection.'}
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium',
              isDirty && canUpdate
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {canUpdate ? <Save className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {saveMutation.isPending ? 'Saving…' : isDirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </header>

      {saveMutation.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Save failed.
        </div>
      )}

      {shareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-background p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Create share link</h2>
              <button
                type="button"
                onClick={() => setShareOpen(false)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close share dialog"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <label className="block text-xs font-medium text-muted-foreground">
                Share role
                <select
                  value={shareRoleId}
                  onChange={(event) => setShareRoleId(event.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
                >
                  <option value="">Select a read-only role</option>
                  {(shareRolesQuery.data ?? []).map((role) => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-muted-foreground">
                  Password
                  <input
                    type="password"
                    value={sharePassword}
                    onChange={(event) => setSharePassword(event.target.value)}
                    className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs font-medium text-muted-foreground">
                  Max uses
                  <input
                    type="number"
                    min={1}
                    value={shareMaxUses}
                    onChange={(event) => setShareMaxUses(event.target.value)}
                    className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="block text-xs font-medium text-muted-foreground">
                Valid until
                <input
                  type="datetime-local"
                  value={shareValidUntil}
                  onChange={(event) => setShareValidUntil(event.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-2 py-2 text-sm"
                />
              </label>
              {shareRolesQuery.isLoading && <p className="text-xs text-muted-foreground">Loading eligible roles…</p>}
              {shareRolesQuery.data?.length === 0 && (
                <p className="text-xs text-muted-foreground">No read-only share roles are available.</p>
              )}
              {createShareMutation.error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  Failed to create share link.
                </p>
              )}
              {shareUrl && (
                <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2">
                  <input
                    readOnly
                    value={shareUrl}
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(shareUrl);
                      setShareCopied(true);
                    }}
                    className="rounded-md border bg-background p-1.5 hover:bg-muted"
                    aria-label="Copy share link"
                  >
                    {shareCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShareOpen(false)}
                  className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => createShareMutation.mutate()}
                  disabled={!shareRoleId || createShareMutation.isPending}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  <Share2 className="h-3.5 w-3.5" />
                  {createShareMutation.isPending ? 'Creating…' : 'Create link'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_22rem]">
        <section className="rounded-lg border bg-background p-4">
          {tab === 'fields' && (
            <FieldsTab
              fields={editable}
              value={draft}
              onChange={setDraft}
              collection={collection}
              perms={perms}
            />
          )}
          {tab === 'revisions' && (
            <RevisionsPanel
              collection={collection}
              itemId={id}
              onRevert={() => {
                queryClient.invalidateQueries({ queryKey: ['item', collection, id] });
                setDraft(null);
              }}
            />
          )}
          {tab === 'raw' && (
            <RawJsonPanel
              value={draft}
              onChange={setDraft}
            />
          )}
        </section>

        <aside className="rounded-lg border bg-muted/20 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Tabs</h2>
          <ul className="space-y-1 text-sm">
            <TabButton current={tab} value="fields" onClick={setTab}>Fields</TabButton>
            <TabButton current={tab} value="revisions" onClick={setTab}>Revisions</TabButton>
            <TabButton current={tab} value="raw" onClick={setTab}>Raw JSON</TabButton>
          </ul>
          <dl className="mt-4 space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <Meta label="Status" value={itemQuery.data.status} />
            <Meta label="Sort" value={String(itemQuery.data.sort ?? 0)} />
            <Meta label="Updated" value={new Date(itemQuery.data.updatedAt).toLocaleString()} />
            <Meta label="Created" value={new Date(itemQuery.data.createdAt).toLocaleString()} />
          </dl>
        </aside>
      </div>
    </div>
  );
}

function TabButton({
  current,
  value,
  onClick,
  children,
}: {
  current: Tab;
  value: Tab;
  onClick: (tab: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onClick(value)}
        className={cn(
          'w-full rounded-md px-2 py-1 text-left',
          current === value ? 'bg-background font-medium shadow-sm' : 'hover:bg-background/60',
        )}
      >
        {children}
      </button>
    </li>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-foreground/80">{value}</dd>
    </div>
  );
}

/**
 * Renders one editor per field by dispatching to the Interface registry
 * (`resolveInterface`). Each interface owns its own value transform; here we
 * just track the current cell value and patch the parent draft on change.
 *
 * Phase C: fields without `update` permission render disabled (read-only) so
 * the user sees them but cannot mutate them. Fields without `read` are
 * filtered upstream in `editable`, so they never reach here.
 */
function FieldsTab({
  fields,
  value,
  onChange,
  collection,
  perms,
}: {
  fields: FieldResource[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  collection: string;
  perms: PermissionHelpers;
}) {
  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">No editable fields.</p>;
  }
  return (
    <div className="space-y-4">
      {fields.map((f) => {
        const Interface = resolveInterface(f);
        const cellValue = value?.[f.name];
        const writable = perms.fieldAllowed(collection, 'update', f.name);
        const setCell = (next: unknown) => {
          if (!writable) return;
          onChange({ ...value, [f.name]: next });
        };
        return (
          <div key={f.id}>
            <label className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <span>{f.name}</span>
              {f.required && <span className="text-destructive">*</span>}
              <span className="text-[10px] uppercase">{f.interface || f.type}</span>
              {!writable && (
                <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-amber-700">
                  <Lock className="h-3 w-3" /> read-only
                </span>
              )}
            </label>
            <div className={cn(!writable && 'pointer-events-none opacity-70')}>
              <RawToggle value={cellValue} onChange={setCell}>
                <Interface field={f} value={cellValue} onChange={setCell} />
              </RawToggle>
            </div>
          </div>
        );
      })}
    </div>
  );
}
