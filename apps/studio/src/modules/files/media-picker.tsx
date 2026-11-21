/**
 * Media picker (#708) — one picker for every place that chooses assets:
 * built-in `file` / `files` fields, the media library, and UI extensions
 * (through `getStudioHost().openMediaPicker()` from `@lumibase/extension-sdk`).
 *
 * Options: `initiallySelected` (file ids or storage keys), `multiple`,
 * `allowedMimeTypes` (exact or `type/*`), `folder` scope (+ sub-folders),
 * `max`. Filtering is server-side (`GET /files?folder=&mime=&search=`), so
 * large libraries page instead of loading everything.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, File as FileIcon, Folder, Image as ImageIcon, Search, X } from 'lucide-react';
import type { FileResource, FolderTreeNodeResource } from '@lumibase/sdk';
import { registerStudioHost, type MediaKind, type MediaPickerOptions, type PickedAsset } from '@lumibase/extension-sdk';
import { getApiClient } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import { cn } from '@/lib/cn';

export type { MediaKind, MediaPickerOptions, PickedAsset };

const PAGE = 60;

/**
 * Version-pinned delivery URL for embedding a file in content. Immutable for
 * that version, so caches can keep it forever; a replace changes the URL.
 */
export function fileContentUrl(f: Pick<FileResource, 'id' | 'version'>, base: string = getApiBaseUrl()): string {
  const v = f.version ?? 1;
  return `${base.replace(/\/$/, '')}/api/v1/files/${encodeURIComponent(f.id)}/content?v=${v}`;
}

export function toPickedAsset(f: FileResource): PickedAsset {
  const alt = typeof f.metadata?.alt === 'string' && f.metadata.alt.length > 0 ? f.metadata.alt : undefined;
  return {
    id: f.id,
    filenameDisk: f.filenameDisk,
    filenameDownload: f.filenameDownload,
    mime: f.mime,
    filesize: f.filesize,
    width: f.width,
    height: f.height,
    folder: f.folder,
    version: f.version,
    metadata: f.metadata,
    url: fileContentUrl(f),
    ...(alt ? { alt } : {}),
  };
}

/** MIME filters behind each type chip. */
export const KIND_MIMES: Record<MediaKind, readonly string[]> = {
  image: ['image/*'],
  video: ['video/*'],
  audio: ['audio/*'],
  document: [
    'application/pdf',
    'text/*',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/rtf',
    'application/json',
    'text/csv',
  ],
};

function patternsOverlap(a: string, b: string): boolean {
  const prefix = (p: string) => (p.endsWith('/*') ? p.slice(0, -1) : null);
  const pa = prefix(a);
  const pb = prefix(b);
  if (pa && pb) return pa === pb;
  if (pa) return b.startsWith(pa);
  if (pb) return a.startsWith(pb);
  return a === b;
}

/**
 * MIME filter for the list request: the chosen type chip narrowed by the
 * caller's `allowedMimeTypes` (the caller's restriction always wins).
 * `undefined` = no filter; `[]` never happens for a chip that is offered.
 */
export function effectiveMimes(kind: MediaKind | null, allowed: readonly string[] | undefined): string[] | undefined {
  if (!kind) return allowed && allowed.length ? [...allowed] : undefined;
  const kindMimes = KIND_MIMES[kind];
  if (!allowed || allowed.length === 0) return [...kindMimes];
  const out = new Set<string>();
  for (const a of allowed) {
    for (const k of kindMimes) {
      if (!patternsOverlap(a, k)) continue;
      // Keep the narrower of the two patterns.
      out.add(a.endsWith('/*') && !k.endsWith('/*') ? k : a);
    }
  }
  return [...out];
}

/** Chips worth offering: kinds that leave at least one type under `allowed`. */
export function availableKinds(allowed: readonly string[] | undefined): MediaKind[] {
  return (Object.keys(KIND_MIMES) as MediaKind[]).filter((k) => (effectiveMimes(k, allowed) ?? []).length > 0);
}

/** Whether `mime` satisfies an allow-list of exact types / `type/*` prefixes. */
export function mimeAllowed(mime: string, allowed: readonly string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((a) => (a.endsWith('/*') ? mime.startsWith(a.slice(0, -1)) : a === mime));
}

/** MIME entries of an `<input accept>` string (extensions are ignored). */
export function acceptToMimeTypes(accept: string | undefined): string[] | undefined {
  const mimes = (accept ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes('/'));
  return mimes.length > 0 ? mimes : undefined;
}

/** Initial selection may be ids or storage keys; match either. */
export function isInitiallySelected(f: Pick<FileResource, 'id' | 'filenameDisk'>, initial: readonly string[]): boolean {
  return initial.includes(f.id) || initial.includes(f.filenameDisk);
}

interface MediaPickerProps extends MediaPickerOptions {
  open: boolean;
  onCancel: () => void;
  onConfirm: (assets: PickedAsset[]) => void;
}

function flattenTree(nodes: FolderTreeNodeResource[], depth = 0, out: Array<{ node: FolderTreeNodeResource; depth: number }> = []) {
  for (const node of nodes) {
    out.push({ node, depth });
    flattenTree(node.children, depth + 1, out);
  }
  return out;
}

export function MediaPicker({
  open,
  onCancel,
  onConfirm,
  initiallySelected = [],
  multiple = false,
  allowedMimeTypes,
  folder: scopeFolder,
  includeSubfolders = true,
  max,
  title,
  kind: initialKind,
  search: initialSearch,
}: MediaPickerProps) {
  const { t } = useTranslation();
  const client = getApiClient();
  const scoped = scopeFolder !== undefined;
  const [folder, setFolder] = useState<string | null | undefined>(scopeFolder);
  const [search, setSearch] = useState(initialSearch ?? '');
  const [debounced, setDebounced] = useState((initialSearch ?? '').trim());
  const kinds = useMemo(() => availableKinds(allowedMimeTypes), [allowedMimeTypes]);
  const [kind, setKind] = useState<MediaKind | null>(initialKind ?? null);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Map<string, FileResource>>(new Map());
  const seeded = useRef(false);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    if (!open) {
      seeded.current = false;
      setSelected(new Map());
      setSearch(initialSearch ?? '');
      setDebounced((initialSearch ?? '').trim());
      setKind(initialKind ?? null);
      setFolder(scopeFolder);
      setLimit(PAGE);
    }
  }, [open, scopeFolder, initialSearch, initialKind]);

  const treeQuery = useQuery({
    queryKey: ['folders', 'tree'],
    queryFn: async () => (await client.folders.tree()).data,
    enabled: open,
  });

  const mimes = effectiveMimes(kind && kinds.includes(kind) ? kind : null, allowedMimeTypes);
  const mimeKey = (mimes ?? []).join(',');
  const listQuery = useQuery({
    queryKey: ['files', 'picker', folder ?? '__all__', debounced, mimeKey, limit, scoped && includeSubfolders],
    queryFn: async () =>
      client.files.list({
        folder: folder === undefined ? undefined : folder === null ? 'root' : folder,
        subfolders: scoped && includeSubfolders && folder !== undefined,
        search: debounced || undefined,
        mime: mimes,
        limit,
      }),
    enabled: open,
  });

  // Resolve the initial selection once (ids or keys), independent of the
  // current folder/search so pre-selected assets survive filtering.
  const initialKey = initiallySelected.join('|');
  const initialQuery = useQuery({
    queryKey: ['files', 'picker-initial', initialKey],
    queryFn: async () => {
      const byId = (await client.files.list({ ids: initiallySelected, limit: 200 })).data;
      const missing = initiallySelected.filter((v) => !byId.some((f) => f.id === v));
      if (missing.length === 0) return byId;
      // Storage keys: no server filter, so scan the first page of the library.
      const all = (await client.files.list({ limit: 1000 })).data;
      return [...byId, ...all.filter((f) => missing.includes(f.filenameDisk))];
    },
    enabled: open && initiallySelected.length > 0,
  });

  useEffect(() => {
    if (!open || seeded.current || !initialQuery.data) return;
    seeded.current = true;
    setSelected(new Map(initialQuery.data.filter((f) => isInitiallySelected(f, initiallySelected)).map((f) => [f.id, f])));
  }, [open, initialQuery.data, initiallySelected]);

  const files = listQuery.data?.data ?? [];
  const total = Number(listQuery.data?.meta?.total ?? files.length);
  const folders = useMemo(() => flattenTree(treeQuery.data ?? []), [treeQuery.data]);

  const toggle = useCallback(
    (f: FileResource) => {
      setSelected((prev) => {
        const next = new Map(multiple ? prev : []);
        if (prev.has(f.id)) {
          next.delete(f.id);
          return next;
        }
        if (multiple && max !== undefined && prev.size >= max) return prev;
        next.set(f.id, f);
        return next;
      });
    },
    [multiple, max],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title ?? t('files.picker.title', 'Choose media')}>
      <div className="flex h-[80vh] w-full max-w-5xl flex-col rounded-xl border bg-background shadow-lg">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <h2 className="text-lg font-semibold">{title ?? t('files.picker.title', 'Choose media')}</h2>
          <div className="relative ms-auto w-72">
            <Search className="pointer-events-none absolute start-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('files.picker.search', 'Search name, alt, keywords, credit…')}
              className="w-full rounded-md border py-1.5 ps-8 pe-2 text-sm outline-none focus:border-primary"
            />
          </div>
          <button type="button" onClick={onCancel} aria-label={t('common.close', 'Close')} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </header>
        {kinds.length > 1 && (
          <div className="flex flex-wrap items-center gap-1 border-b px-4 py-2 text-xs" role="group" aria-label={t('files.picker.type', 'Type')}>
            {([null, ...kinds] as Array<MediaKind | null>).map((k) => (
              <button
                key={k ?? 'all'}
                type="button"
                aria-pressed={kind === k}
                onClick={() => {
                  setKind(k);
                  setLimit(PAGE);
                }}
                className={cn('rounded-full border px-2.5 py-0.5', kind === k ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
              >
                {k === null
                  ? t('files.picker.kind.all', 'All types')
                  : k === 'image'
                    ? t('files.picker.kind.image', 'Images')
                    : k === 'video'
                      ? t('files.picker.kind.video', 'Video')
                      : k === 'audio'
                        ? t('files.picker.kind.audio', 'Audio')
                        : t('files.picker.kind.document', 'Documents')}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <nav className="w-56 shrink-0 overflow-y-auto border-e p-2 text-sm" aria-label={t('files.folders', 'Folders')}>
            {!scoped && (
              <button type="button" onClick={() => setFolder(undefined)} className={cn('block w-full rounded px-2 py-1 text-start hover:bg-muted', folder === undefined && 'bg-muted font-medium')}>
                {t('files.picker.all', 'All files')}
              </button>
            )}
            <button type="button" onClick={() => setFolder(scoped ? scopeFolder : null)} className={cn('block w-full rounded px-2 py-1 text-start hover:bg-muted', folder === (scoped ? scopeFolder : null) && 'bg-muted font-medium')}>
              {scoped ? t('files.picker.scope', 'This folder') : t('files.root', 'Root')}
            </button>
            {!scoped &&
              folders.map(({ node, depth }) => (
                <button
                  type="button"
                  key={node.id}
                  onClick={() => setFolder(node.id)}
                  style={{ paddingInlineStart: 8 + depth * 12 }}
                  className={cn('flex w-full items-center gap-1 rounded py-1 pe-2 text-start hover:bg-muted', folder === node.id && 'bg-muted font-medium')}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                  <span className="truncate">{node.name}</span>
                </button>
              ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {listQuery.isLoading ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{t('common.loading', 'Loading…')}</p>
            ) : files.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">{t('files.picker.empty', 'No matching files.')}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6" aria-label={t('files.picker.results', 'Files')}>
                {files.map((f) => {
                  const isSel = selected.has(f.id);
                  const allowed = mimeAllowed(f.mime, allowedMimeTypes);
                  return (
                    <li key={f.id}>
                      <button
                        type="button"
                        disabled={!allowed}
                        aria-pressed={isSel}
                        onClick={() => toggle(f)}
                        onDoubleClick={() => !multiple && onConfirm([toPickedAsset(f)])}
                        className={cn(
                          'relative flex w-full flex-col items-center gap-1 rounded-lg border p-3 text-xs hover:bg-muted disabled:opacity-40',
                          isSel && 'border-primary ring-2 ring-primary',
                        )}
                      >
                        {f.mime.startsWith('image/') ? <ImageIcon className="h-8 w-8 text-muted-foreground" /> : <FileIcon className="h-8 w-8 text-muted-foreground" />}
                        <span className="w-full truncate text-center">{f.filenameDownload}</span>
                        {isSel && <Check className="absolute end-1 top-1 h-4 w-4 text-primary" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {files.length < total && (
              <div className="mt-4 text-center">
                <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
                  {t('files.picker.more', 'Load more')} ({files.length}/{total})
                </button>
              </div>
            )}
          </div>
        </div>
        <footer className="flex items-center gap-2 border-t px-4 py-3 text-sm">
          <span className="text-muted-foreground">
            {selected.size} {t('files.picker.selected', 'selected')}
            {multiple && max !== undefined ? ` / ${max}` : ''}
          </span>
          <button type="button" onClick={onCancel} className="ms-auto rounded-md px-4 py-2 font-medium hover:bg-muted">
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => onConfirm([...selected.values()].map(toPickedAsset))}
            className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
          >
            {t('files.picker.confirm', 'Select')}
          </button>
        </footer>
      </div>
    </div>
  );
}

type OpenPicker = (options?: MediaPickerOptions) => Promise<PickedAsset[] | null>;

const MediaPickerContext = createContext<OpenPicker | null>(null);

/**
 * Mount once near the root: renders the picker on demand and installs it as
 * the Studio host service extensions reach through `getStudioHost()`.
 */
export function MediaPickerProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{ options: MediaPickerOptions; resolve: (v: PickedAsset[] | null) => void } | null>(null);

  const open = useCallback<OpenPicker>(
    (options = {}) =>
      new Promise((resolve) => {
        setRequest((prev) => {
          prev?.resolve(null);
          return { options, resolve };
        });
      }),
    [],
  );

  useEffect(() => {
    registerStudioHost({ openMediaPicker: open });
    return () => registerStudioHost(null);
  }, [open]);

  const close = (value: PickedAsset[] | null) => {
    request?.resolve(value);
    setRequest(null);
  };

  return (
    <MediaPickerContext.Provider value={open}>
      {children}
      <MediaPicker open={request !== null} {...(request?.options ?? {})} onCancel={() => close(null)} onConfirm={(assets) => close(assets)} />
    </MediaPickerContext.Provider>
  );
}

/** `open(options)` → chosen assets or null. Null outside a provider (e.g. isolated tests). */
export function useMediaPicker(): OpenPicker | null {
  return useContext(MediaPickerContext);
}
