/**
 * Turn a source entry into a LumiBase item payload following a
 * {@link MigrationPlan} (#728). Pure: link targets and uploaded asset keys
 * are passed in, so the same code runs in the CLI and in tests.
 */
import type { RichTextBlock, RichTextDocument, RichTextInline } from '../richtext/index';
import { isRichTextDocument } from '../richtext/index';
import type { MigrationPlan, PlannedCollection, PlannedField } from './plan';
import type { SourceEntry, SourceExport, SourceLink } from './types';

export interface TransformContext {
  plan: MigrationPlan;
  /** Source entry id → source content type id (for links and rich-text refs). */
  entryTypes: Map<string, string>;
  /** Source asset id → LumiBase file storage key, for assets already uploaded. */
  assetKeys: Map<string, string>;
}

export interface ItemPayload {
  id: string;
  status: 'draft' | 'published' | 'archived';
  data: Record<string, unknown>;
}

export interface TransformResult {
  collection: string;
  item: ItemPayload;
  warnings: string[];
}

export function transformContext(source: SourceExport, plan: MigrationPlan, assetKeys = new Map<string, string>()): TransformContext {
  return { plan, entryTypes: new Map(source.entries.map((e) => [e.id, e.contentType])), assetKeys };
}

const isLink = (v: unknown): v is SourceLink =>
  typeof v === 'object' && v !== null && ((v as SourceLink).$link === 'entry' || (v as SourceLink).$link === 'asset');

function collectionOf(ctx: TransformContext, contentType: string | undefined): string | undefined {
  return contentType ? ctx.plan.collections.find((c) => c.source === contentType)?.name : undefined;
}

/** Rewrite rich-text refs: content type id → collection, asset id → storage key; drop unresolved refs. */
function rewriteDoc(doc: RichTextDocument, ctx: TransformContext, warn: (m: string) => void): RichTextDocument {
  const inline = (nodes: RichTextInline[]): RichTextInline[] =>
    nodes.flatMap((n): RichTextInline[] => {
      if (n.type === 'link') return [{ ...n, content: inline(n.content) }];
      if (n.type === 'ref' || n.type === 'embed') {
        const ref =
          n.ref.kind === 'file'
            ? ctx.assetKeys.has(n.ref.id)
              ? { kind: 'file' as const, id: ctx.assetKeys.get(n.ref.id)! }
              : null
            : collectionOf(ctx, n.ref.collection)
              ? { kind: 'item' as const, collection: collectionOf(ctx, n.ref.collection)!, id: n.ref.id }
              : null;
        if (!ref) {
          warn(`rich-text ${n.ref.kind} ${n.ref.id} is not migrated; reference removed.`);
          return n.type === 'ref' ? inline(n.content) : [];
        }
        return n.type === 'ref' ? [{ type: 'ref', ref, content: inline(n.content) }] : [{ type: 'embed', ref }];
      }
      return [n];
    });
  const blocks = (list: RichTextBlock[]): RichTextBlock[] =>
    list.flatMap((b): RichTextBlock[] => {
      switch (b.type) {
        case 'paragraph':
        case 'heading':
          return [{ ...b, content: inline(b.content) }];
        case 'quote':
          return [{ ...b, content: blocks(b.content) }];
        case 'list':
          return [{ ...b, items: b.items.map(blocks) }];
        case 'table':
          return [{ ...b, rows: b.rows.map((r) => ({ ...r, cells: r.cells.map(blocks) })) }];
        case 'embed': {
          const [n] = inline([{ type: 'embed', ref: b.ref }]);
          return n && n.type === 'embed' ? [{ type: 'embed', ref: n.ref }] : [];
        }
        default:
          return [b];
      }
    });
  return { ...doc, content: blocks(doc.content) };
}

function convert(field: PlannedField, value: unknown, ctx: TransformContext, warn: (m: string) => void): unknown {
  if (value === null || value === undefined) return null;
  switch (field.storage) {
    case 'link':
      return isLink(value) && value.$link === 'entry' && ctx.entryTypes.has(value.id) ? value.id : null;
    case 'polyLink': {
      if (!isLink(value)) return null;
      const collection = collectionOf(ctx, ctx.entryTypes.get(value.id));
      return collection ? { collection, id: value.id } : null;
    }
    case 'links':
      return Array.isArray(value) ? value.filter((v) => isLink(v) && ctx.entryTypes.has(v.id)).map((v) => (v as SourceLink).id) : [];
    case 'polyLinks':
      return Array.isArray(value)
        ? value
            .filter(isLink)
            .map((v) => ({ collection: collectionOf(ctx, ctx.entryTypes.get(v.id)), id: v.id }))
            .filter((v) => v.collection)
        : [];
    case 'file': {
      if (!isLink(value)) return null;
      const key = ctx.assetKeys.get(value.id);
      if (!key) warn(`asset ${value.id} was not uploaded; ${field.name} left empty.`);
      return key ?? null;
    }
    case 'files':
      return Array.isArray(value)
        ? value.filter(isLink).map((v) => ctx.assetKeys.get(v.id)).filter((k): k is string => typeof k === 'string')
        : [];
    case 'geo': {
      const v = value as { lat?: number; lon?: number };
      return typeof v.lat === 'number' && typeof v.lon === 'number' ? { type: 'Point', coordinates: [v.lon, v.lat] } : null;
    }
    default:
      return isRichTextDocument(value) ? rewriteDoc(value, ctx, warn) : value;
  }
}

/**
 * Transform one entry. Non-localized fields read the default source locale;
 * localized ones become a `{ targetLocale: value }` map (empty locales
 * dropped). Unresolvable links become `null` and a warning.
 */
export function transformEntry(entry: SourceEntry, ctx: TransformContext): TransformResult | null {
  const collection: PlannedCollection | undefined = ctx.plan.collections.find((c) => c.source === entry.contentType);
  if (!collection) return null;
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(`${entry.contentType}/${entry.id}: ${m}`);
  const data: Record<string, unknown> = {};
  const { source: defSource } = ctx.plan.defaultLocale;
  for (const field of collection.fields) {
    const perLocale = entry.fields[field.source];
    if (!perLocale) continue;
    if (field.storage === 'translatable' || field.storage === 'localeMap') {
      const map: Record<string, unknown> = {};
      for (const { source, target } of ctx.plan.locales) {
        const v = convert({ ...field, storage: field.itemStorage ?? 'value' }, perLocale[source], ctx, warn);
        if (v !== null && v !== undefined && v !== '') map[target] = v;
      }
      data[field.name] = Object.keys(map).length ? map : null;
    } else {
      data[field.name] = convert(field, perLocale[defSource], ctx, warn);
    }
  }
  return { collection: collection.name, item: { id: entry.id, status: entry.status, data }, warnings };
}
