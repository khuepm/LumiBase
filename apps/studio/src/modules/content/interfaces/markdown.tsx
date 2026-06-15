import { Eye, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { sanitizeHtml } from '@/lib/sanitize-html';
import { readOptions, type InterfaceComponent } from './types';

interface MarkdownOptions {
  placeholder?: string;
  rows?: number;
}

type Mode = 'write' | 'preview';

/**
 * `markdown` — split textarea + preview pane.
 *
 * The preview is a *minimal* markdown-ish renderer (headings, bold/italic,
 * code, links, line breaks) implemented inline to avoid a runtime dep.
 * Authors who need full Commonmark can switch to the Code interface with
 * `language: markdown` (Monaco) or wait for the Shiki-powered preview in a
 * later iteration.
 */
export const MarkdownInterface: InterfaceComponent<string> = ({
  value,
  field,
  disabled,
  onChange,
}) => {
  const opts = readOptions<MarkdownOptions>(field);
  const [mode, setMode] = useState<Mode>('write');
  const html = useMemo(() => renderMarkdown(value ?? ''), [value]);

  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center gap-1 border-b bg-muted/30 px-2 py-1">
        <TabBtn active={mode === 'write'} onClick={() => setMode('write')}>
          <FileText className="h-3.5 w-3.5" /> Write
        </TabBtn>
        <TabBtn active={mode === 'preview'} onClick={() => setMode('preview')}>
          <Eye className="h-3.5 w-3.5" /> Preview
        </TabBtn>
      </div>
      {mode === 'write' ? (
        <textarea
          value={value ?? ''}
          disabled={disabled}
          rows={opts.rows ?? 8}
          placeholder={opts.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full resize-y bg-background px-3 py-2 font-mono text-xs focus:outline-none disabled:opacity-50"
        />
      ) : (
        <div
          className="prose prose-sm max-w-none px-3 py-2"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
};

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs',
        active ? 'bg-background shadow-sm' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Tiny markdown renderer. escapeHtml + targeted regex builds the markup, then
 * DOMPurify is the authoritative gate: the regex alone would still let through
 * `[x](javascript:alert(1))` links and unescaped quotes, so the final
 * sanitizeHtml() pass strips dangerous URL schemes and stray attributes.
 */
function renderMarkdown(src: string): string {
  let html = escapeHtml(src);
  // Code blocks ```lang ... ```
  html = html.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre><code>${code.trim()}</code></pre>`);
  // Inline code `x`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headings
  html = html.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  // Bold + italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  // Paragraphs / line breaks
  html = html
    .split(/\n{2,}/)
    .map((para) => (para.match(/^<(h\d|pre|ul|ol)/) ? para : `<p>${para.replace(/\n/g, '<br/>')}</p>`))
    .join('');
  return sanitizeHtml(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
