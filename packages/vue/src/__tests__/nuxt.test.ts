import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import { RealtimeClient } from "@lumibase/sdk";

import lumibase, { NUXT_AUTO_IMPORTS, pluginPath, type ImportSource, type NuxtLike } from "../nuxt";
import lumibaseNuxtPlugin, { type NuxtAppLike } from "../nuxt-plugin";

function fakeNuxt(extra: Partial<NuxtLike["options"]> = {}) {
  const hooks = new Map<string, (sources: ImportSource[]) => void>();
  const nuxt: NuxtLike = {
    options: { runtimeConfig: { public: {} }, plugins: [], build: { transpile: [] }, ...extra },
    hook: (name, fn) => hooks.set(name, fn),
  };
  return { nuxt, hooks };
}

describe("Nuxt module", () => {
  it("is a function module with meta Nuxt can read", async () => {
    expect(lumibase).toBeTypeOf("function");
    expect(await lumibase.getMeta()).toMatchObject({ name: "@lumibase/vue", configKey: "lumibase" });
  });

  it("writes public config, keeps the token private, registers the plugin and auto-imports", () => {
    const { nuxt, hooks } = fakeNuxt({ lumibase: { url: "https://cms.test", siteId: "site_1" } });
    lumibase({ realtime: true }, nuxt);

    expect(nuxt.options.runtimeConfig.lumibase).toEqual({ token: "" });
    expect(nuxt.options.runtimeConfig.public?.lumibase).toEqual({
      url: "https://cms.test",
      siteId: "site_1",
      publicToken: "",
      realtime: true,
    });
    expect(JSON.stringify(nuxt.options.runtimeConfig.public)).not.toContain("token\":\"secret");
    expect(nuxt.options.build.transpile).toContain("@lumibase/vue");
    expect(nuxt.options.plugins).toEqual([{ src: pluginPath(), mode: "all" }]);
    expect(existsSync(pluginPath())).toBe(true);

    const sources: ImportSource[] = [];
    hooks.get("imports:sources")!(sources);
    expect(sources).toEqual(NUXT_AUTO_IMPORTS);
  });

  it("does not overwrite runtime config the app already set", () => {
    const { nuxt } = fakeNuxt({
      runtimeConfig: { lumibase: { token: "from-env" }, public: { lumibase: { url: "https://override.test" } } },
    });
    lumibase({ url: "https://module.test", siteId: "s" }, nuxt);
    expect(nuxt.options.runtimeConfig.lumibase).toEqual({ token: "from-env" });
    expect((nuxt.options.runtimeConfig.public?.lumibase as { url: string }).url).toBe("https://override.test");
  });

  it("can skip auto-imports", () => {
    const { nuxt, hooks } = fakeNuxt();
    lumibase({ autoImports: false }, nuxt);
    expect(hooks.size).toBe(0);
  });

  it("resolves the plugin as .js next to a built module", () => {
    expect(pluginPath("file:///pkg/dist/nuxt.js")).toBe("/pkg/dist/nuxt-plugin.js");
    expect(pluginPath("file:///pkg/src/nuxt.ts")).toBe("/pkg/src/nuxt-plugin.ts");
  });
});

describe("Nuxt runtime plugin", () => {
  function nuxtApp(server: boolean, realtime = true): NuxtAppLike {
    return {
      vueApp: createApp({ render: () => null }),
      ...(server ? { ssrContext: {} } : {}),
      $config: {
        lumibase: { token: "server-secret" },
        public: { lumibase: { url: "https://cms.test", siteId: "site_1", publicToken: "pub", realtime } },
      },
    };
  }

  it("uses the private token on the server and never builds realtime there", () => {
    const { provide } = lumibaseNuxtPlugin(nuxtApp(true));
    expect(provide.lumi.token).toBe("server-secret");
    expect(provide.lumi.siteId).toBe("site_1");
    expect(provide.lumiRealtime).toBeNull();
  });

  it("uses only the public token in the browser and builds an unconnected realtime client", () => {
    const app = nuxtApp(false);
    const spy = vi.spyOn(RealtimeClient.prototype, "connect");
    const { provide } = lumibaseNuxtPlugin(app);
    expect(provide.lumi.token).toBe("pub");
    expect(provide.lumiRealtime).toBeInstanceOf(RealtimeClient);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("warns when url/siteId are missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    lumibaseNuxtPlugin({ vueApp: createApp({ render: () => null }), $config: { public: {} } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
