import { Bold, ImagePlus, Italic, Link as LinkIcon, List, ListOrdered, Underline as UnderlineIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { sanitizeHtml } from '@/lib/sanitize-html';
import { contentDirProps } from '@/lib/text-direction';
import { assetHtml } from '@/modules/files/embed';
import { useMediaPicker } from '@/modules/files/media-picker';
import type { InterfaceComponent } from './types';

/**
 * `wysiwyg` — contenteditable-backed rich-text editor.
 *
 * Intentionally dependency-free: uses `document.execCommand` for a minimal
 * toolbar (bold/italic/underline/link/list), plus "insert from library",
 * which opens the shared media picker (#708) and embeds the chosen files. Switch to a full editor
 * (Tiptap/Lexical) by replacing this component without touching the registry.
 */
export const WysiwygInterface: InterfaceComponent<string> = ({
  value,
  disabled,
  onChange,
  locale,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const openPicker = useMediaPicker();
  // The picker dialog takes focus; remember where the caret was so the
  // embed lands there instead of at the end of the document.
  const savedRange = useRef<Range | null>(null);

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

  const rememberSelection = () => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    savedRange.current =
      sel && sel.rangeCount > 0 && ref.current?.contains(sel.getRangeAt(0).commonAncestorContainer)
        ? sel.getRangeAt(0).cloneRange()
        : null;
  };

  const insertFromLibrary = async () => {
    if (disabled || !openPicker) return;
    rememberSelection();
    const picked = await openPicker({ multiple: true, title: 'Insert from library' });
    if (!picked?.length || !ref.current) return;
    ref.current.focus();
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      if (savedRange.current) sel.addRange(savedRange.current);
      else {
        const end = document.createRange();
        end.selectNodeContents(ref.current);
        end.collapse(false);
        sel.addRange(end);
      }
    }
    exec('insertHTML', picked.map(assetHtml).join(' '));
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
        {openPicker && (
          <ToolbarBtn onClick={() => void insertFromLibrary()} label="Insert from library">
            <ImagePlus className="h-3.5 w-3.5" />
          </ToolbarBtn>
        )}
      </div>
      <div
        ref={ref}
        {...contentDirProps(locale)}
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
