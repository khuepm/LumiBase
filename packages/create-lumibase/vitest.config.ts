import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests import a few pure modules straight out of `templates/` (#744). Those
// directories carry the tsconfig of the project they scaffold
// (`astro/tsconfigs/strict`, `$app/tsconfig`), which only resolves after a
// scaffolded project is installed — so transform everything with this
// package's own tsconfig instead of the nearest one. Passed through a variable
// because `tsconfig` is a transformer option Vite's type omits.
const oxc = { tsconfig: fileURLToPath(new URL('./tsconfig.json', import.meta.url)) };

export default defineConfig({
  oxc,
  test: {
    include: ['src/**/*.{test,spec}.ts'],
  },
});
