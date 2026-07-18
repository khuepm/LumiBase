import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import rehypeShikiFromHighlighter from '@shikijs/rehype/core';
import { createHighlighter, type Highlighter, type ShikiTransformer } from 'shiki';
import type { Components } from 'react-markdown';
import type { HTMLAttributes, ReactNode, TableHTMLAttributes } from 'react';
import { LinkRewriter } from './LinkRewriter';
import { defaultLocale } from 'virtual:docs-registry';

/**
 * MarkdownRenderer — renders Markdown content as styled HTML using
 * react-markdown with a remark/rehype plugin pipeline.
 *
 * Pipeline:
 *   react-markdown
 *     → remark-gfm (tables, strikethrough, task lists)
 *     → remark-frontmatter (strip any remaining front matter)
 *     → rehype-slug (add IDs to headings for ToC anchors)
 *     → rehype-shiki (syntax highlighting)
 *     → custom component overrides (tables, code blocks, headings, etc.)
 *
 * Article typography follows the LumiBase "dark cosmic" design system.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

export interface MarkdownRendererProps {
  content: string;
  currentSlug: string;
  knownSlugs: Set<string>;
  /** Current active locale — used for link rewriting (Requirements 8.1, 8.2) */
  currentLocale?: string;
}

/**
 * Extracts the code-fence language from a <pre>'s children by looking for a
 * `language-*` class on the inner <code> element (plain, non-Shiki path).
 */
function extractLanguage(children: ReactNode): string | undefined {
  for (const child of Children.toArray(children)) {
    if (isValidElement<{ className?: string }>(child)) {
      const match = /language-([\w+-]+)/.exec(child.props.className ?? '');
      if (match) return match[1];
    }
  }
  return undefined;
}

type CodeBlockProps = HTMLAttributes<HTMLPreElement> & {
  node?: unknown;
  'data-language'?: string;
};

/**
 * Fenced code block shell — dark rounded card with a header row showing the
 * language and a Copy button (per the design system's code block).
 */
function CodeBlock({
  children,
  className,
  node: _node,
  style: _style,
  'data-language': dataLanguage,
  ...props
}: CodeBlockProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const language = dataLanguage ?? extractLanguage(children) ?? 'code';

  return (
    <div className="my-[18px] overflow-hidden rounded-[14px] bg-[var(--color-surface-sunken)] ring-glass">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-xs font-medium text-muted-foreground">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Copy code to clipboard"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <pre
        ref={preRef}
        className={`${className ?? ''} m-0 overflow-x-auto bg-transparent p-4 font-mono text-[13.5px] leading-[22px] text-foreground`}
        {...props}
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * Custom component overrides for react-markdown.
 * Provides Tailwind-styled elements for all standard Markdown constructs.
 */
const components: Components = {
  // Headings
  h1: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h1
      className="mb-4 mt-8 text-[44px] font-bold leading-[52px] tracking-[-0.5px] text-foreground"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h2
      className="mb-3.5 mt-[52px] scroll-mt-[90px] text-[26px] font-bold tracking-[-0.3px] text-foreground"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className="mb-2.5 mt-9 scroll-mt-[90px] text-[19px] font-semibold leading-[26px] tracking-[-0.2px] text-foreground"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h4
      className="mb-2 mt-6 scroll-mt-[90px] text-[16px] font-semibold text-foreground"
      {...props}
    >
      {children}
    </h4>
  ),
  h5: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h5 className="mb-1 mt-5 text-[15px] font-semibold text-foreground" {...props}>
      {children}
    </h5>
  ),
  h6: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h6
      className="mb-1 mt-5 text-sm font-semibold text-muted-foreground"
      {...props}
    >
      {children}
    </h6>
  ),

  // Paragraphs
  p: ({ children, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
    <p
      className="my-3.5 text-[16px] font-medium leading-[27px] text-[var(--color-text-secondary)]"
      {...props}
    >
      {children}
    </p>
  ),

  // Blockquotes — rendered as the design system's note callout
  blockquote: ({ children, ...props }: HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      className="my-6 flex gap-3.5 rounded-2xl bg-[color-mix(in_srgb,var(--color-blue)_10%,transparent)] px-5 py-[18px] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-blue)_32%,transparent)]"
      {...props}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 h-5 w-5 shrink-0 rounded-full bg-[var(--color-blue)] shadow-[0_0_16px_color-mix(in_srgb,var(--color-blue)_50%,transparent)]"
      />
      <div className="min-w-0 flex-1">{children}</div>
    </blockquote>
  ),

  // Lists
  ul: ({ children, ...props }: HTMLAttributes<HTMLUListElement>) => (
    <ul
      className="my-3.5 ml-6 list-disc space-y-1.5 text-[var(--color-text-secondary)] marker:text-muted-foreground"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: HTMLAttributes<HTMLOListElement>) => (
    <ol
      className="my-3.5 ml-6 list-decimal space-y-1.5 text-[var(--color-text-secondary)] marker:text-muted-foreground"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }: HTMLAttributes<HTMLLIElement>) => (
    <li className="font-medium leading-[27px]" {...props}>
      {children}
    </li>
  ),

  // Tables — dark surfaces with hairline borders
  table: ({ children, ...props }: TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-5 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
    <thead className="bg-[var(--color-glass)]" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }: HTMLAttributes<HTMLTableSectionElement>) => (
    <tbody {...props}>{children}</tbody>
  ),
  tr: ({ children, ...props }: HTMLAttributes<HTMLTableRowElement>) => (
    <tr className="border-b border-border even:bg-[color-mix(in_srgb,var(--color-glass)_40%,transparent)]" {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
    <th
      className="border border-border px-3 py-2 text-left font-semibold text-foreground"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
    <td
      className="border border-border px-3 py-2 font-medium text-[var(--color-text-secondary)]"
      {...props}
    >
      {children}
    </td>
  ),

  // Inline code
  code: ({ children, className, ...props }: HTMLAttributes<HTMLElement>) => {
    // If className contains "language-", it's a code block handled by Shiki.
    // Shiki wraps highlighted code in <pre><code class="language-xxx">.
    // We only style inline code here (no language class, not inside <pre>).
    const isBlock = className && /language-/.test(className);
    if (isBlock) {
      // Code block — rendered by Shiki or as plain monospace.
      // Return as-is; the <pre> wrapper handles styling.
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    // Inline code
    return (
      <code
        className="rounded-md bg-[var(--color-glass)] px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
        {...props}
      >
        {children}
      </code>
    );
  },

  // Fenced code blocks (the <pre> wrapper) — dark card with header + Copy
  pre: (props: CodeBlockProps) => <CodeBlock {...props} />,

  // Horizontal rules
  hr: ({ ...props }: HTMLAttributes<HTMLHRElement>) => (
    <hr className="my-8 border-t border-border" {...props} />
  ),

  // Strong / Bold
  strong: ({ children, ...props }: HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),

  // Emphasis / Italic
  em: ({ children, ...props }: HTMLAttributes<HTMLElement>) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),

  // Links — handled by LinkRewriter (injected dynamically per render with slug context)
};

/**
 * Shiki highlighter configuration.
 * Pre-creates a highlighter instance so rehype-shiki can run synchronously
 * within react-markdown's runSync pipeline.
 */
const SHIKI_THEMES = ['github-light', 'github-dark'] as const;
const SHIKI_LANGS = [
  'typescript',
  'javascript',
  'json',
  'yaml',
  'sql',
  'bash',
  'markdown',
] as const;

// Singleton promise so we only create one highlighter instance
let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighterInstance(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [...SHIKI_THEMES],
      langs: [...SHIKI_LANGS],
    });
  }
  return highlighterPromise;
}

/**
 * Shiki transformer that records the fence language on the <pre> element so
 * the CodeBlock header can display it (the language class is lost otherwise).
 */
const languageBadgeTransformer: ShikiTransformer = {
  pre(node) {
    node.properties['data-language'] = this.options.lang;
  },
};

export function MarkdownRenderer({
  content,
  currentSlug,
  knownSlugs,
  currentLocale,
}: MarkdownRendererProps) {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  useEffect(() => {
    getHighlighterInstance().then(setHighlighter);
  }, []);

  // Build components object with the link rewriter that has access to slug context.
  // Memoized so react-markdown doesn't re-create component instances on every render.
  const componentsWithLinks: Components = useMemo(
    () => ({
      ...components,
      a: (props) => (
        <LinkRewriter
          currentSlug={currentSlug}
          knownSlugs={knownSlugs}
          currentLocale={currentLocale ?? defaultLocale}
          {...props}
        />
      ),
    }),
    [currentSlug, knownSlugs, currentLocale],
  );

  // Build rehype plugins — only include shiki when highlighter is ready.
  // rehypeRaw must run first: react-markdown's remark→rehype conversion
  // otherwise leaves embedded HTML (e.g. the <div align="center"> banners
  // and comparison tables in tutorials) as literal raw/comment mdast nodes,
  // which render as escaped text instead of real elements. rehypeRaw parses
  // that raw HTML into actual hast elements so every plugin after it (and
  // the component overrides below) sees real <div>/<table>/<h2> nodes.
  const rehypePlugins = useMemo(() => {
    const plugins: any[] = [rehypeRaw, rehypeSlug];
    if (highlighter) {
      plugins.push([
        rehypeShikiFromHighlighter,
        highlighter,
        {
          themes: {
            light: 'github-light',
            dark: 'github-dark',
          },
          transformers: [languageBadgeTransformer],
        },
      ]);
    }
    return plugins;
  }, [highlighter]);

  return (
    <div className="prose-docs max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkFrontmatter]}
        rehypePlugins={rehypePlugins}
        components={componentsWithLinks}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
