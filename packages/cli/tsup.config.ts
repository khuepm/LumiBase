import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  // A CLI, not a library — `bin` is the only entry point, so no .d.ts to emit.
  dts: false,
  clean: true,
  sourcemap: false,
  target: 'node22',
  // The typegen core is pure (manifest -> TS source) and tiny. Bundling it keeps
  // the CLI self-contained for `npx lumibase`, and avoids a runtime import of
  // @lumibase/sdk — which resolves to raw .ts inside the monorepo.
  noExternal: ['@lumibase/sdk'],
});
