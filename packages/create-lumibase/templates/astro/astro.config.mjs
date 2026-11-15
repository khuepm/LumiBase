// @ts-check
import { defineConfig, envField } from 'astro/config';

/**
 * Static output: `astro build` writes plain HTML/CSS/JS to `dist/`, which
 * Cloudflare Pages (or any static host) serves as-is. Content is fetched from
 * LumiBase once, at build time; to pick up a publish, rebuild — see the README
 * section on deploy hooks.
 *
 * Every LumiBase variable is `context: 'server'`, so Astro will not inline it
 * into anything that runs in the browser. The secrets are `access: 'secret'`
 * on top of that, which keeps them out of the generated client env entirely.
 */
export default defineConfig({
  output: 'static',
  // Set `site` to your production URL for canonical links and sitemaps:
  // site: 'https://example.pages.dev',
  env: {
    schema: {
      LUMIBASE_URL: envField.string({ context: 'server', access: 'public', optional: true }),
      LUMIBASE_SITE_ID: envField.string({
        context: 'server',
        access: 'public',
        optional: true,
        default: '__default__',
      }),
      LUMIBASE_PUBLISHABLE_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
      LUMIBASE_PREVIEW: envField.boolean({ context: 'server', access: 'public', optional: true, default: false }),
      LUMIBASE_PREVIEW_TOKEN: envField.string({ context: 'server', access: 'secret', optional: true }),
    },
  },
});
