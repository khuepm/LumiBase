import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Check, ChevronDown, ChevronLeft, Copy, Lock, Pin, Save, Share2, Star, Trash2, X } from 'lucide-react';
import type { SaveAction } from '@lumibase/shared/schemas';
import { useSaveAction, saveActionLabel } from './use-save-action';
import { useEffect, useMemo, useState } from 'react';
import type { FieldResource, ItemRow, RevisionRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions, type PermissionHelpers } from '@/lib/use-permissions';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';
import { PresenceChip } from '@/components/presence-chip';
import { useRealtimeItem } from '@/hooks/use-realtime';
import { resolveInterface } from './interfaces/registry';
import { GroupContainer, type GroupVariant } from './interfaces/group';
import { RawToggle } from './interfaces/raw-toggle';
import { ProvenanceBadge } from './provenance-badge';
import { RevisionsPanel } from './revisions-panel';
import { RawJsonPanel } from './raw-json-panel';
import { VersionPanel } from './version-panel';
import { DependentRecordsDialog, type DependentGroup } from './dependent-records-dialog';

type Tab = 'fields' | 'revisions' | 'versions' | 'raw';

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
  const saveAction = useSaveAction();
  // The action a one-off save click requested; null → use the effective default.
  const [pendingAction, setPendingAction] = useState<SaveAction | null>(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);

  const [tab, setTab] = useState<Tab>('fields');
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  // Content scheduling (Publish_Window) — datetime-local strings, '' = unset.
  const [publishAt, setPublishAt] = useState<string | null>(null);
  const [unpublishAt, setUnpublishAt] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [dependentGroups, setDependentGroups] = useState<DependentGroup[] | null>(null);
  const [shareRoleId, setShareRoleId] = useState('');
  const [sharePassword, setSharePassword] = useState('');
  const [shareValidUntil, setShareValidUntil] = useState('');
  const [shareMaxUses, setShareMaxUses] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [shareCopied, setShareCopied] = useState(false);
  // Realtime: flag when this open item is changed elsewhere (Req 5.2).
  const [remotelyUpdated, setRemotelyUpdated] = useState(false);
  useRealtimeItem(collection, id, () => setRemotelyUpdated(true));

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

  // Law Zero pins (content-os Req 8.5): fields a human edit locked against
  // agent writes. Shown as a badge per field; release hands the field back.
  const pinsQuery = useQuery({
    queryKey: ['pins', collection, id],
    queryFn: async () => (await client.items(collection as never).listPins(id)).data.pinnedFields,
    enabled: !perms.isLoading && canRead,
  });

  // Provenance of the latest revision (content-os-ui Req 4.4): who — human
  // or agent — last shaped this item. Shares the revisions query cache.
  const revisionsQuery = useQuery({
    queryKey: ['revisions', collection, id],
    queryFn: async () =>
      (await client.items(collection as never).listRevisions(id)).data as RevisionRow[],
    enabled: !perms.isLoading && canRead,
  });
  const latestRevision = revisionsQuery.data?.[0];

  const releasePinMutation = useMutation({
    mutationFn: async (field: string) => {
      const res = await client.items(collection as never).releasePin(id, field);
      return res.data.pinnedFields;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pins', collection, id] });
    },
  });

  const shareRolesQuery = useQuery({
    queryKey: ['share-roles', collection],
    enabled: shareOpen && canShare,
    queryFn: async () => {
      const roles = (await client.roles.list()).data.filter((role) => !role.adminAccess && !role.appAccess);
      const out = await Promise.all(
        roles.map(async (role) => {
          const detail = (await client.roles.detail(role.id)).data;
          const policyDetails = await Promise.all(
            detail.policies.map((binding) => client.policies.detail(binding.policyId).then((res) => res.data)),
          );
          const permissions = policyDetails.flatMap((policy) => policy.permissions ?? []);
          const hasRead = permissions.some((perm) => perm.collection === collection && perm.action === 'read');
          const hasNonRead = permissions.some((perm) => perm.action !== 'read');
          if (hasRead && !hasNonRead) return role;
          return null;
        })
      );
      return out.filter((role): role is NonNullable<typeof role> => role !== null);
    },
  });

  // Hydrate draft from server data once.
  useEffect(() => {
    if (itemQuery.data && draft === null) {
      setDraft({ ...(itemQuery.data.data as Record<string, unknown>) });
      setPublishAt(isoToLocalInput(itemQuery.data.publishAt));
      setUnpublishAt(isoToLocalInput(itemQuery.data.unpublishAt));
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
    if (JSON.stringify(draft) !== JSON.stringify(itemQuery.data.data ?? {})) return true;
    return (
      publishAt !== isoToLocalInput(itemQuery.data.publishAt) ||
      unpublishAt !== isoToLocalInput(itemQuery.data.unpublishAt)
    );
  }, [draft, itemQuery.data, publishAt, unpublishAt]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) return null;
      const res = await client.items(collection as never).patch(id, {
        data: draft,
        publishAt: localInputToIso(publishAt),
        unpublishAt: localInputToIso(unpublishAt),
      });
      return res.data as ItemRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['item', collection, id] });
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
      queryClient.invalidateQueries({ queryKey: ['revisions', collection, id] });
      // Navigate per the save action (one-off override, else effective default).
      const action = pendingAction ?? saveAction.effective;
      setPendingAction(null);
      if (action === 'return') {
        navigate({ to: '/content/$collection', params: { collection } });
      } else if (action === 'create_new') {
        navigate({ to: '/content/$collection/$id', params: { collection, id: 'new' } });
      }
      // 'stay' → remain on the form (current behavior).
    },
  });

  // Cmd/Ctrl+S → save and stay. Mirrors the Save button's gating exactly.
  useSaveHandler(
    () => saveMutation.mutate(),
    isDirty && canUpdate && !saveMutation.isPending,
  );

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await client.items(collection as never).delete(id);
    },
    onSuccess: () => {
      setDependentGroups(null);
      queryClient.invalidateQueries({ queryKey: ['items', collection] });
      navigate({ to: '/content/$collection', params: { collection } });
    },
    onError: (err: unknown) => {
      // 409 DEPENDENT_RECORDS_EXIST → open the resolution dialog with the groups.
      const e = err as { status?: number; body?: { errors?: Array<{ code?: string; dependents?: DependentGroup[] }> } };
      if (e?.status === 409 && e.body?.errors?.[0]?.code === 'DEPENDENT_RECORDS_EXIST') {
        setDependentGroups(e.body.errors[0].dependents ?? []);
      }
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
            {latestRevision && <ProvenanceBadge revision={latestRevision} />}
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
          <div className="relative inline-flex">
            <button
              type="button"
              onClick={() => {
                setPendingAction(null); // use effective default
                saveMutation.mutate();
              }}
              disabled={!isDirty || saveMutation.isPending || !canUpdate}
              title={canUpdate ? saveActionLabel(saveAction.effective) : 'You do not have update permission on this collection.'}
              className={cn(
                'inline-flex items-center gap-1 rounded-l-md px-3 py-1 text-xs font-medium',
                isDirty && canUpdate
                  ? 'bg-primary text-primary-foreground hover:opacity-90'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {canUpdate ? <Save className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              {saveMutation.isPending
                ? 'Saving…'
                : isDirty
                  ? saveActionLabel(saveAction.effective)
                  : 'Saved'}
            </button>
            <button
              type="button"
              aria-label="Save options"
              onClick={() => setSaveMenuOpen((v) => !v)}
              disabled={saveMutation.isPending || !canUpdate}
              className={cn(
                'inline-flex items-center rounded-r-md border-l border-primary-foreground/20 px-1.5 py-1',
                canUpdate ? 'bg-primary text-primary-foreground hover:opacity-90' : 'bg-muted text-muted-foreground',
              )}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {saveMenuOpen && (
              <div
                className="absolute right-0 top-full z-20 mt-1 w-52 rounded-md border border-border bg-background py-1 text-xs shadow-md"
                onMouseLeave={() => setSaveMenuOpen(false)}
              >
                {(['stay', 'return', 'create_new'] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    disabled={!isDirty || !canUpdate}
                    onClick={() => {
                      setSaveMenuOpen(false);
                      setPendingAction(a);
                      saveMutation.mutate();
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                  >
                    {saveActionLabel(a)}
                    {saveAction.effective === a && <Check className="h-3 w-3" />}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  disabled={saveAction.isSettingDefault}
                  onClick={() => {
                    setSaveMenuOpen(false);
                    saveAction.setDefault(saveAction.effective);
                  }}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-muted-foreground hover:bg-muted"
                >
                  <Star className="h-3 w-3" />
                  Set “{saveActionLabel(saveAction.effective)}” as default
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {remotelyUpdated && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"
        >
          <span>This item was updated elsewhere. Reload to see the latest changes.</span>
          <button
            type="button"
            className="rounded-md border border-amber-400 px-2 py-1 text-xs font-medium hover:bg-amber-100"
            onClick={() => {
              setRemotelyUpdated(false);
              void queryClient.invalidateQueries({ queryKey: ['item', collection, id] });
            }}
          >
            Reload
          </button>
        </div>
      )}

      {saveMutation.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Save failed.
        </div>
      )}

      {dependentGroups && (
        <DependentRecordsDialog
          collection={collection}
          itemId={id}
          groups={dependentGroups}
          onClose={() => setDependentGroups(null)}
          onAllResolved={() => deleteMutation.mutate()}
        />
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
              pinnedFields={pinsQuery.data ?? []}
              onReleasePin={canUpdate ? (field) => releasePinMutation.mutate(field) : undefined}
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
          {tab === 'versions' && <VersionPanel collection={collection} itemId={id} />}
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
            <TabButton current={tab} value="versions" onClick={setTab}>Versions</TabButton>
            <TabButton current={tab} value="raw" onClick={setTab}>Raw JSON</TabButton>
          </ul>
          <dl className="mt-4 space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <Meta label="Status" value={itemQuery.data.status} />
            <Meta label="Sort" value={String(itemQuery.data.sort ?? 0)} />
            {itemQuery.data.editorialState ? (
              <Meta label="Editorial" value={itemQuery.data.editorialState} />
            ) : null}
            <Meta label="Updated" value={new Date(itemQuery.data.updatedAt).toLocaleString()} />
            <Meta label="Created" value={new Date(itemQuery.data.createdAt).toLocaleString()} />
          </dl>
          {/* Content scheduling (Req 10.1). Empty = unset; the Delivery API
              only serves items inside the current Publish_Window. */}
          <div className="mt-4 space-y-2 border-t pt-3">
            <h2 className="text-xs font-semibold uppercase text-muted-foreground">Scheduling</h2>
            <label className="block text-xs text-muted-foreground">
              Publish at
              <input
                type="datetime-local"
                className="mt-1 w-full rounded border px-2 py-1 text-sm"
                value={publishAt ?? ''}
                disabled={!canUpdate}
                onChange={(e) => setPublishAt(e.target.value || null)}
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              Unpublish at
              <input
                type="datetime-local"
                className="mt-1 w-full rounded border px-2 py-1 text-sm"
                value={unpublishAt ?? ''}
                disabled={!canUpdate}
                onChange={(e) => setUnpublishAt(e.target.value || null)}
              />
            </label>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** ISO timestamp → `datetime-local` input value (local time), or '' when unset. */
function isoToLocalInput(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value → ISO string, or null when empty. */
function localInputToIso(local: string | null): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
  pinnedFields,
  onReleasePin,
}: {
  fields: FieldResource[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  collection: string;
  perms: PermissionHelpers;
  /** Law Zero: fields locked against agent writes by a human edit. */
  pinnedFields: string[];
  /** Present when the user may release pins; absent renders the badge only. */
  onReleasePin?: (field: string) => void;
}) {
  if (fields.length === 0) {
    return <p className="text-sm text-muted-foreground">No editable fields.</p>;
  }

  // Group fields (interface `group-*`) act as containers; their `name` is the
  // key that child fields reference via `field.group`.
  const groupFieldNames = new Set(
    fields.filter((f) => f.interface?.startsWith('group-')).map((f) => f.name),
  );
  const bySort = (a: FieldResource, b: FieldResource) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  const widthClass = (w?: FieldResource['width']) =>
    w === 'half' ? 'sm:col-span-1' : 'col-span-1 sm:col-span-2';

  const renderField = (f: FieldResource): React.ReactNode => {
    // Group container — render its children in a nested grid.
    if (f.interface?.startsWith('group-')) {
      const variant = f.interface.replace('group-', '') as GroupVariant;
      const children = fields.filter((c) => c.group === f.name).sort(bySort);
      return (
        <div key={f.id} className="col-span-1 sm:col-span-2">
          <GroupContainer variant={variant} field={f}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children.map(renderField)}</div>
          </GroupContainer>
        </div>
      );
    }

    const Interface = resolveInterface(f);
    const cellValue = value?.[f.name];
    const writable = perms.fieldAllowed(collection, 'update', f.name);
    const pinned = pinnedFields.includes(f.name);
    const setCell = (next: unknown) => {
      if (!writable) return;
      onChange({ ...value, [f.name]: next });
    };
    return (
      <div key={f.id} className={widthClass(f.width)}>
        <label className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <span>{f.name}</span>
          {f.required && <span className="text-destructive">*</span>}
          <span className="text-[10px] uppercase">{f.interface || f.type}</span>
          {pinned && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700"
              title="Pinned by a human edit — agents cannot overwrite this field."
            >
              <Pin className="h-3 w-3" /> Pinned
              {onReleasePin && (
                <button
                  type="button"
                  onClick={() => onReleasePin(f.name)}
                  className="ml-0.5 rounded-full px-1 hover:bg-sky-100"
                  aria-label={`Release pin on ${f.name}`}
                  title="Release pin — allow agents to write this field again."
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </span>
          )}
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
  };

  // Top-level fields = everything not nested inside a group container.
  const topLevel = fields
    .filter((f) => !f.group || !groupFieldNames.has(f.group))
    .sort(bySort);

  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{topLevel.map(renderField)}</div>;
}
