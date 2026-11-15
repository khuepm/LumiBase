import type { FieldResource } from "@lumibase/sdk";

/**
 * Common contract for every Studio interface component (Phase B FE slice 3+).
 *
 * An "interface" is the field-level editor rendered inside item detail forms.
 * Interfaces are registered by the `field.interface` string returned by the
 * schema engine, e.g. `input`, `input-multiline`, `toggle`, `select-dropdown`.
 */
export interface InterfaceProps<T = unknown> {
  /** Current value as stored in the item's `data` JSONB blob. */
  value: T | null | undefined;
  /** Field metadata from the schema engine; gives access to `meta.options`. */
  field: FieldResource;
  /** Disabled flag (driven by per-field permissions in Phase C). */
  disabled?: boolean;
  /** Notify parent of a new value. */
  onChange: (next: T | null) => void;
  /**
   * Content locale of the value, when the caller knows it (e.g. one locale of
   * a translatable field). Text editors use it for `dir`/`lang` via
   * `contentDirProps` (#761); without it they fall back to `dir="auto"`.
   */
  locale?: string;
}

/** Component signature for everything in `interfaces/registry.tsx`. */
export type InterfaceComponent<T = unknown> = React.FC<InterfaceProps<T>>;

/**
 * Helper for interfaces that read configuration off `field.meta.options`.
 * Schema engine merges arbitrary JSON there, so the runtime shape is unknown
 * — callers narrow with their own option interface.
 */
export function readOptions<T>(field: FieldResource): T {
  const meta = (field as unknown as { meta?: Record<string, unknown> }).meta;
  return (meta?.options as T) ?? ({} as T);
}
