// Nuxt variant. In a real Nuxt app wrap this in `defineNuxtConfig(...)`; the
// plain object keeps this smoke example free of a Nuxt install.
//
// Secrets stay in env, never here:
//   NUXT_LUMIBASE_TOKEN=...            (server-only, private runtime config)
//   NUXT_PUBLIC_LUMIBASE_URL=...       (optional overrides of the values below)
import type { LumiBaseNuxtOptions } from '@lumibase/vue/nuxt';

const lumibase: Partial<LumiBaseNuxtOptions> = {
  url: 'http://127.0.0.1:1989',
  siteId: 'site_demo',
  realtime: true,
};

export default {
  modules: ['@lumibase/vue/nuxt'],
  lumibase,
};

// pages/index.vue (auto-imported: useItems, useLumiClient, readItems, …)
//
//   <script setup lang="ts">
//   const lumi = useLumiClient()
//   const { data } = await useAsyncData('posts', () => lumi.request(readItems('posts', { limit: 10 })))
//   // Hydrate with the SSR payload, then stay live in the browser:
//   const { items } = useItems('posts', { limit: 10 }, { initialData: data.value, live: true })
//   </script>
