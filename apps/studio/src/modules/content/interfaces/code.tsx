import Editor from '@/components/lazy-monaco-editor';
import { readOptions, type InterfaceComponent } from './types';

interface CodeOptions {
  /** Monaco language id (e.g. `javascript`, `typescript`, `html`, `sql`). */
  language?: string;
  height?: string;
}

/** `code` — Monaco-backed code editor; value is stored as a string. */
export const CodeInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<CodeOptions>(field);
  return (
    <div className="overflow-hidden rounded-md border" dir="ltr">
      <Editor
        height={opts.height ?? '20vh'}
        defaultLanguage={opts.language ?? 'plaintext'}
        theme="vs-light"
        value={value ?? ''}
        onChange={(next) => onChange(next ?? null)}
        options={{
          readOnly: disabled,
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          tabSize: 2,
        }}
      />
    </div>
  );
};
