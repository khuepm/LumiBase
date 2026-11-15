import { describe, expect, it, vi } from "vitest";
import { createLumiClient } from "@lumibase/sdk";

import lumibase, { lumibaseVitePlugin, VIRTUAL_MODULE_ID, VIRTUAL_MODULE_TYPES, virtualModuleSource } from "../index";
import { lumibaseLoader, type LoaderContextLike } from "../loader";
import { row, type Schema } from "./fakes";

const opts = { url: "https://cms.test", siteId: "site_1" };

describe("integration", () => {
  it("adds the virtual-module plugin, page scripts and types", () => {
    const integration = lumibase({ ...opts, pageScripts: ["@acme/overlay"] });
    const updateConfig = vi.fn();
    const injectScript = vi.fn();
    integration.hooks["astro:config:setup"]({ updateConfig, injectScript });
    const plugins = updateConfig.mock.calls[0]![0].vite.plugins as Array<{ name: string }>;
    expect(plugins.map((p) => p.name)).toEqual(["lumibase:virtual-module"]);
    expect(injectScript).toHaveBeenCalledWith("page", 'import "@acme/overlay";');

    const injectTypes = vi.fn();
    integration.hooks["astro:config:done"]({ injectTypes });
    expect(injectTypes).toHaveBeenCalledWith({ filename: "lumibase.d.ts", content: VIRTUAL_MODULE_TYPES });
    // Astro < 5 has no injectTypes — must not throw.
    expect(() => integration.hooks["astro:config:done"]({})).not.toThrow();
  });

  it("rejects missing config and non-identifier env names", () => {
    expect(() => lumibase({ url: "", siteId: "s" })).toThrow(/required/);
    expect(() => lumibase({ ...opts, tokenEnv: "X; alert(1)" })).toThrow(/identifier/);
  });

  it("generates a module that references the env var name, never a token value", () => {
    const src = virtualModuleSource({ ...opts, tokenEnv: "CMS_TOKEN" });
    expect(src).toContain('getSecret("CMS_TOKEN")');
    expect(src).toContain('from "astro:env/server"');
    // Vite statically replaces import.meta.env.X at build time: an SSR build
    // would carry the build machine's token in dist/server.
    expect(src).not.toContain("import.meta.env");
    expect(src).toContain('"https://cms.test"');
    expect(src).toContain('from "@lumibase/sdk"');
  });

  it("escapes config values so they cannot break out of the generated literal", () => {
    const url = "https://cms.example.com/</script><script>alert(1)</script>\u2028x";
    const src = virtualModuleSource({ ...opts, url, siteId: "site_1" });
    expect(src).not.toContain("</script>");
    expect(src).not.toContain("\u2028");
    // The literal still evaluates to the exact configured value.
    const literal = /url: ("(?:[^"\\]|\\.)*")/.exec(src)?.[1];
    expect(literal && JSON.parse(literal)).toBe(url);
  });

  it("serves the virtual module to SSR and refuses client bundles", () => {
    const plugin = lumibaseVitePlugin(opts);
    const id = plugin.resolveId(VIRTUAL_MODULE_ID)!;
    expect(plugin.resolveId("other")).toBeUndefined();
    expect(plugin.load.call(undefined, id, { ssr: true })).toContain("createLumiClient");
    expect(() => plugin.load.call(undefined, id, {})).toThrow(/server-only/);
    // Vite environments API (Vite ≥ 6)
    expect(plugin.load.call({ environment: { config: { consumer: "server" } } }, id)).toContain("createLumiClient");
    expect(() => plugin.load.call({ environment: { config: { consumer: "client" } } }, id, { ssr: true })).toThrow(/server-only/);
    expect(plugin.load.call(undefined, "other", { ssr: true })).toBeUndefined();
  });
});

function context() {
  const entries = new Map<string, { id: string; data: Record<string, unknown>; digest?: string | number }>();
  const ctx: LoaderContextLike = {
    store: {
      clear: vi.fn(() => entries.clear()),
      set: (entry) => (entries.set(entry.id, entry), true),
    },
    logger: { info: vi.fn() },
    parseData: async ({ data }) => data,
    generateDigest: (data) => JSON.stringify(data).length.toString(),
  };
  return { ctx, entries };
}

describe("content loader", () => {
  it("pages through readItems and stores rows by id", async () => {
    const all = Array.from({ length: 5 }, (_, i) => row(`p${i}`, `T${i}`));
    const urls: string[] = [];
    const client = createLumiClient<Schema>({
      url: "https://cms.test",
      token: "t",
      siteId: "site_1",
      fetcher: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        urls.push(url.pathname + url.search);
        const limit = Number(url.searchParams.get("limit"));
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return new Response(JSON.stringify({ data: all.slice(offset, offset + limit) }));
      }) as typeof fetch,
    });
    const loader = lumibaseLoader({ client, collection: "posts", params: { status: "published" }, pageSize: 2 });
    const { ctx, entries } = context();
    await loader.load(ctx);
    expect(urls).toEqual([
      "/api/v1/items/posts?limit=2&offset=0&status=published&meta=none",
      "/api/v1/items/posts?limit=2&offset=2&status=published&meta=none",
      "/api/v1/items/posts?limit=2&offset=4&status=published&meta=none",
    ]);
    expect([...entries.keys()]).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect((entries.get("p3")!.data as { data: { title: string } }).data.title).toBe("T3");
    expect(entries.get("p3")!.digest).toBeDefined();
  });

  it("keeps existing entries when a fetch fails", async () => {
    const loader = lumibaseLoader({
      client: { url: "https://cms.test", token: "t", siteId: "s", fetcher: (async () => new Response("no", { status: 500 })) as typeof fetch },
      collection: "posts",
    });
    const { ctx } = context();
    await expect(loader.load(ctx)).rejects.toThrow();
    expect(ctx.store.clear).not.toHaveBeenCalled();
  });

  it("validates pageSize and passes a schema through", () => {
    expect(() => lumibaseLoader({ client: { url: "u", siteId: "s", token: "t" }, collection: "posts", pageSize: 0 })).toThrow();
    const schema = { kind: "zod-like" };
    expect(lumibaseLoader({ client: { url: "u", siteId: "s", token: "t" }, collection: "posts", schema }).schema).toBe(schema);
  });
});
