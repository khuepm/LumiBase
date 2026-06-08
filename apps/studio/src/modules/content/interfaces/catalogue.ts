export type InterfaceGroup =
  | 'Text'
  | 'Number'
  | 'Choice'
  | 'Boolean'
  | 'Date'
  | 'Relation'
  | 'File'
  | 'Content'
  | 'Special';

export interface InterfaceCatalogueItem {
  id: string;
  label: string;
  description: string;
  type: string;
  group: InterfaceGroup;
  defaultOptions?: Record<string, unknown>;
  defaultSpecial?: string[];
  defaultDisplay?: string | null;
  width?: 'half' | 'full' | 'fill';
}

export const INTERFACE_GROUPS: InterfaceGroup[] = [
  'Text',
  'Number',
  'Choice',
  'Boolean',
  'Date',
  'Relation',
  'File',
  'Content',
  'Special',
];

export const INTERFACE_CATALOGUE: InterfaceCatalogueItem[] = [
  {
    id: 'input',
    label: 'Input',
    description: 'Single-line text, uuid, or scalar value.',
    type: 'string',
    group: 'Text',
    defaultOptions: { trim: true, clear: true },
  },
  {
    id: 'input-multiline',
    label: 'Textarea',
    description: 'Multi-line plain text editor.',
    type: 'text',
    group: 'Text',
    defaultOptions: { rows: 4, trim: true },
    width: 'full',
  },
  { id: 'wysiwyg', label: 'WYSIWYG', description: 'Rich HTML editor.', type: 'text', group: 'Text' },
  { id: 'markdown', label: 'Markdown', description: 'Markdown editor.', type: 'text', group: 'Text' },
  { id: 'code', label: 'Code', description: 'Monospace code editor.', type: 'text', group: 'Text' },
  {
    id: 'slug',
    label: 'Slug',
    description: 'URL-safe text derived from another field.',
    type: 'string',
    group: 'Text',
    defaultOptions: { source: 'title' },
    defaultDisplay: 'text',
  },
  { id: 'color', label: 'Color', description: 'Color picker.', type: 'string', group: 'Text', defaultDisplay: 'color-swatch' },
  { id: 'input-number', label: 'Number', description: 'Integer input.', type: 'integer', group: 'Number' },
  { id: 'rating', label: 'Rating', description: 'Star rating.', type: 'integer', group: 'Number', defaultOptions: { max: 5 } },
  {
    id: 'select-dropdown',
    label: 'Dropdown',
    description: 'Single choice dropdown.',
    type: 'string',
    group: 'Choice',
    defaultOptions: { choices: [] },
    defaultDisplay: 'labels',
  },
  { id: 'tags', label: 'Tags', description: 'Free-form tag list.', type: 'json', group: 'Choice', defaultDisplay: 'tags-pills' },
  { id: 'toggle', label: 'Toggle', description: 'Boolean switch.', type: 'boolean', group: 'Boolean', defaultDisplay: 'boolean-icon' },
  { id: 'datetime', label: 'Date/time', description: 'Date and time picker.', type: 'datetime', group: 'Date', defaultDisplay: 'formatted-date' },
  {
    id: 'relation-m2o',
    label: 'Many-to-one',
    description: 'Select one related item.',
    type: 'uuid',
    group: 'Relation',
    defaultOptions: { collection: '', displayField: 'title' },
    defaultSpecial: ['m2o'],
    defaultDisplay: 'relation',
  },
  {
    id: 'relation-o2m',
    label: 'One-to-many',
    description: 'Show many related items through an alias field.',
    type: 'alias',
    group: 'Relation',
    defaultOptions: { collection: '', displayField: 'title' },
    defaultSpecial: ['o2m'],
    defaultDisplay: 'relation',
  },
  {
    id: 'relation-m2m',
    label: 'Many-to-many',
    description: 'Manage related items through a junction collection.',
    type: 'alias',
    group: 'Relation',
    defaultOptions: { collection: '', displayField: 'title', junctionCollection: '' },
    defaultSpecial: ['m2m'],
    defaultDisplay: 'relation',
  },
  {
    id: 'file',
    label: 'File',
    description: 'Single file upload and picker.',
    type: 'uuid',
    group: 'File',
    defaultOptions: { accept: 'image/*,application/pdf' },
    defaultSpecial: ['file'],
    defaultDisplay: 'image',
  },
  {
    id: 'seo',
    label: 'SEO',
    description: 'Title, description, canonical URL, robots, and social image.',
    type: 'json',
    group: 'Content',
    defaultOptions: {
      titleMaxLength: 70,
      descriptionMaxLength: 160,
      imageAccept: 'image/*',
    },
    width: 'full',
  },
  {
    id: 'json-raw',
    label: 'JSON (raw)',
    description: 'Raw JSON editor.',
    type: 'json',
    group: 'Special',
  },
  { id: 'repeater', label: 'Repeater', description: 'Repeat nested field groups.', type: 'json', group: 'Special' },
  { id: 'presentation-divider', label: 'Presentation: divider', description: 'Visual divider only.', type: 'alias', group: 'Special' },
  { id: 'presentation-notice', label: 'Presentation: notice', description: 'Inline editorial notice.', type: 'alias', group: 'Special' },
];

export function findInterfaceCatalogueItem(id: string): InterfaceCatalogueItem | undefined {
  return INTERFACE_CATALOGUE.find((item) => item.id === id);
}
