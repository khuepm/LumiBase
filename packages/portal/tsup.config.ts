import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', react: 'src/react.ts' },
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    external: ['react'],
    // Contracts are bundled: the widget must not need a second package at runtime.
    noExternal: ['@lumibase/contracts'],
  },
  {
    // `<script src=".../portal.min.js" defer></script>` — defines <lumi-portal>
    // and mounts every `[data-lumi-portal]` element on the page.
    entry: { 'portal.min': 'src/auto.ts' },
    format: ['iife'],
    minify: true,
    platform: 'browser',
    noExternal: ['@lumibase/contracts'],
    outExtension: () => ({ js: '.js' }),
  },
]);
