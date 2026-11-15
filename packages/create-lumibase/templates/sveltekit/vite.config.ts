import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * Cloudflare Pages via adapter-cloudflare: pages are server-rendered by a Pages
 * Function, so loads run on the server at request time and draft preview works
 * without a rebuild. The output (`.svelte-kit/cloudflare`) is what
 * `npm run deploy` uploads — see `wrangler.jsonc`.
 *
 * Want a fully static export instead (like the Astro starter)? Swap in
 * `@sveltejs/adapter-static`, add `export const prerender = true` to
 * `src/routes/+layout.server.ts`, and drop the preview routes — a static build
 * has no server to read the preview cookie. See the README.
 */
export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        // Runes mode for this project, leaving libraries alone.
        runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true),
      },
      adapter: adapter(),
    }),
  ],
});
