import type { Editor } from '@tiptap/core';
import {
  RICHTEXT_BLOCK_FEATURES,
  RICHTEXT_MARKS,
  type RichTextBlockDefinition,
  type RichTextBlockFeature,
  type RichTextFieldOptions,
  type RichTextMark,
} from '@lumibase/contracts/richtext';

/**
 * Editor commands shared by the toolbar, the slash menu and keyboard
 * shortcuts (#696). What a field allows (`fields.options`, see
 * `RichTextFieldOptions`) decides which commands exist at all — the API
 * enforces the same options on write.
 */

export interface ResolvedFeatures {
  marks: ReadonlySet<RichTextMark>;
  headingLevels: ReadonlyArray<1 | 2 | 3 | 4 | 5 | 6>;
  blocks: ReadonlySet<RichTextBlockFeature>;
  links: boolean;
  references: boolean;
}

export function resolveFeatures(o: RichTextFieldOptions): ResolvedFeatures {
  const blocks = new Set(o.blocks ?? RICHTEXT_BLOCK_FEATURES);
  const headingLevels = blocks.has('heading') ? (o.headingLevels ?? [1, 2, 3, 4, 5, 6]) : [];
  return {
    marks: new Set(o.marks ?? RICHTEXT_MARKS),
    headingLevels: [...headingLevels].sort(),
    blocks,
    links: o.links !== false,
    references: o.references !== false,
  };
}

/** Hooks the host component provides for commands that need UI (dialogs, pickers). */
export interface CommandHost {
  insertEmbed?: (inline: boolean) => void;
  insertItemRef?: () => void;
  editLink?: () => void;
  insertFootnote?: () => void;
}

export interface EditorCommand {
  id: string;
  label: string;
  /** Words matched by the slash menu filter. */
  keywords: string;
  /** Shown in the slash menu (block-level commands). */
  slash: boolean;
  shortcut?: string;
  run: (editor: Editor) => void;
}

const HEADING_SHORTCUT: Record<number, string> = { 1: 'Mod-Alt-1', 2: 'Mod-Alt-2', 3: 'Mod-Alt-3', 4: 'Mod-Alt-4', 5: 'Mod-Alt-5', 6: 'Mod-Alt-6' };

/** Block-level commands (toolbar block menu + slash menu). */
export function blockCommands(
  f: ResolvedFeatures,
  host: CommandHost,
  customBlocks: ReadonlyMap<string, RichTextBlockDefinition>,
): EditorCommand[] {
  const out: EditorCommand[] = [
    { id: 'paragraph', label: 'Text', keywords: 'paragraph text plain', slash: true, shortcut: 'Mod-Alt-0', run: (e) => e.chain().focus().setParagraph().run() },
  ];
  for (const level of f.headingLevels) {
    out.push({
      id: `heading-${level}`,
      label: `Heading ${level}`,
      keywords: `heading title h${level}`,
      slash: true,
      shortcut: HEADING_SHORTCUT[level],
      run: (e) => e.chain().focus().setHeading({ level }).run(),
    });
  }
  if (f.blocks.has('list')) {
    out.push(
      { id: 'bullet-list', label: 'Bulleted list', keywords: 'list bullet unordered ul', slash: true, shortcut: 'Mod-Shift-8', run: (e) => e.chain().focus().toggleBulletList().run() },
      { id: 'ordered-list', label: 'Numbered list', keywords: 'list numbered ordered ol', slash: true, shortcut: 'Mod-Shift-7', run: (e) => e.chain().focus().toggleOrderedList().run() },
    );
  }
  if (f.blocks.has('quote')) {
    out.push({ id: 'quote', label: 'Quote', keywords: 'quote blockquote citation', slash: true, shortcut: 'Mod-Shift-b', run: (e) => e.chain().focus().toggleBlockquote().run() });
  }
  if (f.blocks.has('code')) {
    out.push({ id: 'code-block', label: 'Code block', keywords: 'code pre snippet', slash: true, shortcut: 'Mod-Alt-c', run: (e) => e.chain().focus().toggleCodeBlock().run() });
  }
  if (f.blocks.has('rule')) {
    out.push({ id: 'rule', label: 'Divider', keywords: 'divider rule hr line separator', slash: true, run: (e) => e.chain().focus().setHorizontalRule().run() });
  }
  if (f.blocks.has('table')) {
    out.push({
      id: 'table',
      label: 'Table',
      keywords: 'table grid rows columns',
      slash: true,
      run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    });
  }
  if (f.blocks.has('embed') && f.references && host.insertEmbed) {
    out.push({ id: 'embed', label: 'Image or file', keywords: 'image media file embed picture upload', slash: true, run: () => host.insertEmbed?.(false) });
  }
  if (f.references && host.insertItemRef) {
    out.push({ id: 'item-ref', label: 'Link to item', keywords: 'reference relation item entry link', slash: true, run: () => host.insertItemRef?.() });
  }
  if (f.blocks.has('footnote') && host.insertFootnote) {
    out.push({ id: 'footnote', label: 'Footnote', keywords: 'footnote note reference citation', slash: true, run: () => host.insertFootnote?.() });
  }
  if (f.blocks.has('custom')) {
    for (const [name, def] of customBlocks) {
      out.push({
        id: `custom:${name}`,
        label: def.label ?? name,
        keywords: `${name} ${def.label ?? ''} ${def.description ?? ''} block`,
        slash: true,
        run: (e) =>
          e
            .chain()
            .focus()
            .insertContent({ type: 'lbCustom', attrs: { name, data: def.defaultData ?? {} } })
            .run(),
      });
    }
  }
  return out;
}

/** Filter for the slash menu: every word of the query must prefix-match a keyword or the label. */
export function filterCommands(commands: EditorCommand[], query: string): EditorCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands.filter((c) => c.slash);
  return commands.filter((c) => {
    if (!c.slash) return false;
    const hay = `${c.label} ${c.keywords}`.toLowerCase().split(/\s+/);
    return words.every((w) => hay.some((h) => h.startsWith(w)));
  });
}
