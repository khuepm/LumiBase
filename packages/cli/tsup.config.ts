import { defineConfig } from "tsup";

export default defineConfig([
  {
    // CLI entry — loaded by `bin/lumibase.js`.
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: false,
    target: "node22",
    // The typegen core is pure (manifest -> TS source) and tiny. Bundling it keeps
    // the CLI self-contained for `npx lumibase`, and avoids a runtime import of
    // @lumibase/sdk — which resolves to raw .ts inside the monorepo.
    noExternal: ["@lumibase/sdk"],
  },
  {
    // Library entry — `import ... from 'lumibase'`. Here the SDK must stay a
    // real runtime dependency (not bundled) so a project that also imports
    // `@lumibase/sdk` directly gets one copy of every class (`LumiError`
    // instanceof checks) and one set of types.
    entry: ["src/lib.ts"],
    format: ["esm"],
    dts: true,
    clean: false,
    sourcemap: false,
    target: "es2022",
    platform: "neutral",
    external: ["@lumibase/sdk"],
  },
]);
