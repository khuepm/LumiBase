import { Bold, Italic, Link as LinkIcon, List, ListOrdered, Underline as UnderlineIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { sanitizeHtml } from '@/lib/sanitize-html';
import type { InterfaceComponent } from './types';

/**
 * `wysiwyg` — contenteditable-backed rich-text editor.
 *
 * Intentionally dependency-free: uses `document.execCommand` for a minimal
 * toolbar (bold/italic/underline/link/list). Switch to a full editor
 * (Tiptap/Lexical) by replacing this component without touching the registry.
 */
export const WysiwygInterface: InterfaceComponent<string> = ({
  value,
  disabled,
  onChange,
}) => {
  const ref = useRef<HTMLDivElement>(null);

  // Only push upstream HTML into the DOM when it differs (avoid caret jumps).
  // Sanitise on the way in: stored content may carry XSS payloads from an
  // earlier write, another client, or an API consumer (Stored XSS defence).
  useEffect(() => {
    const next = sanitizeHtml(value ?? '');
    if (ref.current && ref.current.innerHTML !== next) {
      ref.current.innerHTML = next;
    }
  }, [value]);

  const exec = (cmd: string, arg?: string) => {
    if (disabled) return;
    document.execCommand(cmd, false, arg);
    if (ref.current) onChange(sanitizeHtml(ref.current.innerHTML));
  };

  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center gap-1 border-b bg-muted/30 px-2 py-1">
        <ToolbarBtn onClick={() => exec('bold')} label="Bold"><Bold className="h-3.5 w-3.5" /></ToolbarBtn>
        <ToolbarBtn onClick={() => exec('italic')} label="Italic"><Italic className="h-3.5 w-3.5" /></ToolbarBtn>
        <ToolbarBtn onClick={() => exec('underline')} label="Underline"><UnderlineIcon className="h-3.5 w-3.5" /></ToolbarBtn>
        <span className="mx-1 h-3 w-px bg-border" />
        <ToolbarBtn onClick={() => exec('insertUnorderedList')} label="Bulleted list"><List className="h-3.5 w-3.5" /></ToolbarBtn>
        <ToolbarBtn onClick={() => exec('insertOrderedList')} label="Numbered list"><ListOrdered className="h-3.5 w-3.5" /></ToolbarBtn>
        <ToolbarBtn
          onClick={() => {
            const url = prompt('Link URL');
            if (url) exec('createLink', url);
          }}
          label="Link"
        >
          <LinkIcon className="h-3.5 w-3.5" />
        </ToolbarBtn>
      </div>
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={() => ref.current && onChange(sanitizeHtml(ref.current.innerHTML))}
        className={cn(
          'prose prose-sm max-w-none px-3 py-2 text-sm focus:outline-none',
          disabled && 'opacity-50',
        )}
      />
    </div>
  );
};

function ToolbarBtn({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}
