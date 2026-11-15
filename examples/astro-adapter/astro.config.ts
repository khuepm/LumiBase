// In a real project: `export default defineConfig({ integrations: [...] })`
// from 'astro/config'. The plain object keeps this smoke example free of an
// Astro install; Astro accepts it as-is.
import lumibase from '@lumibase/astro';

export default {
  integrations: [
    lumibase({
      url: 'http://127.0.0.1:1989',
      siteId: 'site_demo',
      // The server token is read from this env var at runtime, never inlined.
      tokenEnv: 'LUMIBASE_TOKEN',
    }),
  ],
};
