import { inject, type App, type InjectionKey } from "vue";
import type { DefaultSchema, LumiClient, RealtimeClient } from "@lumibase/sdk";

/**
 * Extension hook — the documented seam for features that layer on top of the
 * adapter without the adapter knowing them. Visual editing (V03,
 * `@lumibase/visual-editing`, issue #681) is expected to plug in here once it
 * exists; nothing in this package implements or assumes it.
 *
 * `setup` runs once, in the browser only, when the plugin is installed on an
 * app. Whatever it returns is called when that app unmounts.
 */
export interface LumiExtension<TSchema extends DefaultSchema = DefaultSchema> {
  name: string;
  setup(ctx: LumiBaseContext<TSchema>): void | (() => void);
}

export interface LumiBaseContext<TSchema extends DefaultSchema = DefaultSchema> {
  client: LumiClient<TSchema>;
  /**
   * Optional realtime client. Never connected at install time — the first
   * composable that needs it connects it (browser only), and the last one to
   * unmount disconnects it (see `retainRealtime` in `@lumibase/sdk`).
   */
  realtime?: RealtimeClient | null;
}

export interface LumiBasePluginOptions<TSchema extends DefaultSchema = DefaultSchema>
  extends LumiBaseContext<TSchema> {
  extensions?: LumiExtension<TSchema>[];
}

export const LumiBaseKey: InjectionKey<LumiBaseContext<DefaultSchema>> = Symbol("lumibase");

/** True in a browser. Evaluated per call — never at import — so SSR imports are safe. */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Vue plugin: `app.use(createLumiBase({ client, realtime }))`. Installing does
 * no I/O, so it is safe on the server.
 */
export function createLumiBase<TSchema extends DefaultSchema>(
  options: LumiBasePluginOptions<TSchema>,
): { install(app: App): void } {
  return {
    install(app: App) {
      const ctx: LumiBaseContext<TSchema> = { client: options.client, realtime: options.realtime ?? null };
      app.provide(LumiBaseKey, ctx as unknown as LumiBaseContext<DefaultSchema>);

      const extensions = options.extensions ?? [];
      if (extensions.length === 0 || !isBrowser()) return;

      const cleanups: Array<() => void> = [];
      for (const extension of extensions) {
        const cleanup = extension.setup(ctx);
        if (typeof cleanup === "function") cleanups.push(cleanup);
      }
      // `app.onUnmount` only exists from Vue 3.5; wrapping keeps ^3.3 working.
      const unmount = app.unmount.bind(app);
      app.unmount = () => {
        for (const cleanup of cleanups.splice(0)) cleanup();
        unmount();
      };
    },
  };
}

/** The context provided by {@link createLumiBase}; throws when it is missing. */
export function useLumiBase<TSchema extends DefaultSchema = DefaultSchema>(): LumiBaseContext<TSchema> {
  const ctx = inject(LumiBaseKey, null);
  if (!ctx) {
    throw new Error(
      "[@lumibase/vue] No LumiBase client provided. Call app.use(createLumiBase({ client })) " +
        "or add '@lumibase/vue/nuxt' to your Nuxt modules.",
    );
  }
  return ctx as unknown as LumiBaseContext<TSchema>;
}

/** The provided `LumiClient`, typed with your schema. */
export function useLumiClient<TSchema extends DefaultSchema = DefaultSchema>(): LumiClient<TSchema> {
  return useLumiBase<TSchema>().client;
}
