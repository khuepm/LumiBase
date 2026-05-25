import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Folder, File as FileIcon, Upload, Trash2, HardDrive, Search, Plus, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { getApiClient } from '@/lib/api';
import type { FolderResource, FileResource } from '@lumibase/sdk';

export function FilesPage() {
  const { t } = useTranslation();
  const client = getApiClient();
  const qc = useQueryClient();

  const foldersQuery = useQuery({
    queryKey: ['folders'],
    queryFn: async () => (await client.folders.list()).data,
  });

  const filesQuery = useQuery({
    queryKey: ['files'],
    queryFn: async () => (await client.files.list()).data,
  });

  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);

  const folders = foldersQuery.data ?? [];
  const files = filesQuery.data ?? [];

  const displayedFolders = folders.filter(f => f.parent === currentFolder);
  const displayedFiles = files.filter(f => f.folder === currentFolder);

  const breadcrumbs = [];
  let curr = currentFolder;
  while (curr) {
    const f = folders.find(x => x.id === curr);
    if (!f) break;
    breadcrumbs.unshift(f);
    curr = f.parent;
  }

  const deleteFolderMutation = useMutation({
    mutationFn: (id: string) => client.folders.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['folders'] }),
  });

  const deleteFileMutation = useMutation({
    mutationFn: (id: string) => client.files.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  });

  // Real upload logic
  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      const { data: presigned } = await client.files.getPresignedUrl(file.name);
      
      // Perform the actual upload to R2/S3 via Hono Worker proxy
      await fetch(presigned.url, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
      });

      return client.files.create({
        filenameDisk: presigned.key,
        filenameDownload: file.name,
        mime: file.type || 'application/octet-stream',
        filesize: file.size,
        folder: currentFolder,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    for (const f of fileList) {
      uploadFileMutation.mutate(f);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('files', 'Files & Media')}</h1>
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <button 
              onClick={() => setCurrentFolder(null)} 
              className="hover:text-foreground"
            >
              <HardDrive className="h-4 w-4 inline mr-1" /> Root
            </button>
            {breadcrumbs.map(b => (
              <span key={b.id} className="flex items-center gap-2">
                <span>/</span>
                <button onClick={() => setCurrentFolder(b.id)} className="hover:text-foreground">
                  {b.name}
                </button>
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsCreatingFolder(true)}
            className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" /> New Folder
          </button>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Upload className="h-4 w-4" /> Upload
            <input type="file" className="hidden" multiple onChange={handleFileUpload} />
          </label>
        </div>
      </header>

      {foldersQuery.isLoading || filesQuery.isLoading ? (
        <div className="py-12 text-center text-muted-foreground">Loading...</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-6">
          {displayedFolders.map(folder => (
            <div 
              key={folder.id}
              className="group relative flex cursor-pointer flex-col items-center gap-2 rounded-lg border bg-background p-4 transition-colors hover:bg-muted"
              onClick={() => setCurrentFolder(folder.id)}
            >
              <Folder className="h-10 w-10 text-blue-500" />
              <span className="text-sm font-medium truncate w-full text-center">{folder.name}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm('Delete folder?')) deleteFolderMutation.mutate(folder.id);
                }}
                className="absolute top-2 right-2 hidden text-muted-foreground hover:text-destructive group-hover:block"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}

          {displayedFiles.map(file => (
            <div 
              key={file.id}
              className="group relative flex flex-col items-center gap-2 rounded-lg border bg-background p-4 transition-colors hover:bg-muted"
            >
              <FileIcon className="h-10 w-10 text-muted-foreground" />
              <span className="text-sm font-medium truncate w-full text-center">{file.filenameDownload}</span>
              <span className="text-xs text-muted-foreground">{(file.filesize / 1024).toFixed(1)} KB</span>
              
              <div className="absolute top-2 right-2 hidden items-center gap-1 group-hover:flex">
                <button
                  onClick={() => {
                    if (confirm('Delete file?')) deleteFileMutation.mutate(file.id);
                  }}
                  className="text-muted-foreground hover:text-destructive p-1"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}

          {displayedFolders.length === 0 && displayedFiles.length === 0 && (
            <div className="col-span-full py-12 text-center border-2 border-dashed rounded-lg text-muted-foreground">
              This folder is empty.
            </div>
          )}
        </div>
      )}

      {isCreatingFolder && (
        <CreateFolderDialog 
          parent={currentFolder} 
          onClose={() => setIsCreatingFolder(false)} 
        />
      )}
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
      qc.invalidateQueries({ queryKey: ['folders'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold mb-4">Create Folder</h2>
        <div className="space-y-4">
          <input
            type="text"
            autoFocus
            placeholder="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm outline-none focus:border-primary"
            onKeyDown={(e) => { if (e.key === 'Enter') mutation.mutate(); }}
          />
          <div className="flex justify-end gap-2 mt-4">
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
