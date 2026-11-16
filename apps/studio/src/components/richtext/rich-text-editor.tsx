import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { Placeholder } from '@tiptap/extensions';
import {
  Asterisk,
  AtSign,
  Bold,
  Braces,
  Code,
  Columns3,
  FileDown,
  FileUp,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  PanelLeft,
  PanelTop,
  Quote,
  Redo2,
  Rows3,
  SquareCode,
  Strikethrough,
  Subscript as SubscriptIcon,
  Superscript as SuperscriptIcon,
  Table as TableIcon,
  Trash2,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react';
import {
  markdownToRichText,
  richTextToMarkdown,
  safeHref,
  type RichTextDocument,
  type RichTextFieldOptions,
  type RichTextMark,
} from '@lumibase/contracts/richtext';
import { cn } from '@/lib/cn';
import { useMediaPicker } from '@/modules/files/media-picker';
import { RelationDrawer } from '@/modules/content/interfaces/relation-drawer';
import { blockCommands, filterCommands, resolveFeatures, type CommandHost, type EditorCommand } from './commands';
import { editorJsonToRichText, richTextToEditorJson, type PmNode } from './convert';
import { LbCustom, LbEmbed, LbFootnote, LbFootnoteRef, LbInlineEmbed, LbRef, LbTable } from './extensions';
import { clipboardToRichText } from './paste';
import { customBlocksFor, useRichTextPlugins } from './plugins';

/**
 * Block-based rich-text editor (#696) on TipTap / ProseMirror. Stores the
 * portable document (`@lumibase/contracts/richtext`), never HTML.
 *
 * - Toolbar, block commands and the `/` slash menu show only what the field's
 *   options allow (`headingLevels`, `marks`, `blocks`, `links`, `references`);
 *   the API enforces the same options on write.
 * - Paste is parsed into the model first (Word / Google Docs / web HTML and
 *   Markdown text), so unsafe markup never reaches the editor.
 * - Keyboard: standard shortcuts (Mod-B/I/U, Mod-Shift-7/8 lists, Mod-Alt-1…6
 *   headings, Mod-K link), Tab / Shift-Tab nest lists, arrow keys move inside
 *   the toolbar (one tab stop).
 */

export interface RichTextEditorProps {
  value: RichTextDocument | null | undefined;
  onChange: (next: RichTextDocument | null) => void;
  options?: RichTextFieldOptions;
  disabled?: boolean;
  /** Accessible name of the editing area (the field label). */
  label?: string;
  /** Content locale, for `lang` / `dir`. */
  locale?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
}

type Panel = null | 'link' | 'ref' | 'markdown-import' | 'markdown-export';

interface SlashState {
  from: number;
  to: number;
  query: string;
  index: number;
}

const MARK_BUTTONS: Array<{ mark: RichTextMark; label: string; icon: ReactNode; shortcut: string }> = [
  { mark: 'bold', label: 'Bold', icon: <Bold className="h-4 w-4" />, shortcut: 'Ctrl+B' },
  { mark: 'italic', label: 'Italic', icon: <Italic className="h-4 w-4" />, shortcut: 'Ctrl+I' },
  { mark: 'underline', label: 'Underline', icon: <UnderlineIcon className="h-4 w-4" />, shortcut: 'Ctrl+U' },
  { mark: 'strike', label: 'Strikethrough', icon: <Strikethrough className="h-4 w-4" />, shortcut: 'Ctrl+Shift+S' },
  { mark: 'code', label: 'Inline code', icon: <Code className="h-4 w-4" />, shortcut: 'Ctrl+E' },
  { mark: 'superscript', label: 'Superscript', icon: <SuperscriptIcon className="h-4 w-4" />, shortcut: 'Ctrl+.' },
  { mark: 'subscript', label: 'Subscript', icon: <SubscriptIcon className="h-4 w-4" />, shortcut: 'Ctrl+,' },
];

/** Build the TipTap extension list for a field's allowed features. */
export function buildExtensions(options: RichTextFieldOptions) {
  const f = resolveFeatures(options);
  const levels = f.headingLevels.length ? [...f.headingLevels] : undefined;
  return [
    StarterKit.configure({
      heading: levels ? { levels } : false,
      bold: f.marks.has('bold') ? {} : false,
      italic: f.marks.has('italic') ? {} : false,
      underline: f.marks.has('underline') ? {} : false,
      strike: f.marks.has('strike') ? {} : false,
      code: f.marks.has('code') ? {} : false,
      bulletList: f.blocks.has('list') ? {} : false,
      orderedList: f.blocks.has('list') ? {} : false,
      listItem: f.blocks.has('list') ? {} : false,
      listKeymap: f.blocks.has('list') ? {} : false,
      blockquote: f.blocks.has('quote') ? {} : false,
      codeBlock: f.blocks.has('code') ? {} : false,
      horizontalRule: f.blocks.has('rule') ? {} : false,
      link: f.links
        ? {
            openOnClick: false,
            autolink: true,
            defaultProtocol: 'https',
            // Same allowlist as the server (#700).
            isAllowedUri: (url: string) => safeHref(url) !== null,
          }
        : false,
    }),
    ...(f.marks.has('superscript') ? [Superscript] : []),
    ...(f.marks.has('subscript') ? [Subscript] : []),
    ...(f.blocks.has('table') ? [LbTable.configure({ resizable: false }), TableRow, TableHeader, TableCell] : []),
    LbEmbed,
    LbInlineEmbed,
    LbRef,
    LbFootnoteRef,
    LbFootnote,
    LbCustom,
    Placeholder.configure({ placeholder: options.placeholder ?? 'Write, or type / for blocks…' }),
  ];
}

/** The `/query` before the cursor in an otherwise empty-looking paragraph, if any. */
export function slashQueryAt(editor: Editor): SlashState | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if ($from.parent.type.name !== 'paragraph') return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const m = /^\/([\p{L}\p{N} _-]{0,30})$/u.exec(before);
  if (!m) return null;
  return { from: $from.start(), to: $from.pos, query: m[1] ?? '', index: 0 };
}

function nextFootnoteLabel(editor: Editor): string {
  const used = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'lbFootnoteRef' || node.type.name === 'lbFootnote') used.add(String(node.attrs.label));
  });
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

function ToolbarButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      // Roving tab stop: the toolbar is one Tab stop, arrows move inside it.
      tabIndex={-1}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 min-w-7 items-center justify-center rounded px-1 text-sm hover:bg-accent disabled:opacity-40',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Arrow-key navigation inside a `role="toolbar"` (WAI-ARIA toolbar pattern). */
function onToolbarKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
  const forward = (e.key === 'ArrowRight') !== rtl;
  let next = at;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = buttons.length - 1;
  else next = (at + (forward ? 1 : -1) + buttons.length) % buttons.length;
  e.preventDefault();
  buttons[next]?.focus();
}

function focusFirstToolbarButton(el: HTMLDivElement | null) {
  el?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
}

export default function RichTextEditor({ value, onChange, options = {}, disabled, label, locale, dir = 'auto' }: RichTextEditorProps) {
  const features = useMemo(() => resolveFeatures(options), [options]);
  // Extensions are fixed for the editor's lifetime; options rarely change while editing.
  const optionsKey = JSON.stringify(options);
  const extensions = useMemo(() => buildExtensions(options), [optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const plugins = useRichTextPlugins();
  const customBlocks = useMemo(() => customBlocksFor(plugins, options.customBlocks), [plugins, options.customBlocks]);
  const openPicker = useMediaPicker();

  const lastEmitted = useRef<string>(JSON.stringify(value ?? null));
  const slashRef = useRef<SlashState | null>(null);
  const commandsRef = useRef<EditorCommand[]>([]);
  const editorRef = useRef<Editor | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [linkDraft, setLinkDraft] = useState('');
  const [refDraft, setRefDraft] = useState({ collection: '', id: '' });
  const [markdownDraft, setMarkdownDraft] = useState('');
  const [panelError, setPanelError] = useState<string | null>(null);
  const [pickingItem, setPickingItem] = useState(false);
  const [blockDataDraft, setBlockDataDraft] = useState<{ key: string; text: string } | null>(null);
  const [blockDataError, setBlockDataError] = useState<string | null>(null);

  const emit = useCallback(
    (editor: Editor) => {
      const doc = editorJsonToRichText(editor.getJSON() as PmNode);
      const next = doc.content.length ? doc : null;
      const key = JSON.stringify(next);
      if (key === lastEmitted.current) return;
      lastEmitted.current = key;
      onChange(next);
    },
    [onChange],
  );

  const updateSlash = useCallback((editor: Editor) => {
    const s = slashQueryAt(editor);
    const prev = slashRef.current;
    const next = s && prev && prev.from === s.from ? { ...s, index: prev.query === s.query ? prev.index : 0 } : s;
    slashRef.current = next;
    setSlash(next);
  }, []);

  const runCommand = useCallback((cmd: EditorCommand) => {
    const editor = editorRef.current;
    const s = slashRef.current;
    if (!editor) return;
    if (s) editor.chain().focus().deleteRange({ from: s.from, to: s.to }).run();
    slashRef.current = null;
    setSlash(null);
    cmd.run(editor);
  }, []);

  const editor = useEditor(
    {
      extensions,
      content: richTextToEditorJson(value ?? null),
      editable: !disabled,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'true',
          ...(label ? { 'aria-label': label } : {}),
          ...(locale ? { lang: locale } : {}),
          dir,
          class: 'lb-richtext prose prose-sm max-w-none min-h-32 px-3 py-2 focus:outline-none',
        },
        handlePaste: (view, event) => {
          const data = event.clipboardData;
          if (!data) return false;
          const inCode = view.state.selection.$from.parent.type.spec.code === true;
          const doc = clipboardToRichText({ html: data.getData('text/html'), text: data.getData('text/plain'), inCode, plugins });
          if (!doc) return false;
          const json = richTextToEditorJson(doc);
          editorRef.current?.chain().focus().insertContent(json.content ?? []).run();
          return true;
        },
        handleKeyDown: (_view, event) => {
          const s = slashRef.current;
          if (s) {
            const list = filterCommands(commandsRef.current, s.query);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (list.length === 0) return false;
              const delta = event.key === 'ArrowDown' ? 1 : -1;
              const next = { ...s, index: (s.index + delta + list.length) % list.length };
              slashRef.current = next;
              setSlash(next);
              return true;
            }
            if (event.key === 'Enter' && list[s.index]) {
              runCommand(list[s.index]!);
              return true;
            }
            if (event.key === 'Escape') {
              slashRef.current = null;
              setSlash(null);
              return true;
            }
          }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && features.links) {
            event.preventDefault();
            openLinkPanel();
            return true;
          }
          if (event.altKey && event.key === 'F10') {
            // Alt+F10 moves focus to the toolbar (common rich-text editor convention).
            focusFirstToolbarButton(toolbarRef.current);
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: e }) => {
        emit(e);
        updateSlash(e);
      },
      onSelectionUpdate: ({ editor: e }) => updateSlash(e),
    },
    [extensions],
  );
  editorRef.current = editor;

  // An outside change (locale switch, raw JSON edit, reload) replaces the content.
  useEffect(() => {
    if (!editor) return;
    const key = JSON.stringify(value ?? null);
    if (key === lastEmitted.current) return;
    lastEmitted.current = key;
    editor.commands.setContent(richTextToEditorJson(value ?? null), { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      marks: Object.fromEntries(MARK_BUTTONS.map((b) => [b.mark, e?.isActive(b.mark) ?? false])) as Record<RichTextMark, boolean>,
      link: e?.isActive('link') ?? false,
      ref: e?.isActive('lbRef') ?? false,
      inTable: e?.isActive('table') ?? false,
      tableAttrs: (e?.getAttributes('table') ?? {}) as { caption?: string; headerColumn?: boolean },
      embedAttrs: e?.isActive('lbEmbed') || e?.isActive('lbInlineEmbed') ? ((e.isActive('lbEmbed') ? e.getAttributes('lbEmbed') : e.getAttributes('lbInlineEmbed')) as { alt?: string; kind?: string }) : null,
      custom: e?.isActive('lbCustom') ? (e.getAttributes('lbCustom') as { name?: string; data?: Record<string, unknown> }) : null,
      headingLevel: ([1, 2, 3, 4, 5, 6] as const).find((l) => e?.isActive('heading', { level: l })) ?? 0,
      canUndo: e?.can().undo() ?? false,
      canRedo: e?.can().redo() ?? false,
    }),
  });

  function openLinkPanel() {
    const e = editorRef.current;
    if (!e) return;
    setLinkDraft(String(e.getAttributes('link').href ?? ''));
    setPanelError(null);
    setPanel('link');
  }

  const host: CommandHost = {
    insertEmbed: openPicker
      ? async (inline) => {
          const picked = await openPicker({ multiple: false });
          const asset = picked?.[0];
          if (!asset || !editorRef.current) return;
          editorRef.current
            .chain()
            .focus()
            .insertContent({ type: inline ? 'lbInlineEmbed' : 'lbEmbed', attrs: { kind: 'file', id: asset.id, collection: null, alt: '' } })
            .run();
        }
      : undefined,
    insertItemRef: () => {
      setRefDraft({ collection: options.referenceCollections?.[0] ?? '', id: '' });
      setPanelError(null);
      setPanel('ref');
    },
    insertFootnote: () => {
      const e = editorRef.current;
      if (!e) return;
      const label = nextFootnoteLabel(e);
      e.chain()
        .focus()
        .insertContent({ type: 'lbFootnoteRef', attrs: { label } })
        .insertContentAt(e.state.doc.content.size, { type: 'lbFootnote', attrs: { label }, content: [{ type: 'paragraph' }] })
        .run();
    },
  };
  const commands = blockCommands(features, host, customBlocks);
  commandsRef.current = commands;
  const slashList = slash ? filterCommands(commands, slash.query) : [];

  if (!editor) return null;

  const applyLink = () => {
    const href = linkDraft.trim();
    if (href === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      setPanel(null);
      return;
    }
    const safe = safeHref(href);
    if (!safe) {
      setPanelError('Only http(s), mailto, tel and relative links are allowed.');
      return;
    }
    const chain = editor.chain().focus().extendMarkRange('link');
    if (editor.state.selection.empty && !editor.isActive('link')) chain.insertContent({ type: 'text', text: safe, marks: [{ type: 'link', attrs: { href: safe } }] }).run();
    else chain.setLink({ href: safe }).run();
    setPanel(null);
  };

  const applyRef = () => {
    const collection = refDraft.collection.trim();
    const id = refDraft.id.trim();
    if (!collection || !id) {
      setPanelError('Collection and item id are required.');
      return;
    }
    if (options.referenceCollections && !options.referenceCollections.includes(collection)) {
      setPanelError(`This field allows references to: ${options.referenceCollections.join(', ')}.`);
      return;
    }
    const attrs = { kind: 'item', collection, id };
    if (editor.state.selection.empty) {
      editor.chain().focus().insertContent({ type: 'text', text: `${collection}/${id}`, marks: [{ type: 'lbRef', attrs }] }).run();
    } else {
      editor.chain().focus().setMark('lbRef', attrs).run();
    }
    setPanel(null);
  };

  const applyMarkdownImport = () => {
    const doc = markdownToRichText(markdownDraft, { plugins });
    editor.chain().focus().insertContent(richTextToEditorJson(doc).content ?? []).run();
    setMarkdownDraft('');
    setPanel(null);
  };

  const blockMenu = commands.filter((c) => c.id === 'paragraph' || c.id.startsWith('heading-'));
  const currentBlock = state?.headingLevel ? `heading-${state.headingLevel}` : 'paragraph';

  return (
    <div className={cn('rounded-md border bg-background', disabled && 'opacity-70')} data-testid="richtext-editor">
      {!disabled && (
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={`${label ?? 'Rich text'} formatting`}
          aria-orientation="horizontal"
          tabIndex={0}
          onFocus={(e) => {
            if (e.target === e.currentTarget) focusFirstToolbarButton(e.currentTarget);
          }}
          onKeyDown={onToolbarKeyDown}
          className="flex flex-wrap items-center gap-0.5 border-b px-1 py-1"
        >
          {blockMenu.length > 1 && (
            <select
              aria-label="Block type"
              tabIndex={-1}
              className="h-7 rounded border bg-background px-1 text-xs"
              value={currentBlock}
              onChange={(e) => blockMenu.find((c) => c.id === e.target.value)?.run(editor)}
            >
              {blockMenu.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          {MARK_BUTTONS.filter((b) => features.marks.has(b.mark)).map((b) => (
            <ToolbarButton
              key={b.mark}
              label={`${b.label} (${b.shortcut})`}
              active={state?.marks[b.mark]}
              onClick={() => editor.chain().focus().toggleMark(b.mark).run()}
            >
              {b.icon}
            </ToolbarButton>
          ))}
          {features.links && (
            <ToolbarButton label="Link (Ctrl+K)" active={state?.link} onClick={openLinkPanel}>
              <LinkIcon className="h-4 w-4" />
            </ToolbarButton>
          )}
          {features.references && (
            <ToolbarButton label="Link to item" active={state?.ref} onClick={() => host.insertItemRef?.()}>
              <AtSign className="h-4 w-4" />
            </ToolbarButton>
          )}
          {features.blocks.has('list') && (
            <>
              <ToolbarButton label="Bulleted list (Ctrl+Shift+8)" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
                <List className="h-4 w-4" />
              </ToolbarButton>
              <ToolbarButton label="Numbered list (Ctrl+Shift+7)" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
                <ListOrdered className="h-4 w-4" />
              </ToolbarButton>
            </>
          )}
          {features.blocks.has('quote') && (
            <ToolbarButton label="Quote (Ctrl+Shift+B)" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
              <Quote className="h-4 w-4" />
            </ToolbarButton>
          )}
          {features.blocks.has('code') && (
            <ToolbarButton label="Code block (Ctrl+Alt+C)" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
              <SquareCode className="h-4 w-4" />
            </ToolbarButton>
          )}
          {features.blocks.has('rule') && (
            <ToolbarButton label="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
              <Minus className="h-4 w-4" />
            </ToolbarButton>
          )}
          {features.blocks.has('table') && (
            <ToolbarButton label="Insert table" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
              <TableIcon className="h-4 w-4" />
            </ToolbarButton>
          )}
          {features.blocks.has('embed') && features.references && host.insertEmbed && (
            <ToolbarButton label="Insert image or file" onClick={() => host.insertEmbed?.(false)}>
              <ImageIcon className="h-4 w-4" />
            </ToolbarButton>
          )}
          {features.blocks.has('footnote') && (
            <ToolbarButton label="Footnote" onClick={() => host.insertFootnote?.()}>
              <Asterisk className="h-4 w-4" />
            </ToolbarButton>
          )}
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <ToolbarButton label="Undo (Ctrl+Z)" disabled={!state?.canUndo} onClick={() => editor.chain().focus().undo().run()}>
            <Undo2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton label="Redo (Ctrl+Shift+Z)" disabled={!state?.canRedo} onClick={() => editor.chain().focus().redo().run()}>
            <Redo2 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            label="Import Markdown"
            onClick={() => {
              setMarkdownDraft('');
              setPanel('markdown-import');
            }}
          >
            <FileUp className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            label="Export Markdown"
            onClick={() => {
              setMarkdownDraft(richTextToMarkdown(editorJsonToRichText(editor.getJSON() as PmNode), { plugins }));
              setPanel('markdown-export');
            }}
          >
            <FileDown className="h-4 w-4" />
          </ToolbarButton>
        </div>
      )}

      {!disabled && state?.inTable && (
        <div role="toolbar" aria-label="Table" className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-1 py-1 text-xs" onKeyDown={onToolbarKeyDown}>
          <ToolbarButton label="Add row" onClick={() => editor.chain().focus().addRowAfter().run()}>
            <Rows3 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton label="Add column" onClick={() => editor.chain().focus().addColumnAfter().run()}>
            <Columns3 className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton label="Toggle header row" onClick={() => editor.chain().focus().toggleHeaderRow().run()}>
            <PanelTop className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton
            label="Toggle header column"
            active={!!state.tableAttrs.headerColumn}
            onClick={() =>
              editor
                .chain()
                .focus()
                .toggleHeaderColumn()
                .updateAttributes('table', { headerColumn: !state.tableAttrs.headerColumn })
                .run()
            }
          >
            <PanelLeft className="h-4 w-4" />
          </ToolbarButton>
          <ToolbarButton label="Delete row" onClick={() => editor.chain().focus().deleteRow().run()}>
            <Rows3 className="h-4 w-4 text-destructive" />
          </ToolbarButton>
          <ToolbarButton label="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()}>
            <Columns3 className="h-4 w-4 text-destructive" />
          </ToolbarButton>
          <ToolbarButton label="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
            <Trash2 className="h-4 w-4" />
          </ToolbarButton>
          <label className="ms-2 flex items-center gap-1">
            <span>Caption</span>
            <input
              className="h-6 rounded border bg-background px-1"
              value={state.tableAttrs.caption ?? ''}
              placeholder="Describe the table"
              onChange={(e) => editor.chain().updateAttributes('table', { caption: e.target.value }).run()}
            />
          </label>
        </div>
      )}

      {!disabled && state?.embedAttrs && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-2 py-1 text-xs">
          <label className="flex flex-1 items-center gap-1">
            <span>Alt text</span>
            <input
              className="h-6 flex-1 rounded border bg-background px-1"
              value={state.embedAttrs.alt ?? ''}
              placeholder="Describe the image for screen readers"
              onChange={(e) => {
                const name = editor.isActive('lbEmbed') ? 'lbEmbed' : 'lbInlineEmbed';
                editor.chain().updateAttributes(name, { alt: e.target.value }).run();
              }}
            />
          </label>
        </div>
      )}

      {!disabled && state?.custom && (
        <CustomBlockPanel
          key={`${state.custom.name ?? ''}:${JSON.stringify(state.custom.data ?? {})}`}
          name={String(state.custom.name ?? '')}
          data={state.custom.data ?? {}}
          draft={blockDataDraft}
          error={blockDataError}
          onDraft={(text) => setBlockDataDraft({ key: String(state.custom?.name ?? ''), text })}
          onApply={(text) => {
            try {
              const data: unknown = JSON.parse(text);
              if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
              editor.chain().focus().updateAttributes('lbCustom', { data }).run();
              setBlockDataDraft(null);
              setBlockDataError(null);
            } catch {
              setBlockDataError('Block data must be a JSON object.');
            }
          }}
        />
      )}

      {panel === 'link' && (
        <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1 text-xs">
          <label className="flex flex-1 items-center gap-1">
            <span>URL</span>
            <input
              autoFocus
              className="h-7 flex-1 rounded border bg-background px-1"
              value={linkDraft}
              placeholder="https://"
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyLink();
                }
                if (e.key === 'Escape') setPanel(null);
              }}
            />
          </label>
          <button type="button" className="rounded border px-2 py-0.5" onClick={applyLink}>
            Apply
          </button>
          <button type="button" className="rounded px-2 py-0.5" onClick={() => setPanel(null)}>
            Cancel
          </button>
          {panelError && <p role="alert" className="w-full text-destructive">{panelError}</p>}
        </div>
      )}

      {panel === 'ref' && (
        <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1 text-xs">
          <label className="flex items-center gap-1">
            <span>Collection</span>
            <input autoFocus className="h-7 w-32 rounded border bg-background px-1" value={refDraft.collection} onChange={(e) => setRefDraft((d) => ({ ...d, collection: e.target.value }))} />
          </label>
          <label className="flex items-center gap-1">
            <span>Item id</span>
            <input className="h-7 w-40 rounded border bg-background px-1" value={refDraft.id} onChange={(e) => setRefDraft((d) => ({ ...d, id: e.target.value }))} />
          </label>
          <button type="button" className="rounded border px-2 py-0.5" disabled={!refDraft.collection.trim()} onClick={() => setPickingItem(true)}>
            Browse…
          </button>
          {pickingItem && refDraft.collection.trim() && (
            <RelationDrawer
              collection={refDraft.collection.trim()}
              multiple={false}
              onClose={() => setPickingItem(false)}
              onSelect={(ids) => {
                if (ids[0]) setRefDraft((d) => ({ ...d, id: ids[0]! }));
                setPickingItem(false);
              }}
            />
          )}
          <button type="button" className="rounded border px-2 py-0.5" onClick={applyRef}>
            Insert
          </button>
          <button type="button" className="rounded px-2 py-0.5" onClick={() => setPanel(null)}>
            Cancel
          </button>
          {panelError && <p role="alert" className="w-full text-destructive">{panelError}</p>}
        </div>
      )}

      {(panel === 'markdown-import' || panel === 'markdown-export') && (
        <div className="space-y-1 border-b px-2 py-2 text-xs">
          <label className="block">
            <span className="mb-1 block">{panel === 'markdown-import' ? 'Paste Markdown to insert at the cursor' : 'Markdown (GFM)'}</span>
            <textarea
              autoFocus
              readOnly={panel === 'markdown-export'}
              className="h-40 w-full rounded border bg-background p-2 font-mono"
              value={markdownDraft}
              onChange={(e) => setMarkdownDraft(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            {panel === 'markdown-import' && (
              <button type="button" className="rounded border px-2 py-0.5" onClick={applyMarkdownImport}>
                Insert
              </button>
            )}
            <button type="button" className="rounded px-2 py-0.5" onClick={() => setPanel(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      <div className="relative">
        <EditorContent editor={editor} />
        {slash && slashList.length > 0 && (
          <SlashMenu editor={editor} slash={slash} items={slashList} onPick={runCommand} />
        )}
      </div>
    </div>
  );
}

function CustomBlockPanel({
  name,
  data,
  draft,
  error,
  onDraft,
  onApply,
}: {
  name: string;
  data: Record<string, unknown>;
  draft: { key: string; text: string } | null;
  error: string | null;
  onDraft: (text: string) => void;
  onApply: (text: string) => void;
}) {
  const text = draft && draft.key === name ? draft.text : JSON.stringify(data, null, 2);
  return (
    <div className="space-y-1 border-b bg-muted/40 px-2 py-1 text-xs">
      <label className="block">
        <span className="mb-1 block">Block data: {name} (JSON)</span>
        <textarea className="h-24 w-full rounded border bg-background p-1 font-mono" value={text} onChange={(e) => onDraft(e.target.value)} />
      </label>
      <button type="button" className="rounded border px-2 py-0.5" onClick={() => onApply(text)}>
        Apply
      </button>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}

function SlashMenu({ editor, slash, items, onPick }: { editor: Editor; slash: SlashState; items: EditorCommand[]; onPick: (c: EditorCommand) => void }) {
  // Place the menu under the caret, measured from the inline-start edge so it
  // mirrors in RTL.
  let top = 0;
  let inset = 0;
  try {
    const coords = editor.view.coordsAtPos(slash.to);
    const box = (editor.view.dom.parentElement ?? editor.view.dom).getBoundingClientRect();
    const rtl = getComputedStyle(editor.view.dom).direction === 'rtl';
    top = coords.bottom - box.top + 4;
    inset = rtl ? box.right - coords.right : coords.left - box.left;
  } catch {
    /* jsdom / detached view: keep the menu at the top */
  }
  const active = items[Math.min(slash.index, items.length - 1)];
  return (
    <ul
      role="listbox"
      aria-label="Insert block"
      id="lb-richtext-slash"
      className="absolute z-20 max-h-64 w-56 overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
      style={{ top, insetInlineStart: Math.max(0, inset) }}
    >
      {items.map((c) => (
        <li
          key={c.id}
          role="option"
          aria-selected={c === active}
          className={cn('flex cursor-pointer items-center justify-between rounded px-2 py-1', c === active && 'bg-accent')}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
        >
          <span>{c.label}</span>
          {c.id.startsWith('custom:') && <Braces className="h-3 w-3 text-muted-foreground" aria-hidden="true" />}
        </li>
      ))}
    </ul>
  );
}
