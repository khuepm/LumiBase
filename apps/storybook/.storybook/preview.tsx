import type { Decorator, Preview } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import './preview.css';

type StoryTheme = 'light' | 'dark';

/** Same switch `apps/studio/src/components/site-theme.tsx` flips: `.dark` on `<html>`. */
function applyTheme(theme: StoryTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.dataset.theme = theme;
}

/**
 * Light and dark are a toolbar global, so every story can be checked in both.
 * The vitest projects pin one theme each (`stories-light`, `stories-dark`),
 * so the a11y scan — colour contrast included — runs in both themes.
 */
const withTheme: Decorator = (Story, context) => {
  const theme: StoryTheme = context.globals.theme === 'dark' ? 'dark' : 'light';
  // Applied during render (not in an effect) so the first paint and the
  // a11y scan already see the right tokens.
  applyTheme(theme);
  return (
    <div className="min-h-[120px] bg-background p-4 text-foreground" data-story-root="">
      <Story />
    </div>
  );
};

/**
 * Studio components that read or write through TanStack Query get an
 * isolated client per story: no retries, no network. Stories seed it with
 * `parameters.queryData` instead of mocking `fetch`.
 */
const withQueryClient: Decorator = (Story, context) => {
  const seed = (context.parameters.queryData ?? []) as ReadonlyArray<readonly [readonly unknown[], unknown]>;
  const [client] = useState(() => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    for (const [key, data] of seed) qc.setQueryData(key, data);
    return qc;
  });
  return (
    <QueryClientProvider client={client}>
      <Story />
    </QueryClientProvider>
  );
};

const preview: Preview = {
  decorators: [withQueryClient, withTheme],
  globalTypes: {
    theme: {
      description: 'Studio colour theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
    a11y: {
      // Violations FAIL the story test run (addon-vitest). A per-story
      // exception goes through `a11yException()` in src/support/a11y.ts, which
      // requires a written justification; the `guards` project enforces it.
      test: 'error',
    },
  },
  tags: ['autodocs'],
};

export default preview;
