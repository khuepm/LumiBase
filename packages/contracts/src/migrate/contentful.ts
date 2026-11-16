/**
 * Contentful adapter (#728): parses the JSON written by
 * `contentful space export` into the source-neutral {@link SourceExport}.
 *
 * Covers every field type of the Contentful content model: Symbol, Text,
 * RichText, Integer, Number, Date, Boolean, Location, Object, Link
 * (Entry/Asset) and Array (Symbol/Link). Rich text becomes a LumiBase
 * {@link RichTextDocument}; entry/asset links become `{ $link, id }`.
 */
import { emptyRichTextDocument, type RichTextBlock, type RichTextDocument, type RichTextInline, type RichTextMark } from '../richtext/index';
import type {
  SourceAsset,
  SourceContentType,
  SourceEntry,
  SourceExport,
  SourceField,
  SourceFieldKind,
  SourceLocale,
} from './types';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const sys = (v: unknown): Json => (isObj(v) && isObj(v.sys) ? v.sys : {});

export class ContentfulExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentfulExportError';
  }
}

function linkContentTypes(validations: unknown): string[] {
  for (const v of arr(validations)) {
    if (isObj(v) && Array.isArray(v.linkContentType)) return v.linkContentType.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

function choices(validations: unknown): string[] | undefined {
  for (const v of arr(validations)) {
    if (isObj(v) && Array.isArray(v.in)) return v.in.map((x) => String(x));
  }
  return undefined;
}

function mapField(raw: Json, ctName: string, warnings: string[]): SourceField | null {
  const id = str(raw.id);
  if (!id) return null;
  if (raw.deleted === true) return null;
  const type = str(raw.type) ?? 'Object';
  const base = {
    id,
    name: str(raw.name) ?? id,
    localized: raw.localized === true,
    required: raw.required === true,
    sourceType: type,
  };
  let kind: SourceFieldKind;
  const extra: Partial<SourceField> = {};
  switch (type) {
    case 'Symbol':
      kind = 'shortText';
      extra.choices = choices(raw.validations);
      break;
    case 'Text':
      kind = 'longText';
      break;
    case 'RichText':
      kind = 'richText';
      break;
    case 'Integer':
      kind = 'integer';
      break;
    case 'Number':
      kind = 'number';
      break;
    case 'Boolean':
      kind = 'boolean';
      break;
    case 'Date':
      kind = 'date';
      break;
    case 'Location':
      kind = 'location';
      break;
    case 'Object':
      kind = 'object';
      break;
    case 'Link':
      if (raw.linkType === 'Asset') kind = 'assetLink';
      else {
        kind = 'entryLink';
        extra.linkContentTypes = linkContentTypes(raw.validations);
      }
      break;
    case 'Array': {
      const items = isObj(raw.items) ? raw.items : {};
      if (items.type === 'Symbol') kind = 'shortTextList';
      else if (items.type === 'Link' && items.linkType === 'Asset') kind = 'assetLinks';
      else if (items.type === 'Link') {
        kind = 'entryLinks';
        extra.linkContentTypes = linkContentTypes(items.validations);
      } else {
        kind = 'object';
        warnings.push(`${ctName}.${id}: Array of ${String(items.type)} is stored as JSON.`);
      }
      break;
    }
    default:
      kind = 'object';
      warnings.push(`${ctName}.${id}: field type ${type} is not modelled and is stored as JSON.`);
  }
  return { ...base, kind, ...extra };
}

function status(entity: unknown): 'draft' | 'published' | 'archived' {
  const s = sys(entity);
  if (typeof s.archivedVersion === 'number') return 'archived';
  if (typeof s.publishedVersion === 'number') return 'published';
  return 'draft';
}

const MARKS: Record<string, RichTextMark> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  code: 'code',
  superscript: 'superscript',
  subscript: 'subscript',
  strikethrough: 'strike',
};

interface RichCtx {
  entryTypes: Map<string, string>;
  warnings: string[];
  where: string;
}

function targetId(node: Json): string | undefined {
  return str(sys(isObj(node.data) ? node.data.target : undefined).id);
}

function inlines(nodes: unknown[], ctx: RichCtx): RichTextInline[] {
  const out: RichTextInline[] = [];
  for (const n of nodes) {
    if (!isObj(n)) continue;
    switch (n.nodeType) {
      case 'text': {
        const text = str(n.value) ?? '';
        if (!text) break;
        const marks = arr(n.marks)
          .map((m) => (isObj(m) ? MARKS[str(m.type) ?? ''] : undefined))
          .filter((m): m is RichTextMark => m !== undefined);
        // Contentful encodes soft line breaks as "\n" inside a text node.
        const parts = text.split('\n');
        parts.forEach((part, i) => {
          if (i > 0) out.push({ type: 'break' });
          if (part) out.push(marks.length ? { type: 'text', text: part, marks } : { type: 'text', text: part });
        });
        break;
      }
      case 'hyperlink': {
        const uri = isObj(n.data) ? str(n.data.uri) : undefined;
        out.push({ type: 'link', href: uri ?? '', content: inlines(arr(n.content), ctx) });
        break;
      }
      case 'entry-hyperlink': {
        const id = targetId(n);
        const ct = id ? ctx.entryTypes.get(id) : undefined;
        if (id && ct) out.push({ type: 'ref', ref: { kind: 'item', collection: ct, id }, content: inlines(arr(n.content), ctx) });
        else {
          ctx.warnings.push(`${ctx.where}: link to missing entry ${id ?? '?'} kept as text.`);
          out.push(...inlines(arr(n.content), ctx));
        }
        break;
      }
      case 'asset-hyperlink': {
        const id = targetId(n);
        if (id) out.push({ type: 'ref', ref: { kind: 'file', id }, content: inlines(arr(n.content), ctx) });
        else out.push(...inlines(arr(n.content), ctx));
        break;
      }
      case 'embedded-entry-inline': {
        const id = targetId(n);
        const ct = id ? ctx.entryTypes.get(id) : undefined;
        if (id && ct) out.push({ type: 'embed', ref: { kind: 'item', collection: ct, id } });
        else ctx.warnings.push(`${ctx.where}: inline embed of missing entry ${id ?? '?'} dropped.`);
        break;
      }
      default:
        // Unknown inline: keep its text.
        out.push(...inlines(arr(n.content), ctx));
    }
  }
  return out;
}

function blocks(nodes: unknown[], ctx: RichCtx): RichTextBlock[] {
  const out: RichTextBlock[] = [];
  for (const n of nodes) {
    if (!isObj(n)) continue;
    const type = str(n.nodeType) ?? '';
    const content = arr(n.content);
    const heading = /^heading-([1-6])$/.exec(type);
    if (heading) {
      out.push({ type: 'heading', level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6, content: inlines(content, ctx) });
      continue;
    }
    switch (type) {
      case 'paragraph':
        out.push({ type: 'paragraph', content: inlines(content, ctx) });
        break;
      case 'blockquote':
        out.push({ type: 'quote', content: blocks(content, ctx) });
        break;
      case 'unordered-list':
      case 'ordered-list':
        out.push({
          type: 'list',
          ordered: type === 'ordered-list',
          items: content.filter(isObj).map((li) => blocks(arr(li.content), ctx)),
        });
        break;
      case 'hr':
        out.push({ type: 'rule' });
        break;
      case 'table':
        out.push({
          type: 'table',
          rows: content.filter(isObj).map((row) => {
            const cells = arr(row.content).filter(isObj);
            return {
              ...(cells.length > 0 && cells.every((c) => c.nodeType === 'table-header-cell') ? { header: true } : {}),
              cells: cells.map((c) => blocks(arr(c.content), ctx)),
            };
          }),
        });
        break;
      case 'embedded-entry-block': {
        const id = targetId(n);
        const ct = id ? ctx.entryTypes.get(id) : undefined;
        if (id && ct) out.push({ type: 'embed', ref: { kind: 'item', collection: ct, id } });
        else ctx.warnings.push(`${ctx.where}: embedded missing entry ${id ?? '?'} dropped.`);
        break;
      }
      case 'embedded-asset-block': {
        const id = targetId(n);
        if (id) out.push({ type: 'embed', ref: { kind: 'file', id } });
        break;
      }
      case 'text':
        out.push({ type: 'paragraph', content: inlines([n], ctx) });
        break;
      default:
        out.push({ type: 'custom', name: `contentful:${type || 'unknown'}`, data: { node: n } });
        ctx.warnings.push(`${ctx.where}: rich-text node ${type || 'unknown'} kept as a custom block.`);
    }
  }
  return out;
}

/** Convert a Contentful rich-text document node to a LumiBase document. */
export function contentfulRichTextToDocument(
  node: unknown,
  entryTypes: Map<string, string>,
  warnings: string[] = [],
  where = 'rich text',
): RichTextDocument {
  if (!isObj(node) || node.nodeType !== 'document') return emptyRichTextDocument();
  return { ...emptyRichTextDocument(), content: blocks(arr(node.content), { entryTypes, warnings, where }) };
}

function normaliseValue(field: SourceField, value: unknown, entryTypes: Map<string, string>, warnings: string[], where: string): unknown {
  if (value === null || value === undefined) return null;
  const link = (v: unknown) => {
    const s = sys(v);
    const id = str(s.id);
    if (!id || s.type !== 'Link') return null;
    return { $link: s.linkType === 'Asset' ? 'asset' : 'entry', id };
  };
  switch (field.kind) {
    case 'richText':
      return contentfulRichTextToDocument(value, entryTypes, warnings, where);
    case 'entryLink':
    case 'assetLink':
      return link(value);
    case 'entryLinks':
    case 'assetLinks':
      return arr(value).map(link).filter((l) => l !== null);
    case 'location':
      return isObj(value) && typeof value.lat === 'number' && typeof value.lon === 'number' ? { lat: value.lat, lon: value.lon } : null;
    default:
      return value;
  }
}

/**
 * Parse a `contentful space export` JSON document. Throws
 * {@link ContentfulExportError} when the file is not a space export.
 */
export function parseContentfulExport(input: unknown): SourceExport {
  if (!isObj(input) || !Array.isArray(input.contentTypes)) {
    throw new ContentfulExportError('Not a Contentful space export: expected a `contentTypes` array (run `contentful space export`).');
  }
  const warnings: string[] = [];
  const locales: SourceLocale[] = arr(input.locales)
    .filter(isObj)
    .map((l) => ({ code: str(l.code) ?? '', name: str(l.name), default: l.default === true }))
    .filter((l) => l.code);
  if (!locales.length) {
    locales.push({ code: 'en-US', default: true });
    warnings.push('The export has no locales; assuming en-US.');
  }
  if (!locales.some((l) => l.default)) locales[0]!.default = true;

  const contentTypes: SourceContentType[] = input.contentTypes.filter(isObj).map((ct) => {
    const id = str(sys(ct).id) ?? '';
    return {
      id,
      name: str(ct.name) ?? id,
      description: str(ct.description),
      displayField: str(ct.displayField),
      fields: arr(ct.fields)
        .filter(isObj)
        .map((f) => mapField(f, id, warnings))
        .filter((f): f is SourceField => f !== null),
    };
  });
  const byId = new Map(contentTypes.map((ct) => [ct.id, ct]));

  const rawEntries = arr(input.entries).filter(isObj);
  const entryTypes = new Map<string, string>();
  for (const e of rawEntries) {
    const id = str(sys(e).id);
    const ct = str(sys(sys(e).contentType).id);
    if (id && ct) entryTypes.set(id, ct);
  }

  const entries: SourceEntry[] = [];
  for (const e of rawEntries) {
    const id = str(sys(e).id);
    const ctId = str(sys(sys(e).contentType).id);
    const ct = ctId ? byId.get(ctId) : undefined;
    if (!id || !ct) {
      warnings.push(`Entry ${id ?? '?'} has an unknown content type ${ctId ?? '?'} and is skipped.`);
      continue;
    }
    const fields: Record<string, Record<string, unknown>> = {};
    const rawFields = isObj(e.fields) ? e.fields : {};
    for (const field of ct.fields) {
      const perLocale = rawFields[field.id];
      if (!isObj(perLocale)) continue;
      fields[field.id] = Object.fromEntries(
        Object.entries(perLocale).map(([locale, v]) => [locale, normaliseValue(field, v, entryTypes, warnings, `${ct.id}/${id}.${field.id}`)]),
      );
    }
    entries.push({ id, contentType: ct.id, status: status(e), fields });
  }

  const assets: SourceAsset[] = arr(input.assets)
    .filter(isObj)
    .map((a) => {
      const fields = isObj(a.fields) ? a.fields : {};
      const perLocale = (v: unknown) => (isObj(v) ? v : {});
      const file: SourceAsset['file'] = {};
      for (const [locale, f] of Object.entries(perLocale(fields.file))) {
        if (!isObj(f) || typeof f.url !== 'string') continue;
        const details = isObj(f.details) ? f.details : {};
        const image = isObj(details.image) ? details.image : {};
        file[locale] = {
          url: f.url.startsWith('//') ? `https:${f.url}` : f.url,
          fileName: str(f.fileName) ?? 'file',
          contentType: str(f.contentType) ?? 'application/octet-stream',
          ...(typeof details.size === 'number' ? { size: details.size } : {}),
          ...(typeof image.width === 'number' ? { width: image.width } : {}),
          ...(typeof image.height === 'number' ? { height: image.height } : {}),
        };
      }
      const texts = (v: unknown) =>
        Object.fromEntries(Object.entries(perLocale(v)).filter(([, t]) => typeof t === 'string')) as Record<string, string>;
      return { id: str(sys(a).id) ?? '', status: status(a), title: texts(fields.title), description: texts(fields.description), file };
    })
    .filter((a) => a.id);

  const spaceId = str(sys(isObj(input.space) ? input.space : undefined).id) ?? str(input.spaceId);
  return { source: 'contentful', ...(spaceId ? { sourceId: spaceId } : {}), locales, contentTypes, entries, assets, warnings };
}
