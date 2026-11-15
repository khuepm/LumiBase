import { defineConfig } from "tsup";

export default defineConfig({
  // `nuxt-plugin` is its own entry: the Nuxt module registers it by file path,
  // so it must exist next to `nuxt.js` in dist/.
  entry: ["src/index.ts", "src/nuxt.ts", "src/nuxt-plugin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  // vue, nuxt and the SDK stay real imports so the app keeps one copy of each.
  external: ["vue", "nuxt", "@lumibase/sdk"],
});
