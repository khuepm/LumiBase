import type { FieldResource } from '@lumibase/sdk';
import { AioInterface } from './aio';
import { CodeInterface } from './code';
import { CollectionItemDropdownInterface } from './collection-item-dropdown';
import { ColorInterface } from './color';
import { DatetimeInterface } from './datetime';
import { FileInterface } from './file';
import { FilesInterface } from './files';
import { InputAutocompleteApiInterface } from './input-autocomplete-api';
import { InputHashInterface } from './input-hash';
import { JsonRawInterface } from './json-raw';
import { MapInterface } from './map';
import { MarkdownInterface } from './markdown';
import { NumberInterface } from './number';
import { RelationTreeViewInterface } from './relation-o2m-tree-view';
import {
  PresentationHeaderInterface,
  PresentationInterface,
  PresentationLinksInterface,
} from './presentation';
import { RatingInterface } from './rating';
import { RelationM2AInterface } from './relation-m2a';
import { RelationM2OInterface } from './relation-m2o';
import { RelationManyInterface } from './relation-many';
import { RepeaterInterface } from './repeater';
import { SeoInterface } from './seo';
import { SelectDropdownInterface } from './select';
import { SelectMultipleCheckbox, SelectMultipleDropdown } from './select-multiple';
import { SelectRadioInterface } from './select-radio';
import { SelectCheckboxTreeInterface } from './select-checkbox-tree';
import { SelectIconInterface } from './select-icon';
import { SliderInterface } from './slider';
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

  // Selection interfaces (Directus parity).
  'select-multiple-dropdown': SelectMultipleDropdown,
  'select-multiple-checkbox': SelectMultipleCheckbox,
  'select-multiple-checkbox-tree': SelectCheckboxTreeInterface,
  'select-radio': SelectRadioInterface,
  'select-icon': SelectIconInterface,
  slider: SliderInterface,

  // Phase B FE slice 4 additions.
  'relation-m2o': RelationM2OInterface,
  'relation-o2m': RelationManyInterface,
  'relation-m2m': RelationManyInterface,
  'relation-m2a': RelationM2AInterface,
  'relation-o2m-tree-view': RelationTreeViewInterface,
  'collection-item-dropdown': CollectionItemDropdownInterface,
  map: MapInterface,
  code: CodeInterface,
  wysiwyg: WysiwygInterface,
  markdown: MarkdownInterface,
  file: FileInterface,
  files: FilesInterface,
  repeater: RepeaterInterface,
  'presentation-divider': PresentationInterface,
  'presentation-notice': PresentationInterface,
  'presentation-header': PresentationHeaderInterface,
  'presentation-links': PresentationLinksInterface,
  'input-hash': InputHashInterface,
  'input-autocomplete-api': InputAutocompleteApiInterface,
  'translatable-text': TranslatableText,
  seo: SeoInterface,
  aio: AioInterface,

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
