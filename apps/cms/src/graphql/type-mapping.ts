import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLOutputType,
} from 'graphql';
import { isZonedDateTimeField, isZonedDateTimeValue } from '@lumibase/contracts/field';
import { JSONScalar, DateTimeScalar } from './scalars';
import { isGeoPoint } from '@lumibase/contracts/field';
import type { CompiledField } from '../services/schema-service';
import {
  isRichTextDocument,
  richTextToHtml,
  richTextToMarkdown,
  richTextToPlainText,
  type RichTextDocument,
  type RichTextPlugin,
  type RichTextRef,
} from '@lumibase/contracts/richtext';
import type { GraphQLSchema } from 'graphql';
import { renderTemplate } from '../services/template';
import type { CompiledCollection } from '../services/schema-service';

/**
 * Value of a timezone-aware datetime field (#747). A legacy bare-string value
 * (written before `options.timezone` was enabled) resolves as `instant` only.
 */
export const ZonedDateTimeType = new GraphQLObjectType<unknown>({
  name: 'ZonedDateTime',
  description: 'An instant plus the IANA time zone it was authored in.',
  fields: {
    instant: {
      type: DateTimeScalar,
      description: 'ISO-8601 instant in UTC.',
      resolve: (src) => (isZonedDateTimeValue(src) ? src.instant : typeof src === 'string' ? src : null),
    },
    tz: {
      type: GraphQLString,
      description: 'IANA time zone, e.g. `America/New_York`.',
      resolve: (src) => (isZonedDateTimeValue(src) ? src.tz : null),
    },
    offset: {
      type: GraphQLString,
      description: 'UTC offset of `tz` at `instant`, e.g. `-04:00`.',
      resolve: (src) => (isZonedDateTimeValue(src) ? ((src as { offset?: string }).offset ?? null) : null),
    },
  },
});

/**
 * `geopoint` value (#746): `{ lat, lng }` in WGS 84 degrees. One shared
 * instance, so every collection with a geopoint field reuses the same type
 * name in the schema. Filter with `_near` / `_within_bbox` through the JSON
 * `filter` argument, as in REST.
 */
export const GeoPointType = new GraphQLObjectType({
  name: 'GeoPoint',
  description: 'A WGS 84 point: latitude and longitude in degrees.',
  fields: {
    lat: { type: new GraphQLNonNull(GraphQLFloat) },
    lng: { type: new GraphQLNonNull(GraphQLFloat) },
  },
});

/**
 * Delivery URL for a reference inside rich text: files resolve to their
 * content endpoint; item references keep their `data-ref-*` attributes and
 * no URL (the front end routes them).
 */
export function deliveryRefUrl(ref: RichTextRef): string | null {
  return ref.kind === 'file' ? `/api/v1/files/${encodeURIComponent(ref.id)}/content` : null;
}

/** Rich-text plugins in effect for a built site schema (resolvers read them via `info.schema`). */
const schemaPlugins = new WeakMap<GraphQLSchema, RichTextPlugin[]>();

export function registerRichTextPlugins(schema: GraphQLSchema, plugins: RichTextPlugin[]): void {
  schemaPlugins.set(schema, plugins);
}

/**
 * Block templates as rich-text blocks (#697): a custom block whose `name` is a
 * collection with a display template renders that template over the block's
 * `data`. The result is escaped text — a display template cannot emit markup.
 */
export function blockTemplatePlugin(collections: readonly Pick<CompiledCollection, 'name' | 'displayTemplate'>[]): RichTextPlugin {
  const blocks: NonNullable<RichTextPlugin['blocks']> = {};
  for (const c of collections) {
    const template = c.displayTemplate;
    if (!template) continue;
    blocks[c.name] = {
      toHtml: (data, ctx) => `<p>${ctx.escape(renderTemplate(template, data))}</p>`,
      toText: (data) => renderTemplate(template, data),
    };
  }
  return { name: 'block-templates', blocks };
}

/**
 * `richtext` value (#695): the portable JSON document plus server-rendered
 * HTML (allowlist-sanitised, #700), Markdown and plain text. Renderings are
 * computed only when selected.
 */
export const RichTextType = new GraphQLObjectType<RichTextDocument>({
  name: 'RichText',
  description: 'A portable rich-text document and its renderings.',
  fields: {
    json: { type: JSONScalar, description: 'The document (`{ type: "doc", version: 1, content }`).', resolve: (doc) => doc },
    html: {
      type: GraphQLString,
      description: 'Sanitised HTML: semantic tables, safe URL schemes only.',
      resolve: (doc, _args, _ctx, info) => richTextToHtml(doc, { resolveRef: deliveryRefUrl, plugins: schemaPlugins.get(info.schema) }),
    },
    markdown: { type: GraphQLString, description: 'CommonMark + GFM.', resolve: (doc) => richTextToMarkdown(doc, { resolveRef: deliveryRefUrl }) },
    text: {
      type: GraphQLString,
      description: 'Plain text, one block per line.',
      resolve: (doc, _args, _ctx, info) => richTextToPlainText(doc, { plugins: schemaPlugins.get(info.schema) }),
    },
  },
});

/**
 * Maps a LumiBase field type (see `fields.type` / interfaces) onto a
 * GraphQL output type. Anything structured or unknown falls back to the
 * `JSON` scalar so the schema never fails to build for an exotic field —
 * the value still round-trips verbatim, exactly like REST.
 */
export function mapFieldType(field: CompiledField): GraphQLOutputType {
  if (isZonedDateTimeField(field)) return ZonedDateTimeType;
  switch (field.type) {
    case 'boolean':
      return GraphQLBoolean;
    case 'integer':
      return GraphQLInt;
    case 'float':
    case 'decimal':
      return GraphQLFloat;
    // bigInteger is kept as String to avoid 53-bit precision loss.
    case 'bigInteger':
      return GraphQLString;
    case 'dateTime':
    case 'date':
    case 'time':
    case 'timestamp':
      return DateTimeScalar;
    case 'string':
    case 'text':
    case 'uuid':
    case 'hash':
    case 'slug':
    case 'code':
    case 'color':
      return GraphQLString;
    case 'geopoint':
      return GeoPointType;
    case 'richtext':
      return RichTextType;
    // Structured / relational / multi-value types passthrough as JSON.
    case 'json':
    case 'csv':
    case 'geometry':
    case 'files':
    case 'm2o':
    case 'o2m':
    case 'm2m':
    case 'm2a':
    // Dynamic zones (#748): the schema builder swaps in a per-field union of
    // block object types; JSON is only the fallback when no template resolves.
    case 'blocks':
      return JSONScalar;
    default:
      return GraphQLString;
  }
}

/**
 * Shape a stored value for its GraphQL type (`geopoint`, `richtext`): a row
 * written before the type existed (or by a raw import) may hold something
 * that is not `{ lat, lng }`, which must read as `null` rather than fail the
 * non-null `GeoPoint.lat` / `lng` for the whole response.
 */
export function resolveFieldValue(field: CompiledField, value: unknown): unknown {
  if (field.type === 'geopoint') return isGeoPoint(value) ? value : null;
  if (field.type === 'richtext') return isRichTextDocument(value) ? value : null;
  return value;
}
