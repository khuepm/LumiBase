import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Three projects:
 *
 * - `guards` (node, part of `pnpm test`): every `@lumibase/ui` export has a
 *   story, and a11y exceptions carry a justification.
 * - `stories-light` / `stories-dark` (Chromium via Playwright): every story
 *   renders, its `play` function passes, and the axe scan reports no
 *   violation (`parameters.a11y.test = 'error'`) — once per theme, so colour
 *   contrast is checked against both palettes.
 *
 * The browser projects need a Chromium build matching the `playwright`
 * devDependency (`pnpm exec playwright install chromium` on a fresh machine).
 */
function storiesProject(theme: 'light' | 'dark'): TestProjectInlineConfiguration {
  return {
    extends: true,
    plugins: [
      storybookTest({
        configDir: path.join(here, '.storybook'),
        storybookScript: 'pnpm storybook',
        initialGlobals: { theme },
      }),
    ],
    test: {
      name: `stories-${theme}`,
      browser: {
        enabled: true,
        headless: true,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
        viewport: { width: 1024, height: 768 },
      },
    },
  };
}

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(here, '../studio/src') },
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'guards',
          environment: 'node',
          include: ['__tests__/**/*.test.ts'],
        },
      },
      storiesProject('light'),
      storiesProject('dark'),
    ],
  },
});
