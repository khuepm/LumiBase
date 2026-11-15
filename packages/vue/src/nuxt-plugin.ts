/**
 * Runtime plugin registered by `@lumibase/vue/nuxt`. Runs on the server per
 * request and once in the browser.
 *
 * It does not import `#app`: a Nuxt plugin may be a plain function of the
 * Nuxt app (`defineNuxtPlugin` returns such functions unchanged), and staying
 * off the virtual modules keeps this file type-checkable and testable without
 * a Nuxt build.
 */
import type { App } from "vue";
import { createLumiClient, RealtimeClient, type LumiClient } from "@lumibase/sdk";

import { createLumiBase } from "./context";
import type { LumiBasePublicRuntimeConfig } from "./nuxt";

export interface NuxtAppLike {
  vueApp: App;
  /** Present only while rendering on the server. */
  ssrContext?: unknown;
  $config: {
    /** Private runtime config — only readable on the server. */
    lumibase?: { token?: string };
    public: { lumibase?: Partial<LumiBasePublicRuntimeConfig> };
  };
}

export default function lumibaseNuxtPlugin(nuxtApp: NuxtAppLike): {
  provide: { lumi: LumiClient; lumiRealtime: RealtimeClient | null };
} {
  const pub = nuxtApp.$config.public.lumibase ?? {};
  const onServer = nuxtApp.ssrContext !== undefined;
  // Never touch the private key in the browser: it is not there, and Nuxt
  // warns on the attempt.
  const token = (onServer ? nuxtApp.$config.lumibase?.token : undefined) || pub.publicToken || "";
  const url = pub.url ?? "";
  const siteId = pub.siteId ?? "";

  if (!url || !siteId) {
    console.warn("[@lumibase/vue] lumibase.url / lumibase.siteId are not configured; requests will fail.");
  }

  const client = createLumiClient({ url, siteId, token });
  // The socket is never opened here; composables connect on mount.
  const realtime = !onServer && pub.realtime ? new RealtimeClient({ baseUrl: url, siteId, token }) : null;

  nuxtApp.vueApp.use(createLumiBase({ client, realtime }));
  return { provide: { lumi: client, lumiRealtime: realtime } };
}
