import { useQuery } from '@tanstack/react-query';
import { Check, Crown, Minus, X } from 'lucide-react';
import { useState } from 'react';
import type { CompiledPermission, PermissionAction } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

const ACTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete', 'share'];

/**
 * Permission matrix view. Pulls every collection plus the active principal's
 * compiled bundle (`/permissions/me`) and renders a `collection × action`
 * grid. Clicking a cell shows the row-level rule + field whitelist behind it.
 */
export function PermissionMatrixPage() {
  const client = getApiClient();
  const [active, setActive] = useState<{ collection: string; action: PermissionAction } | null>(
    null,
  );

  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });

  const meQuery = useQuery({
    queryKey: ['permissions-me'],
    queryFn: async () => (await client.permissions.me()).data,
    staleTime: 60_000,
  });

  const isLoading = collectionsQuery.isLoading || meQuery.isLoading;
  const error = collectionsQuery.error || meQuery.error;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading matrix…</p>;
  }
  if (error || !meQuery.data || !collectionsQuery.data) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load permission matrix.
      </div>
    );
  }

  const bundle = meQuery.data;
  const collections = collectionsQuery.data;
  const activePerm = active ? lookup(bundle, active.collection, active.action) : null;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Permission matrix</h2>
          <p className="text-xs text-muted-foreground">
            Compiled bundle for the current principal. Click a cell to inspect.
          </p>
        </div>
        {bundle.admin && (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-700">
            <Crown className="h-3.5 w-3.5" />
            Admin bypass active — every cell allowed
          </span>
        )}
      </header>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Collection</th>
              {ACTIONS.map((a) => (
                <th key={a} className="px-3 py-2 text-center font-medium">
                  {a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {collections.length === 0 && (
              <tr>
                <td colSpan={ACTIONS.length + 1} className="px-4 py-6 text-center text-muted-foreground">
                  No collections yet.
                </td>
              </tr>
            )}
            {collections.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="px-4 py-2 font-medium">{c.name}</td>
                {ACTIONS.map((a) => {
                  const perm = lookup(bundle, c.name, a);
                  const isActive =
                    active?.collection === c.name && active.action === a;
                  return (
                    <td key={a} className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() =>
                          setActive(isActive ? null : { collection: c.name, action: a })
                        }
                        className={cn(
                          'inline-flex h-7 w-full max-w-[6rem] items-center justify-center rounded-md border transition',
                          perm
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                            : 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100',
                          isActive && 'ring-2 ring-primary',
                        )}
                        aria-label={`${a} on ${c.name}: ${perm ? 'allowed' : 'denied'}`}
                      >
                        {bundle.admin ? (
                          <Crown className="h-3.5 w-3.5" />
                        ) : perm ? (
                          <CellSummary perm={perm} />
                        ) : (
                          <X className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {active && (
        <CellInspector
          collection={active.collection}
          action={active.action}
          perm={activePerm}
          adminBypass={bundle.admin}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

function lookup(
  bundle: { admin: boolean; byKey: Record<string, CompiledPermission> },
  collection: string,
  action: PermissionAction,
): CompiledPermission | null {
  if (bundle.admin) {
    return {
      collection,
      action,
      rule: null,
      fields: ['*'],
      presets: {},
      validation: {},
      sources: [{ policyId: 'admin', policyName: 'Admin bypass' }],
    };
  }
  return bundle.byKey[`${collection}::${action}`] ?? null;
}

function CellSummary({ perm }: { perm: CompiledPermission }) {
  const conditional = perm.rule && Object.keys(perm.rule).length > 0;
  if (perm.fields.includes('*') && !conditional) {
    return <Check className="h-3.5 w-3.5" />;
  }
  return (
    <span className="text-[10px] font-medium">
      {conditional ? 'conditional' : <Minus className="h-3.5 w-3.5" />}
    </span>
  );
}

function CellInspector({
  collection,
  action,
  perm,
  adminBypass,
  onClose,
}: {
  collection: string;
  action: PermissionAction;
  perm: CompiledPermission | null;
  adminBypass: boolean;
  onClose: () => void;
}) {
  return (
    <div className="rounded-lg border bg-background p-4 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">
            {action} · <span className="text-muted-foreground">{collection}</span>
          </h3>
          <p className="text-xs text-muted-foreground">
            {adminBypass
              ? 'Admin bypass — all fields, no rule restriction.'
              : perm
                ? 'Compiled from one or more permission rows on attached policies.'
                : 'No matching permission row — denied.'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent"
          aria-label="Close inspector"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {perm && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Block label="Source policies">
            {perm.sources?.length ? (
              <ul className="space-y-1">
                {perm.sources.map((source) => (
                  <li key={source.policyId}>
                    {source.policyId === 'admin' ? (
                      <span>{source.policyName}</span>
                    ) : (
                      <a
                        href={`/access/policies/${source.policyId}`}
                        className="text-primary hover:underline"
                      >
                        {source.policyName}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">unknown</span>
            )}
          </Block>
          <Block label="Fields">
            {perm.fields.length === 0 ? (
              <span className="text-muted-foreground">none</span>
            ) : (
              <ul className="space-y-0.5">
                {perm.fields.map((f) => (
                  <li key={f}>
                    <code className="rounded bg-muted px-1 text-[11px]">{f}</code>
                  </li>
                ))}
              </ul>
            )}
          </Block>
          <Block label="Rule (permissions)">
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[11px] leading-tight">
{JSON.stringify(perm.rule ?? {}, null, 2)}
            </pre>
          </Block>
          <Block label="Presets / validation">
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[11px] leading-tight">
{JSON.stringify({ presets: perm.presets, validation: perm.validation }, null, 2)}
            </pre>
          </Block>
        </div>
      )}
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">{label}</h4>
      <div className="text-xs">{children}</div>
    </div>
  );
}
