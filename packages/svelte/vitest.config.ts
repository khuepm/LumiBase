import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    // Component lifecycle tests opt into jsdom per file with a
    // `// @vitest-environment jsdom` docblock; the rest run in node, which is
    // also what proves the entry points import cleanly without `window`.
    environment: "node",
  },
});
