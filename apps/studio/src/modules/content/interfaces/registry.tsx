import type { FieldResource } from '@lumibase/sdk';
import { CodeInterface } from './code';
import { ColorInterface } from './color';
import { DatetimeInterface } from './datetime';
import { FileInterface } from './file';
import { JsonRawInterface } from './json-raw';
import { MarkdownInterface } from './markdown';
import { NumberInterface } from './number';
import { PresentationInterface } from './presentation';
import { RatingInterface } from './rating';
import { RelationM2OInterface } from './relation-m2o';
import { RelationManyInterface } from './relation-many';
import { RepeaterInterface } from './repeater';
import { SelectDropdownInterface } from './select';
import { SlugInterface } from './slug';
import { TagsInterface } from './tags';
import { TextInterface, TextMultilineInterface } from './text';
import { ToggleInterface } from './toggle';
import { TranslatableText } from './translatable-text';
import { WysiwygInterface } from './wysiwyg';
import type { InterfaceComponent } from './types';
import { getExtension } from '@/lib/extension-loader';

/**
 * Maps the schema engine's `field.interface` string to a Studio component.
 * Slice 4 adds relation/file/code/wysiwyg/markdown/repeater/presentation.
 *
 * The registry is typed as `InterfaceComponent<any>` because each entry
 * binds its own value type; the public `resolveInterface` exposes a generic
 * `unknown`-valued surface so the parent form can pass through any cell value.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY: Record<string, InterfaceComponent<any>> = {
  // Phase A starter set.
  input: TextInterface,
  'input-multiline': TextMultilineInterface,
  toggle: ToggleInterface,
  'select-dropdown': SelectDropdownInterface,
  datetime: DatetimeInterface,
  'json-raw': JsonRawInterface,

  // Phase B FE slice 3 additions.
  'input-number': NumberInterface,
  slug: SlugInterface,
  color: ColorInterface,
  rating: RatingInterface,
  tags: TagsInterface,

  // Phase B FE slice 4 additions.
  'relation-m2o': RelationM2OInterface,
  'relation-o2m': RelationManyInterface,
  'relation-m2m': RelationManyInterface,
  code: CodeInterface,
  wysiwyg: WysiwygInterface,
  markdown: MarkdownInterface,
  file: FileInterface,
  repeater: RepeaterInterface,
  'presentation-divider': PresentationInterface,
  'presentation-notice': PresentationInterface,
  'translatable-text': TranslatableText,

  // Aliases by underlying type so collections without an explicit interface
  // still get a sensible editor.
  boolean: ToggleInterface,
  number: NumberInterface,
  string: TextInterface,
};

export function resolveInterface(field: FieldResource): InterfaceComponent<unknown> {
  // 1. Static registry (Phase A-F built-ins).
  if (REGISTRY[field.interface]) return REGISTRY[field.interface] as InterfaceComponent<unknown>;
  if (REGISTRY[field.type]) return REGISTRY[field.type] as InterfaceComponent<unknown>;

  // 2. Dynamically loaded extension interfaces (Phase F).
  // Extension must declare type: 'interface' and name matching field.interface.
  const extEntry = getExtension(field.interface);
  if (extEntry?.slot === 'interface') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return extEntry.component as InterfaceComponent<any>;
  }

  return JsonRawInterface as InterfaceComponent<unknown>;
}

export const INTERFACE_NAMES = Object.keys(REGISTRY);

/**
 * Register an extension-provided interface at runtime.
 * Called by the extension loader after bundle import.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerExtensionInterface(name: string, component: InterfaceComponent<any>): void {
  REGISTRY[name] = component;
}
