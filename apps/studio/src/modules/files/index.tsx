import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  CheckSquare,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderInput,
  HardDrive,
  Pencil,
  Plus,
  Search,
  Square,
  Tags,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { FileResource, FolderTreeNodeResource, UploadConfigResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PermanentUploadError, UploadQueue, sha256OfFile, type DuplicateHit, type UploadTask } from './upload-queue';
import { UploadQueuePanel } from './upload-queue-panel';
import { FileDetailsDrawer } from './file-details';

/**
 * Client-side pre-check mirroring the server upload guard so the user gets an
 * immediate, friendly reason instead of a failed request. The server remains
 * the source of truth — this only avoids obviously-doomed uploads.
 */
export function rejectFile(file: File, cfg: UploadConfigResource | undefined): string | null {
  if (!cfg) return null;
  if (file.size > cfg.maxBytes) {
    const mb = (cfg.maxBytes / (1024 * 1024)).toFixed(cfg.maxBytes % (1024 * 1024) === 0 ? 0 : 1);
    return `"${file.name}" exceeds the ${mb} MB upload limit.`;
  }
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  const extOk = ext !== '' && cfg.allowedExtensions.includes(ext);
  const mimeOk = file.type !== '' && cfg.allowedMimeTypes.includes(file.type);
  if (!extOk && !mimeOk) {
    return `"${file.name}" is not an allowed file type. Allowed: ${cfg.allowedExtensions.join(', ')}.`;
  }
  return null;
}

/** PUT bytes to the signed URL with upload progress (fetch has none). */
function putWithProgress(url: string, file: File, onProgress: (p: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status})`;
      try {
        message = (JSON.parse(xhr.responseText) as { errors?: Array<{ message?: string }> }).errors?.[0]?.message ?? message;
      } catch {
        /* keep default */
      }
      // 4xx = the guard refused this file; retrying will not help.
      reject(xhr.status >= 400 && xhr.status < 500 ? new PermanentUploadError(message) : new Error(message));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Cancelled'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

const DRAG_MIME = 'application/x-lumibase-files';

export function FilesPage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [tasks, setTasks] = useState<ReadonlyArray<UploadTask<FileResource>>>([]);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const treeQuery = useQuery({ queryKey: ['folders', 'tree'], queryFn: async () => (await client.folders.tree()).data });
  const filesQuery = useQuery({
    queryKey: ['files', 'library', currentFolder, debounced],
    queryFn: async () =>
      (await client.files.list({ folder: debounced ? undefined : currentFolder === null ? 'root' : currentFolder, search: debounced || undefined }))
        .data,
  });
  const uploadConfigQuery = useQuery({ queryKey: ['upload-config'], queryFn: async () => (await client.uploads.getConfig()).data });
  const uploadConfig = uploadConfigQuery.data;
  const acceptAttr = uploadConfig ? [...uploadConfig.allowedMimeTypes, ...uploadConfig.allowedExtensions].join(',') : undefined;

  const tree = treeQuery.data ?? [];
  const files = filesQuery.data ?? [];
  const byId = useMemo(() => {
    const map = new Map<string, FolderTreeNodeResource>();
    const walk = (nodes: FolderTreeNodeResource[]) => nodes.forEach((n) => (map.set(n.id, n), walk(n.children)));
    walk(tree);
    return map;
  }, [tree]);
  const subfolders = currentFolder === null ? tree : byId.get(currentFolder)?.children ?? [];

  const breadcrumbs: FolderTreeNodeResource[] = [];
  for (let cur = currentFolder ? byId.get(currentFolder) : undefined; cur; cur = cur.parent ? byId.get(cur.parent) : undefined) {
    breadcrumbs.unshift(cur);
    if (breadcrumbs.length > 64) break;
  }

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['files'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
  };

  // Bulk upload queue (#702): one queue for the page; the target folder is
  // captured per batch so every file of a drop lands in the same folder.
  const queueRef = useRef<UploadQueue<FileResource> | null>(null);
  if (!queueRef.current) {
    queueRef.current = new UploadQueue<FileResource>({
      concurrency: 3,
      maxRetries: 2,
      onChange: (snap) => {
        setTasks(snap);
        if (snap.some((s) => s.status === 'done')) void qc.invalidateQueries({ queryKey: ['files'] });
      },
      findDuplicates: async (file): Promise<DuplicateHit[]> => {
        const hash = await sha256OfFile(file);
        if (!hash) return [];
        return (await client.files.duplicates(hash)).data.map((f) => ({ id: f.id, filenameDownload: f.filenameDownload, folder: f.folder }));
      },
      upload: async (task, onProgress, signal) => {
        const { data: presigned } = await client.files.getPresignedUrl(task.file.name);
        await putWithProgress(presigned.url, task.file, onProgress, signal);
        const { data } = await client.files.create({
          filenameDisk: presigned.key,
          filenameDownload: task.file.name,
          mime: task.file.type || 'application/octet-stream',
          filesize: task.file.size,
          folder: task.folder,
        });
        return data;
      },
    });
  }
  const queue = queueRef.current;

  const enqueue = (list: FileList | File[]) => {
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of Array.from(list)) {
      const reason = rejectFile(f, uploadConfig);
      if (reason) rejected.push(reason);
      else accepted.push(f);
    }
    if (rejected.length) alert(rejected.join('\n'));
    if (accepted.length) queue.add(accepted, currentFolder);
  };

  const deleteFolder = useMutation({
    mutationFn: (id: string) => client.folders.delete(id),
    onSuccess: invalidate,
    onError: (err: Error) => alert(err.message),
  });
  const renameFolder = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => client.folders.update(id, { name }),
    onSuccess: invalidate,
    onError: (err: Error) => alert(err.message),
  });
  const moveFolder = useMutation({
    mutationFn: ({ id, parent }: { id: string; parent: string | null }) => client.folders.update(id, { parent }),
    onSuccess: invalidate,
    onError: (err: Error) => alert(err.message),
  });
  const moveFiles = useMutation({
    mutationFn: ({ ids, folder }: { ids: string[]; folder: string | null }) => client.files.bulk({ ids, folder }),
    onSuccess: (res) => {
      const skipped = (res.meta?.skipped as Array<{ id: string; reason: string }> | undefined) ?? [];
      if (skipped.length) alert(`${skipped.length} file(s) could not be moved (${skipped.map((s) => s.reason).join(', ')}).`);
      setSelected(new Set());
      invalidate();
    },
    onError: (err: Error) => alert(err.message),
  });

  // Drag & drop: files onto a folder = move; a folder onto a folder = re-parent;
  // OS files onto the page = upload into the current folder.
  const onDragStartFiles = (e: DragEvent, id: string) => {
    const ids = selected.has(id) ? [...selected] : [id];
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: 'files', ids }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragStartFolder = (e: DragEvent, id: string) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: 'folder', id }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropOnFolder = (e: DragEvent, folder: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(undefined);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) {
      if (e.dataTransfer.files.length) {
        const list = Array.from(e.dataTransfer.files);
        const accepted = list.filter((f) => !rejectFile(f, uploadConfig));
        if (accepted.length) queue.add(accepted, folder);
      }
      return;
    }
    const payload = JSON.parse(raw) as { kind: 'files'; ids: string[] } | { kind: 'folder'; id: string };
    if (payload.kind === 'files') moveFiles.mutate({ ids: payload.ids, folder });
    else if (payload.id !== folder) moveFolder.mutate({ id: payload.id, parent: folder });
  };
  const folderDropProps = (folder: string | null) => ({
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget(undefined),
    onDrop: (e: DragEvent) => dropOnFolder(e, folder),
  });

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mx-auto flex max-w-7xl gap-6">
      <aside className="w-60 shrink-0 space-y-1 text-sm" aria-label={t('files.folders', 'Folders')}>
        <button
          type="button"
          onClick={() => setCurrentFolder(null)}
          {...folderDropProps(null)}
          className={cn('flex w-full items-center gap-1 rounded px-2 py-1 text-start hover:bg-muted', currentFolder === null && 'bg-muted font-medium', dropTarget === null && 'ring-2 ring-primary')}
        >
          <HardDrive className="h-4 w-4" /> {t('files.root', 'Root')}
        </button>
        <FolderTreeView
          nodes={tree}
          current={currentFolder}
          dropTarget={dropTarget}
          onOpen={setCurrentFolder}
          onRename={(id, name) => renameFolder.mutate({ id, name })}
          onDelete={(id) => confirm(t('files.confirmDeleteFolder', 'Delete this empty folder?')) && deleteFolder.mutate(id)}
          onDragStart={onDragStartFolder}
          dropProps={folderDropProps}
        />
      </aside>

      <section
        className="min-w-0 flex-1 space-y-4"
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDrop={(e) => {
          if (e.dataTransfer.files.length && !e.dataTransfer.getData(DRAG_MIME)) {
            e.preventDefault();
            enqueue(e.dataTransfer.files);
          }
        }}
      >
        <header className="flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold tracking-tight">{t('files', 'Files & Media')}</h1>
            <nav className="mt-2 flex items-center gap-1 text-sm text-muted-foreground" aria-label="Breadcrumbs">
              <button type="button" onClick={() => setCurrentFolder(null)} className="hover:text-foreground">
                {t('files.root', 'Root')}
              </button>
              {breadcrumbs.map((b) => (
                <span key={b.id} className="flex items-center gap-1">
                  <ChevronRight className="h-3 w-3" />
                  <button type="button" onClick={() => setCurrentFolder(b.id)} className="hover:text-foreground">
                    {b.name}
                  </button>
                </span>
              ))}
            </nav>
          </div>
          <div className="relative ms-auto w-64">
            <Search className="pointer-events-none absolute start-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('files.search', 'Search name, alt, keywords, credit…')}
              className="w-full rounded-md border py-1.5 ps-8 pe-2 text-sm outline-none focus:border-primary"
            />
          </div>
          <button type="button" onClick={() => setIsCreatingFolder(true)} className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted">
            <Plus className="h-4 w-4" /> {t('files.newFolder', 'New Folder')}
          </button>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Upload className="h-4 w-4" /> {t('files.upload', 'Upload')}
            <input
              type="file"
              className="hidden"
              multiple
              accept={acceptAttr}
              onChange={(e) => {
                if (e.target.files) enqueue(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        </header>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm" role="toolbar" aria-label="Selection">
            <span>
              {selected.size} {t('files.selected', 'selected')}
            </span>
            <button type="button" onClick={() => setBulkEditOpen(true)} className="ms-auto inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted">
              <Tags className="h-4 w-4" /> {t('files.bulkEdit', 'Edit metadata')}
            </button>
            <MoveToMenu tree={tree} onMove={(folder) => moveFiles.mutate({ ids: [...selected], folder })} />
            <button type="button" onClick={() => setSelected(new Set())} className="rounded px-2 py-1 hover:bg-muted">
              {t('common.clear', 'Clear')}
            </button>
          </div>
        )}

        {filesQuery.isLoading || treeQuery.isLoading ? (
          <div className="py-12 text-center text-muted-foreground">{t('common.loading', 'Loading…')}</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-5">
            {!debounced &&
              subfolders.map((folder) => (
                <div
                  key={folder.id}
                  draggable
                  onDragStart={(e) => onDragStartFolder(e, folder.id)}
                  {...folderDropProps(folder.id)}
                  className={cn('group relative flex cursor-pointer flex-col items-center gap-2 rounded-lg border bg-background p-4 transition-colors hover:bg-muted', dropTarget === folder.id && 'ring-2 ring-primary')}
                  onClick={() => setCurrentFolder(folder.id)}
                >
                  <Folder className="h-10 w-10 text-blue-500" />
                  <span className="w-full truncate text-center text-sm font-medium">{folder.name}</span>
                </div>
              ))}

            {files.map((file) => (
              <div
                key={file.id}
                draggable
                onDragStart={(e) => onDragStartFiles(e, file.id)}
                className={cn('group relative flex cursor-pointer flex-col items-center gap-2 rounded-lg border bg-background p-4 transition-colors hover:bg-muted', selected.has(file.id) && 'border-primary')}
                onClick={() => setDetailsId(file.id)}
              >
                <button
                  type="button"
                  aria-label={selected.has(file.id) ? 'Deselect' : 'Select'}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSelect(file.id);
                  }}
                  className="absolute start-2 top-2 text-muted-foreground"
                >
                  {selected.has(file.id) ? <CheckSquare className="h-4 w-4 text-primary" /> : <Square className="h-4 w-4 opacity-0 group-hover:opacity-100" />}
                </button>
                <FileIcon className="h-10 w-10 text-muted-foreground" />
                <span className="w-full truncate text-center text-sm font-medium">{file.filenameDownload}</span>
                <span className="text-xs text-muted-foreground">
                  {(file.filesize / 1024).toFixed(1)} KB{file.version && file.version > 1 ? ` · v${file.version}` : ''}
                </span>
                {file.scanStatus && !['skipped', 'clean'].includes(file.scanStatus) && (
                  <span className="rounded bg-amber-100 px-1.5 text-[10px] font-medium uppercase text-amber-800">{file.scanStatus}</span>
                )}
              </div>
            ))}

            {subfolders.length === 0 && files.length === 0 && (
              <div className="col-span-full rounded-lg border-2 border-dashed py-12 text-center text-muted-foreground">
                {debounced ? t('files.noMatches', 'No files match your search.') : t('files.empty', 'This folder is empty. Drop files here to upload.')}
              </div>
            )}
          </div>
        )}
      </section>

      {detailsId && <FileDetailsDrawer fileId={detailsId} onClose={() => setDetailsId(null)} onChanged={invalidate} />}
      {isCreatingFolder && <CreateFolderDialog parent={currentFolder} onClose={() => setIsCreatingFolder(false)} />}
      {bulkEditOpen && (
        <BulkEditDialog
          ids={[...selected]}
          onClose={() => setBulkEditOpen(false)}
          onDone={() => {
            setBulkEditOpen(false);
            invalidate();
          }}
        />
      )}
      <UploadQueuePanel tasks={tasks} queue={queue} />
    </div>
  );
}

interface FolderTreeViewProps {
  nodes: FolderTreeNodeResource[];
  current: string | null;
  dropTarget: string | null | undefined;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDragStart: (e: DragEvent, id: string) => void;
  dropProps: (folder: string | null) => Record<string, unknown>;
  depth?: number;
}

/** Folder tree sidebar (#701): open, rename, delete (empty only), drag to move. */
function FolderTreeView({ nodes, depth = 0, ...props }: FolderTreeViewProps) {
  return (
    <ul role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((n) => (
        <li key={n.id} role="treeitem" aria-selected={props.current === n.id}>
          <div
            draggable
            onDragStart={(e) => props.onDragStart(e, n.id)}
            {...props.dropProps(n.id)}
            style={{ paddingInlineStart: 8 + depth * 12 }}
            className={cn(
              'group flex items-center gap-1 rounded py-1 pe-1 hover:bg-muted',
              props.current === n.id && 'bg-muted font-medium',
              props.dropTarget === n.id && 'ring-2 ring-primary',
            )}
          >
            <button type="button" onClick={() => props.onOpen(n.id)} className="flex min-w-0 flex-1 items-center gap-1 text-start">
              <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500" />
              <span className="truncate">{n.name}</span>
            </button>
            <button
              type="button"
              aria-label={`Rename ${n.name}`}
              onClick={() => {
                const name = prompt('Folder name', n.name)?.trim();
                if (name && name !== n.name) props.onRename(n.id, name);
              }}
              className="hidden text-muted-foreground hover:text-foreground group-hover:block"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button type="button" aria-label={`Delete ${n.name}`} onClick={() => props.onDelete(n.id)} className="hidden text-muted-foreground hover:text-destructive group-hover:block">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
          {n.children.length > 0 && <FolderTreeView nodes={n.children} depth={depth + 1} {...props} />}
        </li>
      ))}
    </ul>
  );
}

function MoveToMenu({ tree, onMove }: { tree: FolderTreeNodeResource[]; onMove: (folder: string | null) => void }) {
  const options: Array<{ id: string | null; label: string }> = [{ id: null, label: '/ (root)' }];
  const walk = (nodes: FolderTreeNodeResource[]) => nodes.forEach((n) => (options.push({ id: n.id, label: n.namePath }), walk(n.children)));
  walk(tree);
  return (
    <label className="inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-muted">
      <FolderInput className="h-4 w-4" />
      <select
        aria-label="Move to folder"
        className="bg-transparent text-sm outline-none"
        value=""
        onChange={(e) => onMove(e.target.value === '__root__' ? null : e.target.value)}
      >
        <option value="" disabled>
          Move to…
        </option>
        {options.map((o) => (
          <option key={o.id ?? '__root__'} value={o.id ?? '__root__'}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Bulk edit editorial metadata after upload (#702). Empty inputs are left untouched. */
function BulkEditDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: () => void }) {
  const client = getApiClient();
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [credit, setCredit] = useState('');
  const [tags, setTags] = useState('');
  const mutation = useMutation({
    mutationFn: () => {
      const metadata: { alt?: string; caption?: string; credit?: string; tags?: string[] } = {};
      if (alt) metadata.alt = alt;
      if (caption) metadata.caption = caption;
      if (credit) metadata.credit = credit;
      const tagList = tags.split(',').map((s) => s.trim()).filter(Boolean);
      if (tagList.length) metadata.tags = tagList;
      return client.files.bulk({ ids, metadata });
    },
    onSuccess: onDone,
    onError: (err: Error) => alert(err.message),
  });
  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="block text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input value={value} onChange={(e) => set(e.target.value)} className="mt-1 w-full rounded-md border px-3 py-2 outline-none focus:border-primary" />
    </label>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="w-full max-w-md space-y-3 rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Edit {ids.length} file(s)</h2>
        {field('Alt text', alt, setAlt)}
        {field('Caption', caption, setCaption)}
        {field('Credit', credit, setCredit)}
        {field('Tags (comma separated)', tags, setTags)}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={mutation.isPending || !(alt || caption || credit || tags)}
            onClick={() => mutation.mutate()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateFolderDialog({ parent, onClose }: { parent: string | null; onClose: () => void }) {
  const client = getApiClient();
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const mutation = useMutation({
    mutationFn: () => client.folders.create({ name, parent }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['folders'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold">Create Folder</h2>
        <div className="space-y-4">
          <input
            type="text"
            autoFocus
            placeholder="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            onKeyDown={(e) => {
              if (e.key === 'Enter') mutation.mutate();
            }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted">
              Cancel
            </button>
            <button
              onClick={() => mutation.mutate()}
              disabled={!name || mutation.isPending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
