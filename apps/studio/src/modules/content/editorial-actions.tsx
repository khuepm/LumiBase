import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, EyeOff, Globe, Send, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ItemRow } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

export type EditorialAction = 'submit_review' | 'approve' | 'reject' | 'publish' | 'unpublish';

/**
 * Display state of an item. A PATCH to `published` leaves `editorialState` at
 * `approved`, so `status` wins whenever the item is live.
 */
export function editorialStateOf(item: Pick<ItemRow, 'status' | 'editorialState'>): string {
  if (item.status === 'published') return 'published';
  const state = item.editorialState ?? 'draft';
  return state === 'published' ? 'draft' : state;
}

/** Transitions offered from `state`; mirrors TRANSITIONS in the CMS editorial service. */
export function availableEditorialActions(state: string, workflowEnabled: boolean): EditorialAction[] {
  switch (state) {
    case 'draft':
    case 'rejected':
      return workflowEnabled ? ['submit_review'] : ['submit_review', 'publish'];
    case 'in_review':
      return ['approve', 'reject'];
    case 'approved':
    case 'scheduled':
      return ['publish'];
    case 'published':
      return ['unpublish'];
    default:
      return [];
  }
}

const ACTIONS: Record<EditorialAction, { label: string; icon: LucideIcon; tone: 'primary' | 'neutral' | 'danger' }> = {
  submit_review: { label: 'Submit for review', icon: Send, tone: 'neutral' },
  approve: { label: 'Approve', icon: CheckCircle2, tone: 'primary' },
  reject: { label: 'Reject', icon: XCircle, tone: 'danger' },
  publish: { label: 'Publish', icon: Globe, tone: 'primary' },
  unpublish: { label: 'Unpublish', icon: EyeOff, tone: 'neutral' },
};

const EDITORIAL_PATH: Partial<Record<EditorialAction, string>> = {
  submit_review: 'submit-review',
  approve: 'approve',
  reject: 'reject',
};

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Action failed.';
}

export function EditorialActions({
  collection,
  item,
  canUpdate,
  isDirty,
}: {
  collection: string;
  item: ItemRow;
  canUpdate: boolean;
  isDirty: boolean;
}) {
  const client = getApiClient();
  const queryClient = useQueryClient();

  const collectionQuery = useQuery({
    queryKey: ['collection', collection],
    queryFn: async () => (await client.schema.getCollection(collection)).data,
  });
  const workflowEnabled = collectionQuery.data?.meta?.editorialWorkflow === true;

  const mutation = useMutation({
    mutationFn: async (action: EditorialAction) => {
      const path = EDITORIAL_PATH[action];
      if (path) {
        await client.rawRequest(`/api/v1/editorial/${collection}/${item.id}/${path}`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        return;
      }
      await client.items(collection as never).patch(item.id, {
        status: action === 'publish' ? 'published' : 'draft',
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['item', collection, item.id] });
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
      void queryClient.invalidateQueries({ queryKey: ['editorial-reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['revisions', collection, item.id] });
    },
  });

  const state = editorialStateOf(item);
  const actions = collectionQuery.isLoading ? [] : availableEditorialActions(state, workflowEnabled);
  const blockedReason = !canUpdate
    ? 'You do not have update permission on this collection.'
    : isDirty
      ? 'Save your changes first.'
      : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="editorial-actions">
      <span
        className="rounded-full border px-2 py-0.5 font-mono text-[11px] uppercase text-muted-foreground"
        title="Editorial state"
      >
        {state.replace('_', ' ')}
      </span>
      {actions.map((action) => {
        const { label, icon: Icon, tone } = ACTIONS[action];
        return (
          <button
            key={action}
            type="button"
            onClick={() => mutation.mutate(action)}
            disabled={mutation.isPending || blockedReason !== undefined}
            title={blockedReason}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50',
              tone === 'primary' && 'border-primary/50 text-primary hover:bg-primary/10',
              tone === 'danger' && 'border-destructive/40 text-destructive hover:bg-destructive/10',
              tone === 'neutral' && 'border-border text-foreground hover:bg-muted',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
      {mutation.error && (
        <span role="alert" className="text-xs text-destructive">
          {errorMessage(mutation.error)}
        </span>
      )}
    </div>
  );
}
