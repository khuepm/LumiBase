/**
 * Source-neutral model for content migrations (#728). Each source adapter
 * (Contentful today; Sanity, WordPress, Strapi next) parses its export into
 * this shape; planning, field mapping and entry transformation are shared.
 */
import type { RichTextDocument } from '../richtext/index';

export type MigrationSourceName = 'contentful';

/** Field kinds every adapter maps its source types onto. */
export type SourceFieldKind =
  | 'shortText'
  | 'longText'
  | 'richText'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'location'
  | 'object'
  | 'shortTextList'
  | 'entryLink'
  | 'entryLinks'
  | 'assetLink'
  | 'assetLinks';

export interface SourceField {
  id: string;
  name: string;
  kind: SourceFieldKind;
  localized: boolean;
  required: boolean;
  /** For entry links: content types the link may point at (empty = any). */
  linkContentTypes?: string[];
  /** For short text with an allowed-values validation. */
  choices?: string[];
  /** Original source type, for notes and warnings. */
  sourceType: string;
}

export interface SourceContentType {
  id: string;
  name: string;
  description?: string;
  displayField?: string;
  fields: SourceField[];
}

export interface SourceLocale {
  code: string;
  name?: string;
  default: boolean;
}

/** A link to another entry or asset, normalised by the adapter. */
export interface SourceLink {
  $link: 'entry' | 'asset';
  id: string;
}

/**
 * Field values per source locale. Values are already normalised: links are
 * {@link SourceLink}, rich text is a {@link RichTextDocument} whose item refs
 * carry the target *content type id* in `collection` (the transform renames
 * it) and whose file refs carry the *asset id*.
 */
export type SourceFieldValues = Record<string, Record<string, unknown>>;

export interface SourceEntry {
  id: string;
  contentType: string;
  status: 'draft' | 'published' | 'archived';
  fields: SourceFieldValues;
}

export interface SourceAssetFile {
  url: string;
  fileName: string;
  contentType: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface SourceAsset {
  id: string;
  status: 'draft' | 'published' | 'archived';
  title: Record<string, string>;
  description: Record<string, string>;
  file: Record<string, SourceAssetFile>;
}

export interface SourceExport {
  source: MigrationSourceName;
  /** Space / project id when the export carries one. */
  sourceId?: string;
  locales: SourceLocale[];
  contentTypes: SourceContentType[];
  entries: SourceEntry[];
  assets: SourceAsset[];
  /** Problems found while parsing (unsupported fields, dangling links…). */
  warnings: string[];
}

export type { RichTextDocument };
