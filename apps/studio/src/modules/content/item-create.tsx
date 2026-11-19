import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { BackToList, ItemBreadcrumbs } from './item-breadcrumbs';
import { Lock, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { FieldResource, ItemRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { FieldsTab, requiredError } from './item-detail';
import { checkRequired, useFormLayout, validationErrorsFrom } from './form-layout-state';
import { DraftReviewPanel } from './draft-review-panel';
import { useReviewRollout, useReviewSession } from './use-review-pilot';
import { useSiteLocales } from './use-site-locales';
import { FieldRevealContext, useIntentFieldFocus } from './field-focus';

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Create failed.';
}

/** New-item form: creates a draft, then hands off to the regular editor. */
export function ItemCreate({ collection, intentField }: { collection: string; intentField?: string }) {
  const client = getApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const perms = usePermissions();
  const canCreate = perms.can(collection, 'create');
  // Tree collections (#749): "Add child" links here with `?parent=<id>`.
  const search = useSearch({ strict: false }) as { parent?: unknown };
  const parentId = typeof search.parent === 'string' && search.parent ? search.parent : undefined;
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  // Draft-review pilot (Jev J09): panel only in assisted mode; the session
  // from opening the form to the created draft is timed in both modes.
  const locales = useSiteLocales();
  const reviewMode = useReviewRollout(collection);
  const reviewSession = useReviewSession({ collection, mode: reviewMode, locale: locales[0] });

  const fieldsQuery = useQuery({
    queryKey: ['fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
  });

  const fields: FieldResource[] = useMemo(
    () =>
      (fieldsQuery.data ?? [])
        .filter((f) => !f.hidden)
        .filter((f) => perms.fieldAllowed(collection, 'create', f.name)),
    [fieldsQuery.data, perms, collection],
  );

  // `create` intent links may name a field to focus on the empty form (#759).
  const fieldFocus = useIntentFieldFocus({
    field: intentField,
    fields,
    ready: fieldsQuery.isSuccess && !perms.isLoading && canCreate,
  });
  const layout = useFormLayout(collection);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const createMutation = useMutation({
    mutationFn: async () => {
      // Same required rule as the server's create validation (#750).
      const missing = checkRequired(fieldsQuery.data ?? [], draft, layout);
      if (Object.keys(missing).length > 0) throw requiredError(missing);
      // `?parent=` from the tree view's "Add child" (#749).
      return (await client.items(collection as never).create({ data: draft, status: 'draft', ...(parentId ? { parentId } : {}) })).data as ItemRow;
    },
    onError: (err: Error) => {
      setFieldErrors(validationErrorsFrom(err, (fieldsQuery.data ?? []).map((f) => f.name)));
    },
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
      reviewSession.finish(item.id);
      navigate({ to: '/content/$collection/$id', params: { collection, id: item.id }, replace: true });
    },
  });

  if (!canCreate) {
    return (
      <p className="text-sm text-muted-foreground">You do not have create permission on this collection.</p>
    );
  }
  if (fieldsQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading fields…</p>;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <ItemBreadcrumbs collection={collection} current="New item" />
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <BackToList collection={collection} />
            New item
          </h1>
        </div>
        <button
          type="button"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className={cn(
            'inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50',
          )}
        >
          {createMutation.isPending ? <Lock className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {createMutation.isPending ? 'Creating…' : 'Create draft'}
        </button>
      </header>

      {createMutation.error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {errorMessage(createMutation.error)}
        </div>
      )}

      <div className={cn('grid grid-cols-1 gap-4', reviewMode === 'assisted' && 'lg:grid-cols-[1fr_22rem]')}>
        <section className="rounded-lg border bg-background p-4">
          {fieldFocus.status === 'missing' && intentField && (
            <p role="status" className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
              The linked field “{intentField}” is not available on this form.
            </p>
          )}
          <FieldRevealContext.Provider value={fieldFocus.reveal}>
            <FieldsTab
              fields={fields}
              value={draft}
              onChange={setDraft}
              collection={collection}
              perms={perms}
              pinnedFields={[]}
              writeAction="create"
              layout={layout}
              errors={fieldErrors}
            />
          </FieldRevealContext.Provider>
        </section>
        {/* Draft review of the unsaved form (Jev J08): only profile fields the
            user may create are sent. Apply edits the form; nothing is saved.
            Shown only while this collection is in the assisted pilot (J09). */}
        {reviewMode === 'assisted' && (
          <aside className="rounded-lg border bg-muted/20 p-3">
            <DraftReviewPanel
              collection={collection}
              values={draft}
              fields={fields}
              writeAction="create"
              perms={perms}
              pinnedFields={[]}
              onApply={(field, value) => setDraft((prev) => ({ ...prev, [field]: value }))}
              onViewed={reviewSession.markViewed}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
