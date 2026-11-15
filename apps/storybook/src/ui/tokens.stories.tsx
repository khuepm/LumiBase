import type { Meta, StoryObj } from '@storybook/react-vite';

/**
 * The shadcn colour tokens `@lumibase/ui` components consume. They are CSS
 * variables defined in `apps/studio/src/index.css` (`:root` for light,
 * `.dark` for dark) and overridable per site via Settings → Branding. Flip
 * the toolbar theme to compare both palettes.
 */
const TOKENS = [
  ['background', 'foreground'],
  ['primary', 'primary-foreground'],
  ['muted', 'muted-foreground'],
  ['accent', 'accent-foreground'],
  ['destructive', 'destructive-foreground'],
] as const;

function TokenSwatches() {
  return (
    <ul className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
      {TOKENS.map(([surface, text]) => (
        <li key={surface} className="overflow-hidden rounded-lg border">
          <div
            className="flex h-16 items-center justify-center text-sm font-medium"
            style={{ backgroundColor: `hsl(var(--${surface}))`, color: `hsl(var(--${text}))` }}
          >
            Aa — {text}
          </div>
          <div className="px-3 py-2 text-xs">
            <code>--{surface}</code> / <code>--{text}</code>
          </div>
        </li>
      ))}
      <li className="overflow-hidden rounded-lg border">
        <div className="flex h-16 items-center gap-2 px-3">
          <span className="h-8 w-8 rounded-sm border-2" style={{ borderColor: 'hsl(var(--border))' }} />
          <span className="h-8 w-8 rounded-md border-2" style={{ borderColor: 'hsl(var(--input))' }} />
          <span className="h-8 w-8 rounded-lg border-2" style={{ borderColor: 'hsl(var(--ring))' }} />
        </div>
        <div className="px-3 py-2 text-xs">
          <code>--border</code> / <code>--input</code> / <code>--ring</code> · <code>--radius</code>
        </div>
      </li>
    </ul>
  );
}

const meta = {
  title: 'UI/Design tokens',
  component: TokenSwatches,
} satisfies Meta<typeof TokenSwatches>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Colours: Story = {};
