import Editor from '@/components/lazy-monaco-editor';
import { Code2, Eye } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface RawToggleProps {
  /** When raw mode is off, the wrapped interface is rendered. */
  children: ReactNode;
  value: unknown;
  onChange: (next: unknown) => void;
  /** Disable Monaco edits but still allow inspection. */
  disabled?: boolean;
}

/**
 * Per-field Raw / GUI toggle.
 *
 * The author can switch any field to a Monaco JSON editor for fine-grained
 * editing, then flip back to the registered interface. While Monaco is on
 * we own the source of truth via local text state to preserve in-flight
 * keystrokes; on toggle-off we reset that buffer so the next switch starts
 * fresh from the latest upstream value.
 */
export function RawToggle({ children, value, onChange, disabled }: RawToggleProps) {
  const [raw, setRaw] = useState(false);
  const [text, setText] = useState(() => stringify(value));
  const [error, setError] = useState<string | null>(null);

  // When upstream value changes (e.g. revert), re-seed the buffer in raw mode
  // only if it's currently valid (avoid clobbering an in-flight invalid edit).
  useEffect(() => {
    if (!raw) return;
    try {
      const parsed = JSON.parse(text);
      if (JSON.stringify(parsed) !== JSON.stringify(value)) setText(stringify(value));
    } catch {
      /* keep editing */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, raw]);

  return (
    <div className="space-y-1">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            const next = !raw;
            setRaw(next);
            if (next) {
              setText(stringify(value));
              setError(null);
            }
          }}
          aria-label={raw ? 'Switch to GUI editor' : 'Switch to raw JSON'}
          title={raw ? 'GUI editor' : 'Raw JSON'}
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase',
            raw ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent',
          )}
        >
          {raw ? <Eye className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
          {raw ? 'GUI' : 'Raw'}
        </button>
      </div>
      {raw ? (
        <div className="space-y-1">
          <div className="overflow-hidden rounded-md border" dir="ltr">
            <Editor
              height="20vh"
              defaultLanguage="json"
              theme="vs-light"
              value={text}
              onChange={(next) => {
                const v = next ?? '';
                setText(v);
                if (v.trim() === '') {
                  setError(null);
                  onChange(null);
                  return;
                }
                try {
                  const parsed = JSON.parse(v);
                  setError(null);
                  onChange(parsed);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              options={{
                readOnly: disabled,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                tabSize: 2,
              }}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}
