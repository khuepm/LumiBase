import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/kit.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  // svelte and the SDK stay real imports so the app keeps one copy of each.
  external: ["svelte", "@sveltejs/kit", "@lumibase/sdk"],
});
