/**
 * Signup card block (#721, epic #672 N05).
 *
 * Block templates are ordinary collections (see `services/blocks.ts`), so the
 * card is installed as a hidden `signup_card` collection whose fields are the
 * per-card overrides. Text fields use the `translatable-text` interface, so an
 * editor can override a label for one locale and leave the rest to the site
 * copy. Rendering resolves copy with `resolveSignupCopy` from
 * `@lumibase/contracts/members` — the same function the Portal widget runs —
 * so the server preview and the widget never disagree: per-card override →
 * site copy for the locale → built-in default for the locale.
 *
 * Install is idempotent: an existing `signup_card` collection is left as-is
 * (the operator may have extended it), and only missing fields are added.
 */

import { SIGNUP_CARD_BLOCK } from '@lumibase/contracts/members';
import type { FieldInput, SchemaService } from '../../services/schema-service';

const translatable = (name: string, label: string, sortOrder: number): FieldInput => ({
  name,
  label,
  type: 'json',
  interface: 'translatable-text',
  nullable: true,
  sortOrder,
  note: 'Leave empty to use the site copy for each locale.',
});

export const SIGNUP_CARD_FIELDS: readonly FieldInput[] = [
  translatable('heading', 'Heading', 1),
  translatable('description', 'Description', 2),
  translatable('placeholder', 'Email placeholder', 3),
  translatable('button_label', 'Button label', 4),
  translatable('success_message', 'Success message', 5),
  {
    name: 'newsletters',
    label: 'Newsletters',
    type: 'json',
    interface: 'tags',
    nullable: true,
    sortOrder: 6,
    note: 'Newsletter keys to subscribe; empty = site defaults.',
  },
  {
    name: 'collect_name',
    label: 'Ask for a name',
    type: 'boolean',
    interface: 'boolean',
    defaultValue: false,
    sortOrder: 7,
  },
  {
    name: 'layout',
    label: 'Layout',
    type: 'string',
    interface: 'select-dropdown',
    defaultValue: 'card',
    options: { choices: [{ value: 'card', text: 'Card' }, { value: 'inline', text: 'Inline' }, { value: 'minimal', text: 'Minimal' }] },
    sortOrder: 8,
  },
];

export async function installSignupCard(schema: SchemaService): Promise<{ created: boolean; addedFields: string[] }> {
  let created = false;
  const existing = await schema.getCollection(SIGNUP_CARD_BLOCK);
  if (!existing) {
    await schema.createCollection({
      name: SIGNUP_CARD_BLOCK,
      label: 'Signup card',
      icon: 'mail-plus',
      hidden: true,
      note: 'Block template: a member signup form rendered by the Portal widget.',
    });
    created = true;
  }
  const compiled = await schema.getCompiled(SIGNUP_CARD_BLOCK);
  const have = new Set((compiled?.fields ?? []).map((f) => f.name));
  const addedFields: string[] = [];
  for (const field of SIGNUP_CARD_FIELDS) {
    if (have.has(field.name)) continue;
    await schema.createField(SIGNUP_CARD_BLOCK, field);
    addedFields.push(field.name);
  }
  return { created, addedFields };
}
