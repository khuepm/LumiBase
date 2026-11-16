import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, within } from 'storybook/test';
import { BadgeDisplay } from '@/modules/content/displays/badge';
import { BooleanIconDisplay } from '@/modules/content/displays/boolean-icon';
import { ColorSwatchDisplay } from '@/modules/content/displays/color-swatch';
import { FormattedDateDisplay } from '@/modules/content/displays/formatted-date';
import { LabelsDisplay } from '@/modules/content/displays/labels';
import { RatingStarsDisplay } from '@/modules/content/displays/rating-stars';
import { TagsPillsDisplay } from '@/modules/content/displays/tags-pills';
import { makeField } from '../support/fixtures';

/**
 * Displays — the read-only cell renderers list views use, looked up by
 * `field.display` in `apps/studio/src/modules/content/displays/registry.tsx`.
 * Each story shows the populated case next to the empty (`—`) case.
 */
const meta = {
  title: 'Studio/Displays',
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid max-w-xl grid-cols-[10rem_1fr] items-center gap-3 border-b py-2 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

const statusField = makeField({
  name: 'status',
  display: 'badge',
  displayOptions: { tones: { published: 'emerald', review: 'amber', archived: 'muted', blocked: 'destructive' } },
});

export const Badge: Story = {
  render: () => (
    <div>
      <Row label="tone: emerald">
        <BadgeDisplay value="published" field={statusField} />
      </Row>
      <Row label="tone: amber">
        <BadgeDisplay value="review" field={statusField} />
      </Row>
      <Row label="tone: destructive">
        <BadgeDisplay value="blocked" field={statusField} />
      </Row>
      <Row label="empty">
        <BadgeDisplay value={null} field={statusField} />
      </Row>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('published')).toBeVisible();
  },
};

export const Labels: Story = {
  render: () => {
    const field = makeField({ name: 'flags', display: 'labels', displayOptions: { tones: { urgent: 'destructive', seo: 'sky' }, max: 2 } });
    return (
      <div>
        <Row label="3 labels, max 2">
          <LabelsDisplay value={['urgent', 'seo', 'legal']} field={field} />
        </Row>
        <Row label="empty">
          <LabelsDisplay value={[]} field={field} />
        </Row>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('+1')).toBeVisible();
  },
};

export const BooleanIcon: Story = {
  render: () => {
    const field = makeField({ name: 'featured', type: 'boolean', display: 'boolean-icon' });
    return (
      <div>
        <Row label="true">
          <BooleanIconDisplay value field={field} />
        </Row>
        <Row label="false">
          <BooleanIconDisplay value={false} field={field} />
        </Row>
        <Row label="null">
          <BooleanIconDisplay value={null} field={field} />
        </Row>
      </div>
    );
  },
};

export const ColorSwatch: Story = {
  render: () => {
    const field = makeField({ name: 'accent', display: 'color-swatch' });
    return (
      <div>
        <Row label="#6d28d9">
          <ColorSwatchDisplay value="#6d28d9" field={field} />
        </Row>
        <Row label="no hash">
          <ColorSwatchDisplay value="0ea5e9" field={field} />
        </Row>
        <Row label="invalid">
          <ColorSwatchDisplay value="not-a-colour" field={field} />
        </Row>
      </div>
    );
  },
};

export const RatingStars: Story = {
  render: () => {
    const field = makeField({ name: 'score', type: 'integer', display: 'rating-stars' });
    return (
      <div>
        <Row label="4 of 5">
          <RatingStarsDisplay value={4} field={field} />
        </Row>
        <Row label="unrated">
          <RatingStarsDisplay value={null} field={field} />
        </Row>
      </div>
    );
  },
};

export const TagsPills: Story = {
  render: () => {
    const field = makeField({ name: 'tags', type: 'json', display: 'tags-pills' });
    return (
      <div>
        <Row label="5 tags">
          <TagsPillsDisplay value={['edge', 'headless', 'cms', 'ai', 'multi-tenant']} field={field} />
        </Row>
        <Row label="empty">
          <TagsPillsDisplay value={[]} field={field} />
        </Row>
      </div>
    );
  },
};

/**
 * Dates use fixed ISO / short formats; the relative format depends on
 * `Date.now()` and would make visual snapshots drift, so it is pinned to a
 * value computed relative to render time.
 */
export const FormattedDate: Story = {
  render: () => {
    const iso = makeField({ name: 'published_at', type: 'timestamp', display: 'formatted-date', displayOptions: { format: 'iso' } });
    const relative = makeField({ name: 'updated_at', type: 'timestamp', display: 'formatted-date', displayOptions: { format: 'relative' } });
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    return (
      <div>
        <Row label="iso">
          <FormattedDateDisplay value="2026-05-03T09:30:00.000Z" field={iso} />
        </Row>
        <Row label="relative">
          <FormattedDateDisplay value={threeHoursAgo} field={relative} />
        </Row>
        <Row label="invalid">
          <FormattedDateDisplay value="not-a-date" field={iso} />
        </Row>
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('2026-05-03T09:30:00.000Z')).toBeVisible();
  },
};
