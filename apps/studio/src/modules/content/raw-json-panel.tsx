import Editor from '@/components/lazy-monaco-editor';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';

interface RawJsonPanelProps {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

/**
 * Monaco-backed JSON editor for the entire `data` payload of an item.
 * Two-way sync: external `value` changes overwrite the editor only when it
 * isn't being edited (no unsaved diff); local edits parse on the fly and
 * propagate up only on valid JSON.
 */
export function RawJsonPanel({ value, onChange }: RawJsonPanelProps) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  // Re-sync editor text when the upstream value changes and the editor matches
  // (i.e. no in-flight edit). Detected by comparing stringified payloads.
  useEffect(() => {
    const upstream = JSON.stringify(value, null, 2);
    try {
      const current = JSON.stringify(JSON.parse(text), null, 2);
      if (current !== upstream) {
        // Caller-driven update (e.g. revert) — overwrite if the user has no
        // pending changes; otherwise leave the local draft alone.
        if (error === null) setText(upstream);
      }
    } catch {
      // Invalid JSON in the editor — don't clobber user input.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleChange = (next: string | undefined) => {
    const v = next ?? '';
    setText(v);
    try {
      const parsed = JSON.parse(v);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Top-level value must be a JSON object.');
        return;
      }
      setError(null);
      onChange(parsed as Record<string, unknown>);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-2">
      <div
        className={`flex items-center gap-2 rounded-md border px-2 py-1 text-xs ${
          error
            ? 'border-destructive/40 bg-destructive/10 text-destructive'
            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
        }`}
      >
        {error ? <AlertCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        <span>{error ?? 'Valid JSON — saves apply via the Save button.'}</span>
      </div>
      <div className="overflow-hidden rounded-md border">
        <Editor
          height="60vh"
          defaultLanguage="json"
          theme="vs-light"
          value={text}
          onChange={handleChange}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            tabSize: 2,
            formatOnPaste: true,
          }}
        />
      </div>
    </div>
  );
}
