import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/loader.ts", "src/client.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  external: ["astro", "@lumibase/sdk"],
});
