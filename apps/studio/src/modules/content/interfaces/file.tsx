import { File, Upload, X } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { cn } from '@/lib/cn';
import { getApiClient } from '@/lib/api';
import { readOptions, type InterfaceComponent } from './types';
import { formatSafeError } from '@lumibase/shared/utils';

interface FileOptions {
  accept?: string;
  /** Max file size in bytes (UI hint only). */
  maxSize?: number;
}

/**
 * `file` — drag/drop or browse, uploads through the CMS presigned upload
 * endpoint, creates a file record, and stores the returned storage key.
 */
export const FileInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<FileOptions>(field);
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const client = getApiClient();
  const [uploading, setUploading] = useState(false);

  const handle = async (file: File) => {
    if (opts.maxSize && file.size > opts.maxSize) {
      alert(`File exceeds max size (${opts.maxSize} bytes).`);
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

      onChange(fileRecord.filenameDisk);
    } catch (err) {
      console.error(formatSafeError(err));
      alert('Failed to upload file.');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handle(file);
  };

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-sm">
        <File className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-xs">{value}</span>
        {!disabled && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear file"
            className="text-muted-foreground hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed bg-background px-3 py-6 text-sm text-muted-foreground transition',
        over && 'border-primary bg-primary/5',
        disabled && 'pointer-events-none opacity-50',
      )}
      onClick={() => inputRef.current?.click()}
      role="button"
    >
      <Upload className="h-4 w-4" />
      <span>{uploading ? 'Uploading...' : 'Drop a file or click to browse'}</span>
      <span className="text-[10px]">
        uploads to Cloudflare R2 / S3 storage
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={opts.accept}
        hidden
        onChange={(e) => e.target.files?.[0] && handle(e.target.files[0])}
      />
    </div>
  );
};
