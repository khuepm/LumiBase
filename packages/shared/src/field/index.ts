/**
 * Field DSL — the canonical shape used by both the API and the Studio
 * inspector. Kept hand-rolled (instead of zod-derived) so consumers can
 * import the types without paying the zod bundle cost.
 *
 * See `docs/features/field-types-and-config.md` for the full reference.
 */
export type FieldType =
  | 'string'
  | 'text'
  | 'integer'
  | 'bigInteger'
  | 'decimal'
  | 'boolean'
  | 'json'
  | 'uuid'
  | 'date'
  | 'datetime'
  | 'time'
  | 'timestamp'
  | 'csv'
  | 'hash'
  | 'geometry'
  | 'alias';

export type FieldWidth = 'half' | 'full' | 'fill';

/**
 * Data sensitivity classification (Req 5). `pii|phi` require `encrypted=true`,
 * are masked by default unless the caller has `read_decrypted`, and their
 * decrypted reads are audited to `field_access_log`.
 */
export type FieldClassification = 'none' | 'internal' | 'pii' | 'phi';

export interface FieldDefinition<TOptions = unknown> {
  name: string;
  type: FieldType;
  interface: string;
  display?: string;
  options?: TOptions;
  displayOptions?: Record<string, unknown>;
  validation?: { rules: Array<Record<string, unknown>> };
  conditions?: Array<{ rule: string; set: Record<string, unknown> }>;
  translations?: Record<string, { label?: string; help?: string }>;
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  encrypted?: boolean;
  /** Data sensitivity classification (defaults to `none`). */
  classification?: FieldClassification;
  versioned?: boolean;
  rawEnabled?: boolean;
  width?: FieldWidth;
  group?: string;
  sortOrder?: number;
}
