import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getApiClient } from '@/lib/api';
import { lastListSearch } from './list-url-state';

/**
 * Breadcrumb trail for the item editor and the create form (#694):
 * Content › {collection label} › {item title}. The collection link returns to
 * the list view the user left (page, sort, filters). A singleton has no list
 * worth returning to, so its trail skips that link.
 */

/** A readable title for an item: a common title-like field, else a short id. */
export function itemTitle(id: string, data: Record<string, unknown> | null | undefined): string {
  for (const key of ['title', 'name', 'label', 'heading', 'slug']) {
    const v = data?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // Translatable text: first non-empty locale.
      const first = Object.values(v as Record<string, unknown>).find((x) => typeof x === 'string' && x.trim());
      if (typeof first === 'string') return first.trim().slice(0, 80);
    }
  }
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function useCollectionMeta(collection: string) {
  const client = getApiClient();
  return useQuery({
    queryKey: ['collection', collection],
    queryFn: async () => (await client.schema.getCollection(collection)).data,
  });
}

export function ItemBreadcrumbs({ collection, current }: { collection: string; current: string }) {
  const meta = useCollectionMeta(collection);
  const label = (meta.data as { label?: string | null } | undefined)?.label || collection;
  const singleton = (meta.data as { singleton?: boolean } | undefined)?.singleton === true;
  return (
    <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          <Link to="/" className="hover:underline">
            Content
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight className="h-3 w-3 rtl:rotate-180" />
        </li>
        <li>
          {singleton ? (
            <span>{label}</span>
          ) : (
            <Link
              to="/content/$collection"
              params={{ collection }}
              search={lastListSearch(collection) as never}
              className="hover:underline"
            >
              {label}
            </Link>
          )}
        </li>
        <li aria-hidden="true">
          <ChevronRight className="h-3 w-3 rtl:rotate-180" />
        </li>
        <li aria-current="page" className="max-w-[24rem] truncate text-foreground/80">
          {current}
        </li>
      </ol>
    </nav>
  );
}

/** The back arrow beside the heading: to the list view the user left. */
export function BackToList({ collection }: { collection: string }) {
  const meta = useCollectionMeta(collection);
  const singleton = (meta.data as { singleton?: boolean } | undefined)?.singleton === true;
  return (
    <Link
      to={singleton ? '/' : '/content/$collection'}
      params={singleton ? undefined : { collection }}
      search={singleton ? undefined : (lastListSearch(collection) as never)}
      className="text-muted-foreground hover:text-foreground"
      aria-label={singleton ? 'Back to content' : 'Back to list'}
    >
      <ChevronLeft className="h-5 w-5 rtl:rotate-180" />
    </Link>
  );
}
