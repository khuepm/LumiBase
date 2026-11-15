import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const studioSrc = path.resolve(here, '../../studio/src');

/**
 * Storybook for `@lumibase/ui` primitives and a representative slice of Studio
 * components (#755). It lives in its own workspace package so neither
 * `packages/ui` nor `apps/studio` carries Storybook dependencies.
 *
 * The static build is published under the docs site at `/storybook/`
 * (`apps/docs/scripts/copy-storybook.mjs`), so asset URLs are relative.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-vitest'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  viteFinal: async (viteConfig) => {
    viteConfig.base = './';
    viteConfig.resolve ??= {};
    // One React / QueryClient context across Storybook and the Studio sources.
    viteConfig.resolve.dedupe = ['react', 'react-dom', '@tanstack/react-query'];
    viteConfig.resolve.alias = {
      ...(viteConfig.resolve.alias as Record<string, string> | undefined),
      // Studio components import their siblings through the `@/` alias.
      '@': studioSrc,
    };
    return viteConfig;
  },
};

export default config;
