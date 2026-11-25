import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PREVIEW_URL_PLACEHOLDERS, validatePreviewUrlTemplate } from '@lumibase/contracts';
import { useEffect, useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * Collection `meta.previewUrl` (epic #667, V02 #680): the frontend URL the
 * item editor's live preview pane opens, with `{token}`, `{id}`, `{slug}` …
 * placeholders. Validated here and again by the CMS (http(s) only).
 */
export function PreviewUrlSection({ collectionName }: { collectionName: string }) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const collectionQuery = useQuery({
    queryKey: ['collection', collectionName],
    queryFn: async () => (await client.schema.getCollection(collectionName)).data,
  });
  const saved = typeof collectionQuery.data?.meta?.previewUrl === 'string' ? collectionQuery.data.meta.previewUrl : '';
  const [value, setValue] = useState('');
  useEffect(() => setValue(saved), [saved]);

  const issue = value.trim() ? validatePreviewUrlTemplate(value.trim()) : null;
  const save = useMutation({
    mutationFn: async () =>
      client.schema.updateCollection(collectionName, {
        meta: { ...(collectionQuery.data?.meta ?? {}), previewUrl: value.trim() || null },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['collection', collectionName] }),
  });
  const dirty = value.trim() !== saved;

  return (
    <section>
      <header className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Preview URL</h3>
          <p className="text-xs text-muted-foreground">
            Enables the live preview pane in the item editor. Placeholders:{' '}
            {PREVIEW_URL_PLACEHOLDERS.map((p) => (
              <code key={p} className="me-1 font-mono">{`{${p}}`}</code>
            ))}
          </p>
        </div>
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!dirty || Boolean(issue) || save.isPending}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
      </header>
      <label className="sr-only" htmlFor="collection-preview-url">
        Preview URL
      </label>
      <input
        id="collection-preview-url"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="http://localhost:3000/api/preview?token={token}&id={id}"
        aria-invalid={issue ? true : undefined}
        className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
      />
      {issue && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {issue.message}
        </p>
      )}
      {save.error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Saving the preview URL failed.
        </p>
      )}
    </section>
  );
}

/**
 * Collection `meta.pageBlock` (V06 #684): offer this collection as a block in
 * the page composer. Its fields become the block's fields.
 */
export function PageBlockToggle({ collectionName }: { collectionName: string }) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const collectionQuery = useQuery({
    queryKey: ['collection', collectionName],
    queryFn: async () => (await client.schema.getCollection(collectionName)).data,
  });
  const enabled = collectionQuery.data?.meta?.pageBlock === true;
  const save = useMutation({
    mutationFn: async (next: boolean) =>
      client.schema.updateCollection(collectionName, {
        meta: { ...(collectionQuery.data?.meta ?? {}), pageBlock: next },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection', collectionName] });
      queryClient.invalidateQueries({ queryKey: ['page-blocks'] });
    },
  });
  return (
    <section>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!collectionQuery.data || save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
        />
        Use as a page block
      </label>
      <p className="ms-6 text-xs text-muted-foreground">
        Offers this collection in the page composer. Its fields are the block&apos;s fields; encrypted and pii/phi fields are not
        available in blocks.
      </p>
      {save.error && (
        <p role="alert" className="ms-6 mt-1 text-xs text-destructive">
          Saving failed.
        </p>
      )}
    </section>
  );
}
