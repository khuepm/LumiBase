import { Mark, Node, mergeAttributes } from '@tiptap/core';
import { Table } from '@tiptap/extension-table';

/**
 * Editor nodes for the parts of the portable model StarterKit does not cover
 * (#696 / #697 / #699). Their rendered HTML uses the same `data-ref-*` /
 * `data-block` attributes as `richTextToHtml`, so copy → paste inside the
 * editor goes through `htmlToRichText` without losing references.
 */

const refAttributes = {
  kind: { default: 'file' },
  collection: { default: null },
  id: { default: '' },
};

function readRefAttrs(el: HTMLElement) {
  const kind = el.getAttribute('data-ref-kind');
  const id = el.getAttribute('data-ref-id');
  if ((kind !== 'file' && kind !== 'item') || !id) return false;
  return { kind, id, collection: el.getAttribute('data-ref-collection'), alt: el.getAttribute('data-ref-alt') ?? el.querySelector('img')?.getAttribute('alt') ?? '' };
}

function refHtmlAttrs(attrs: Record<string, unknown>): Record<string, string> {
  return {
    'data-ref-kind': String(attrs.kind ?? ''),
    ...(attrs.collection ? { 'data-ref-collection': String(attrs.collection) } : {}),
    'data-ref-id': String(attrs.id ?? ''),
    ...(attrs.alt ? { 'data-ref-alt': String(attrs.alt) } : {}),
  };
}

function refLabel(attrs: Record<string, unknown>): string {
  const target = attrs.kind === 'item' ? `${String(attrs.collection)}/${String(attrs.id)}` : String(attrs.id);
  return `${attrs.kind === 'item' ? 'Item' : 'File'}: ${target}${attrs.alt ? ` — ${String(attrs.alt)}` : ''}`;
}

/** Block embed of a file or item (`{ type: 'embed' }`). */
export const LbEmbed = Node.create({
  name: 'lbEmbed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { ...refAttributes, alt: { default: '' } };
  },
  parseHTML() {
    return [
      { tag: 'figure[data-ref-kind]', getAttrs: (el) => readRefAttrs(el as HTMLElement) },
      { tag: 'div[data-ref-kind]', getAttrs: (el) => readRefAttrs(el as HTMLElement) },
    ];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(refHtmlAttrs(node.attrs), { class: 'lb-rt-embed', contenteditable: 'false' }),
      refLabel({ ...node.attrs, ...HTMLAttributes }),
    ];
  },
});

/** Inline embed (`{ type: 'embed' }` inside a paragraph). */
export const LbInlineEmbed = Node.create({
  name: 'lbInlineEmbed',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { ...refAttributes, alt: { default: '' } };
  },
  parseHTML() {
    return [
      { tag: 'span[data-ref-kind]', getAttrs: (el) => readRefAttrs(el as HTMLElement) },
      { tag: 'img[data-ref-kind]', getAttrs: (el) => readRefAttrs(el as HTMLElement) },
    ];
  },
  renderHTML({ node }) {
    return ['span', mergeAttributes(refHtmlAttrs(node.attrs), { class: 'lb-rt-inline-embed' }), refLabel(node.attrs)];
  },
});

/** A link whose target is an item or file (`{ type: 'ref' }`). */
export const LbRef = Mark.create({
  name: 'lbRef',
  priority: 1100,
  inclusive: false,
  excludes: 'link',
  addAttributes() {
    return refAttributes;
  },
  parseHTML() {
    return [{ tag: 'a[data-ref-kind]', getAttrs: (el) => readRefAttrs(el as HTMLElement) }];
  },
  renderHTML({ mark }) {
    return ['a', mergeAttributes(refHtmlAttrs(mark.attrs), { class: 'lb-rt-ref', title: refLabel(mark.attrs) }), 0];
  },
});

/** Footnote reference (`{ type: 'footnote', label }` inline). */
export const LbFootnoteRef = Node.create({
  name: 'lbFootnoteRef',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { label: { default: '1' } };
  },
  parseHTML() {
    return [
      {
        tag: 'sup',
        priority: 60,
        getAttrs: (el) => {
          const a = (el as HTMLElement).querySelector('a.footnote-ref');
          const label = /^#fn-(.+)$/.exec(a?.getAttribute('href') ?? '')?.[1] ?? (el as HTMLElement).getAttribute('data-footnote');
          return label ? { label } : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    return ['sup', { class: 'lb-rt-footnote-ref', 'data-footnote': String(node.attrs.label) }, `[${String(node.attrs.label)}]`];
  },
});

/** Footnote definition (`{ type: 'footnote', label, content }` block). */
export const LbFootnote = Node.create({
  name: 'lbFootnote',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { label: { default: '1' } };
  },
  parseHTML() {
    return [{ tag: 'aside[data-footnote]', getAttrs: (el) => ({ label: (el as HTMLElement).getAttribute('data-footnote') ?? '1' }) }];
  },
  renderHTML({ node }) {
    return ['aside', { class: 'lb-rt-footnote', 'data-footnote': String(node.attrs.label), 'aria-label': `Footnote ${String(node.attrs.label)}` }, 0];
  },
});

/** Custom block (`{ type: 'custom', name, data }`) — block templates and plugin blocks (#697 / #698). */
export const LbCustom = Node.create({
  name: 'lbCustom',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { name: { default: '' }, data: { default: {} } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-block]',
        getAttrs: (el) => {
          const raw = (el as HTMLElement).getAttribute('data-lb-data');
          let data: unknown = {};
          try {
            data = raw ? JSON.parse(raw) : {};
          } catch {
            data = {};
          }
          return { name: (el as HTMLElement).getAttribute('data-block') ?? '', data };
        },
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'div',
      { class: 'lb-rt-custom', 'data-block': String(node.attrs.name), 'data-lb-data': JSON.stringify(node.attrs.data ?? {}), contenteditable: 'false' },
      `Block: ${String(node.attrs.name)}`,
    ];
  },
});

/** Table with the semantic attributes of the model (#699): caption, header column, alignment. */
export const LbTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      caption: { default: '', parseHTML: (el) => el.querySelector('caption')?.textContent?.trim() ?? '' },
      headerColumn: { default: false },
      align: { default: null },
    };
  },
});
