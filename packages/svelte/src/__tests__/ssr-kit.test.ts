// Node environment: no window/document, like a SvelteKit server render.
import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { LumiClient } from "@lumibase/sdk";

import { createLumiHandle, lumiForEvent } from "../kit";
import { fakeRealtime, flush, type Schema } from "./fakes";

describe("SSR safety", () => {
  it("imports without browser globals and never opens realtime on the server", async () => {
    expect(typeof window).toBe("undefined");
    const { itemsStore, realtimeStore, presenceStore } = await import("../index");
    const { fakeClient } = await import("./fakes");
    const { client } = fakeClient();
    const rt = fakeRealtime();
    const unsubs = [
      itemsStore(client, "posts", undefined, { live: true, realtime: rt.realtime }).subscribe(() => {}),
      realtimeStore(rt.realtime, "posts").subscribe(() => {}),
      presenceStore(rt.realtime, { collection: "posts" }).subscribe(() => {}),
    ];
    await flush();
    expect(rt.fake.connect).not.toHaveBeenCalled();
    expect(rt.fake.subscribe).not.toHaveBeenCalled();
    expect(rt.fake.presence).not.toHaveBeenCalled();
    unsubs.forEach((u) => u());
  });
});

describe("SvelteKit helpers", () => {
  it("lumiForEvent routes requests through event.fetch", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [], meta: { total: 0, limit: 0, offset: 0 } })));
    const client = lumiForEvent<Schema>({ fetch: fetch as unknown as typeof globalThis.fetch }, {
      url: "https://cms.test",
      siteId: "site_1",
      token: "server-token",
    });
    const { readItems } = await import("@lumibase/sdk");
    await client.request(readItems("posts"));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer server-token");
  });

  it("createLumiHandle puts a per-request client on locals and resolves", async () => {
    const config = vi.fn(() => ({ url: "https://cms.test", siteId: "site_1", token: "t" }));
    const handle = createLumiHandle(config);
    const event = { fetch: globalThis.fetch, locals: {} as { lumi?: LumiClient } };
    const response = new Response("ok");
    const out = await handle({ event, resolve: () => response });
    expect(out).toBe(response);
    expect(event.locals.lumi?.siteId).toBe("site_1");
    expect(config).toHaveBeenCalledWith(event);

    const other = { fetch: globalThis.fetch, locals: {} as Record<string, unknown> };
    await createLumiHandle({ url: "u", siteId: "s", token: "t" }, { localsKey: "cms" })({ event: other, resolve: () => response });
    expect(other.locals.cms).toBeDefined();
    expect(get).toBeTypeOf("function");
  });
});
