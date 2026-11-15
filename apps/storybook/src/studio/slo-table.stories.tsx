import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { ContentIntent } from '@/modules/mission-control/api';
import { HealthBar, IntentStatusBadge, SloTable, type SloRow } from '@/modules/mission-control/slo-table';

/**
 * Data table — Mission Control's SLO health table, shared by the dashboard
 * summary and the intents page. Rows are plain props, so the story feeds
 * fixtures straight in; `linkBase` is left unset (no router in Storybook).
 */
function intent(id: string, name: string, collection: string, status: string): ContentIntent {
  return { id, name, collection, rules: [], schedule: '0 * * * *', autonomyCap: 2, status, statusReason: null };
}

const ROWS: SloRow[] = [
  { intent: intent('int_1', 'Fresh product copy', 'products', 'active'), open: 0, total: 12, health: 100, unevaluated: 0 },
  { intent: intent('int_2', 'Alt text on every image', 'media', 'active'), open: 3, total: 10, health: 70, unevaluated: 0 },
  { intent: intent('int_3', 'Brand voice (semantic)', 'articles', 'active'), open: 2, total: 4, health: 50, unevaluated: 3 },
  { intent: intent('int_4', 'Translations in sync', 'articles', 'paused'), open: 0, total: 0, health: null, unevaluated: 0 },
  { intent: intent('int_5', 'Broken links', 'pages', 'error'), open: 1, total: 1, health: 0, unevaluated: 0 },
];

const meta = {
  title: 'Studio/Data table (SLO health)',
  component: SloTable,
  args: { rows: ROWS },
} satisfies Meta<typeof SloTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('row')).toHaveLength(ROWS.length + 1);
    await expect(canvas.getByText('3 not evaluated')).toBeVisible();
    await expect(canvas.getByText('unknown')).toBeVisible();
  },
};

export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(/No content intents yet/)).toBeVisible();
  },
};

/** The two cell renderers the table is built from. */
export const CellRenderers: Story = {
  render: () => (
    <div className="space-y-3">
      <div className="flex gap-2">
        <IntentStatusBadge status="active" />
        <IntentStatusBadge status="paused" />
        <IntentStatusBadge status="error" />
      </div>
      <div className="flex flex-col gap-2">
        <HealthBar health={96} />
        <HealthBar health={72} />
        <HealthBar health={30} />
        <HealthBar health={null} />
      </div>
    </div>
  ),
};
