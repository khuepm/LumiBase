import { File, Plus, Upload, X } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { readOptions, type InterfaceComponent } from './types';

interface FilesOptions {
  accept?: string;
  maxSize?: number;
  limit?: number;
}

export const FilesInterface: InterfaceComponent<string[]> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<FilesOptions>(field);
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const client = getApiClient();
  const files = Array.isArray(value) ? value : [];
  const limit = opts.limit ?? 15;

  const upload = async (file: File) => {
    if (opts.maxSize && file.size > opts.maxSize) {
      alert(`File exceeds max size (${opts.maxSize} bytes).`);
      return;
    }
    if (files.length >= limit) {
      alert(`This field allows up to ${limit} files.`);
      return;
    }

    setUploading(true);
    try {
      const { data: presigned } = await client.files.getPresignedUrl(file.name);

      await fetch(presigned.url, {
        method: 'PUT',
        body: file,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
        },
      });

      const { data: fileRecord } = await client.files.create({
        filenameDisk: presigned.key,
        filenameDownload: file.name,
        mime: file.type || 'application/octet-stream',
        filesize: file.size,
      });

      onChange([...files, fileRecord.filenameDisk]);
    } catch (err) {
      console.error(err);
      alert('Failed to upload file.');
    } finally {
      setUploading(false);
    }
  };

  const handleFiles = async (list: FileList | null) => {
    if (!list) return;
    for (const file of Array.from(list).slice(0, Math.max(0, limit - files.length))) {
      await upload(file);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    void handleFiles(event.dataTransfer.files);
  };

  const remove = (file: string) => {
    onChange(files.filter((item) => item !== file));
  };

  return (
    <div className="space-y-2">
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((file) => (
            <li
              key={file}
              className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              <File className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 truncate font-mono text-xs">{file}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(file)}
                  aria-label={`Remove ${file}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed bg-background px-3 py-5 text-sm text-muted-foreground transition',
          over && 'border-primary bg-primary/5',
          disabled && 'pointer-events-none opacity-50',
        )}
        onClick={() => inputRef.current?.click()}
        role="button"
      >
        {files.length > 0 ? <Plus className="h-4 w-4" /> : <Upload className="h-4 w-4" />}
        <span>{uploading ? 'Uploading...' : 'Drop files or click to browse'}</span>
        <span className="text-[10px]">
          {files.length}/{limit} files
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={opts.accept}
          multiple
          hidden
          onChange={(event) => void handleFiles(event.target.files)}
        />
      </div>
    </div>
  );
};
