import { cn } from '@lumibase/ui';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

/**
 * `cn()` — the class-name primitive every `@lumibase/ui` component is built
 * on: `clsx` for conditional classes, then `tailwind-merge` so a later
 * utility wins over a conflicting earlier one.
 */
interface CnDemoProps {
  /** Base classes, as a component would declare them. */
  base: string;
  /** Caller overrides passed through `className`. */
  override: string;
  /** Conditional class applied when `active`. */
  activeClass: string;
  active: boolean;
}

function CnDemo({ base, override, activeClass, active }: CnDemoProps) {
  const merged = cn(base, active && activeClass, override);
  return (
    <div className="space-y-3">
      <dl className="grid max-w-xl grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">base</dt>
        <dd>
          <code>{base}</code>
        </dd>
        <dt className="text-muted-foreground">active &&</dt>
        <dd>
          <code>{active ? activeClass : '(false)'}</code>
        </dd>
        <dt className="text-muted-foreground">override</dt>
        <dd>
          <code>{override}</code>
        </dd>
        <dt className="font-medium">cn(…)</dt>
        <dd>
          <code data-testid="merged">{merged}</code>
        </dd>
      </dl>
      <div className={merged}>Rendered with the merged classes</div>
    </div>
  );
}

const meta = {
  title: 'UI/cn',
  component: CnDemo,
  args: {
    base: 'rounded-md border px-2 py-1 text-sm',
    override: 'px-4',
    activeClass: 'bg-primary text-primary-foreground',
    active: false,
  },
} satisfies Meta<typeof CnDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A caller override replaces the conflicting base utility (`px-2` → `px-4`). */
export const OverrideWins: Story = {
  play: async ({ canvasElement }) => {
    const merged = within(canvasElement).getByTestId('merged').textContent ?? '';
    await expect(merged.split(' ')).toContain('px-4');
    await expect(merged.split(' ')).not.toContain('px-2');
  },
};

/** Conditional classes are applied only when truthy. */
export const ConditionalActive: Story = {
  args: { active: true },
  play: async ({ canvasElement }) => {
    const merged = within(canvasElement).getByTestId('merged').textContent ?? '';
    await expect(merged).toContain('bg-primary');
  },
};

/** Non-conflicting utilities are all kept, in order. */
export const NoConflict: Story = {
  args: { override: 'font-medium' },
  play: async ({ canvasElement }) => {
    const merged = within(canvasElement).getByTestId('merged').textContent ?? '';
    await expect(merged).toBe('rounded-md border px-2 py-1 text-sm font-medium');
  },
};
