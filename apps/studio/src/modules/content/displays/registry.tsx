import type { FieldResource } from '@lumibase/sdk';
import { BadgeDisplay } from './badge';
import { BooleanIconDisplay } from './boolean-icon';
import { ColorSwatchDisplay } from './color-swatch';
import { FormattedDateDisplay } from './formatted-date';
import { FormattedValueDisplay } from './formatted-value';
import { ImageDisplay } from './image';
import { LabelsDisplay } from './labels';
import { MustacheDisplay } from './mustache';
import { RatingStarsDisplay } from './rating-stars';
import { RawDisplay } from './raw';
import { RelationDisplay } from './relation';
import { RelationM2ADisplay } from './relation-m2a';
import { TagsPillsDisplay } from './tags-pills';
import { TextDisplay } from './text';
import { ComponentTemplateDisplay } from './component-template';
import { readDisplayKey, type DisplayComponent } from './types';

/**
 * Display registry — name -> read-only renderer for list cells.
 * Resolution order: `field.meta.display.name` → `field.interface` heuristic
 * → underlying `field.type` → text fallback.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY: Record<string, DisplayComponent<any>> = {
  // Phase A starter set.
  text: TextDisplay,
  badge: BadgeDisplay,
  'boolean-icon': BooleanIconDisplay,
  relation: RelationDisplay,
  'relation-m2a': RelationM2ADisplay,
  'formatted-date': FormattedDateDisplay,
  'color-swatch': ColorSwatchDisplay,
  'rating-stars': RatingStarsDisplay,
  'tags-pills': TagsPillsDisplay,
  mustache: MustacheDisplay,

  // Phase B FE additions — names match `features/field-types-and-config.md`.
  'formatted-value': FormattedValueDisplay,
  raw: RawDisplay,
  image: ImageDisplay,
  labels: LabelsDisplay,
  // Phase F — Component DSL display.
  'component-template': ComponentTemplateDisplay,

  // Aliases so the doc-canonical names resolve too.
  datetime: FormattedDateDisplay,
  'mustache-template': MustacheDisplay,
};

const INTERFACE_TO_DISPLAY: Record<string, string> = {
  toggle: 'boolean-icon',
  boolean: 'boolean-icon',
  'select-dropdown': 'badge',
  datetime: 'formatted-date',
  color: 'color-swatch',
  rating: 'rating-stars',
  tags: 'tags-pills',
  'relation-m2o': 'relation',
  'relation-m2a': 'relation-m2a',
};

const TYPE_TO_DISPLAY: Record<string, string> = {
  boolean: 'boolean-icon',
  date: 'formatted-date',
  datetime: 'formatted-date',
  timestamp: 'formatted-date',
};

export function resolveDisplay(field: FieldResource): DisplayComponent<unknown> {
  const explicit = readDisplayKey(field);
  const candidate =
    (explicit && REGISTRY[explicit]) ||
    REGISTRY[INTERFACE_TO_DISPLAY[field.interface] ?? ''] ||
    REGISTRY[TYPE_TO_DISPLAY[field.type] ?? ''] ||
    TextDisplay;
  return candidate as DisplayComponent<unknown>;
}

/**
 * Display catalogue surfaced in the inspector picker. Keep order stable
 * so the dropdown is predictable. Aliases are excluded — the canonical
 * name covers them.
 */
export const DISPLAY_CATALOGUE: Array<{ id: string; label: string; hint: string }> = [
  { id: 'formatted-value', label: 'Formatted value', hint: 'Generic text with prefix/suffix/case/truncate.' },
  { id: 'raw', label: 'Raw', hint: 'Stringify with no formatting.' },
  { id: 'badge', label: 'Badge', hint: 'Colored pill keyed by value.' },
  { id: 'boolean-icon', label: 'Boolean icon', hint: 'Check / cross icon.' },
  { id: 'datetime', label: 'Datetime', hint: 'Relative / short / ISO date formatting.' },
  { id: 'color-swatch', label: 'Color swatch', hint: 'Inline color square + hex.' },
  { id: 'rating-stars', label: 'Rating stars', hint: 'Star row for numeric ratings.' },
  { id: 'tags-pills', label: 'Tags pills', hint: 'Compact pills for `string[]` values.' },
  { id: 'labels', label: 'Labels', hint: 'Pills with per-value tone mapping.' },
  { id: 'image', label: 'Image', hint: 'Thumbnail for file/url values.' },
  { id: 'relation', label: 'Relation', hint: 'Resolve id → related collection field.' },
  { id: 'relation-m2a', label: 'Relation (M2A)', hint: 'Summarise links across multiple collections.' },
  { id: 'mustache-template', label: 'Mustache template', hint: 'Compose a row template like `{{title}} ({{slug}})`.' },
  { id: 'component-template', label: 'Component template', hint: 'Visual block-based template (Phase F).' },
];

export const DISPLAY_NAMES = Object.keys(REGISTRY);
