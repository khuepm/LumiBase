import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ExportDialog } from '@/modules/content/export-dialog';
import { SaveBookmarkDialog } from '@/modules/presets/save-bookmark-dialog';
import { makeField } from '../support/fixtures';

/**
 * Dialogs — modal surfaces from the content list. They talk to the CMS only
 * on submit (TanStack Query mutations), so the stories render with the
 * per-story QueryClient from `.storybook/preview.tsx` and never submit; the
 * site-locales query the export dialog reads is seeded via
 * `parameters.queryData` instead of hitting the network.
 */
interface Args {
  onClose: () => void;
}

const meta: Meta<Args> = {
  title: 'Studio/Dialogs',
  parameters: {
    queryData: [[['settings', 'locales'], { key: 'locales', value: { supported: ['en', 'vi'] } }]],
  },
  args: { onClose: fn() },
};

export default meta;
type Story = StoryObj<Args>;

const ARTICLE_FIELDS = [
  makeField({ name: 'title', interface: 'translatable-text' }),
  makeField({ name: 'slug', interface: 'slug' }),
  makeField({ name: 'summary', interface: 'input-multiline' }),
  makeField({ name: 'tags', type: 'json', interface: 'tags' }),
  makeField({ name: 'divider', type: 'alias', interface: 'presentation-divider' }),
];

export const ExportItems: Story = {
  render: ({ onClose }) => (
    <ExportDialog collection="articles" fields={ARTICLE_FIELDS} filter={{ status: { _eq: 'published' } }} onClose={onClose} />
  ),
  play: async ({ canvasElement, args }) => {
    const dialog = within(canvasElement).getByRole('dialog', { name: 'Export articles' });
    const scope = within(dialog);
    // Alias fields hold no value of their own and are not offered.
    await expect(scope.queryByRole('checkbox', { name: 'divider' })).toBeNull();
    await userEvent.click(scope.getByRole('button', { name: 'Select none' }));
    await expect(scope.getByRole('button', { name: 'Export' })).toBeDisabled();
    await userEvent.click(scope.getByRole('button', { name: 'Cancel' }));
    await expect(args.onClose).toHaveBeenCalledOnce();
  },
};

export const SaveBookmark: Story = {
  render: ({ onClose }) => (
    <SaveBookmarkDialog collection="articles" view={{ layout: 'table', search: null }} canManageShared onClose={onClose} />
  ),
  play: async ({ canvasElement }) => {
    const dialog = within(within(canvasElement).getByRole('dialog'));
    const save = dialog.getByRole('button', { name: 'Save' });
    await expect(save).toBeDisabled();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Name' }), 'Published this week');
    await expect(save).toBeEnabled();
  },
};

export const SaveBookmarkPersonalOnly: Story = {
  render: ({ onClose }) => (
    <SaveBookmarkDialog collection="articles" view={{ layout: 'table' }} canManageShared={false} onClose={onClose} />
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('combobox', { name: 'Scope' })).toBeNull();
  },
};
