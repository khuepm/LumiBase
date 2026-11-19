import type { RichTextBlock, RichTextRef } from './model';

/**
 * Rich-text plugin hooks (#698 / #697): custom blocks registered by an
 * extension, a block template or the host app. A plugin teaches the
 * serialisers how to render a `{ type: 'custom', name, data }` block; the
 * Studio editor uses the same definition for its slash menu.
 *
 * Renderer output is untrusted: `richTextToHtml` passes the whole document
 * through the allowlist sanitiser after every renderer has run.
 */

export interface RichTextRenderContext {
  /** Escape text for HTML (use it for every value interpolated into markup). */
  escape: (text: string) => string;
  /** Resolve an item/file reference to a URL, when the host provided a resolver. */
  resolveRef: (ref: RichTextRef) => string | null;
}

export interface RichTextBlockDefinition {
  /** Human label (slash menu, block picker). */
  label?: string;
  /** Short help text for the slash menu. */
  description?: string;
  /** Lucide icon name for the editor. */
  icon?: string;
  /** Data a freshly inserted block starts with. */
  defaultData?: Record<string, unknown>;
  /** HTML for the block. Omit to render an inert `<div data-block>` placeholder. */
  toHtml?: (data: Record<string, unknown>, ctx: RichTextRenderContext) => string;
  /** Markdown for the block. Omit to keep the lossless fenced form (see `richTextToMarkdown`). */
  toMarkdown?: (data: Record<string, unknown>) => string;
  /** Plain text for search indexing / previews. */
  toText?: (data: Record<string, unknown>) => string;
}

export interface RichTextPlugin {
  /** Unique plugin id, e.g. the extension id. */
  name: string;
  /** Custom block definitions keyed by block `name`. */
  blocks?: Record<string, RichTextBlockDefinition>;
  /**
   * Markdown import hook (remark-style): rewrite the parsed blocks, e.g. to
   * turn a recognised pattern into a custom block. Runs in plugin order.
   */
  transformMarkdownImport?: (blocks: RichTextBlock[]) => RichTextBlock[];
}

/** Merge plugin block definitions; a later plugin wins on a name clash. */
export function collectRichTextBlocks(plugins: readonly RichTextPlugin[] = []): Map<string, RichTextBlockDefinition> {
  const out = new Map<string, RichTextBlockDefinition>();
  for (const p of plugins) for (const [name, def] of Object.entries(p.blocks ?? {})) out.set(name, def);
  return out;
}

/** Identity helper with type inference for extension authors. */
export function defineRichTextPlugin(plugin: RichTextPlugin): RichTextPlugin {
  return plugin;
}
