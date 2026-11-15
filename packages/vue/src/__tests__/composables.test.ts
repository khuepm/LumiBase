// @vitest-environment jsdom
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createApp, defineComponent, effectScope, h, nextTick, ref } from "vue";
import type { ItemRow, ListItemsResponse } from "@lumibase/sdk";

import { createLumiBase, defineLumiComposables, useItem, useItems, usePresence, useRealtime } from "../index";
import { fakeClient, fakeRealtime, flush, row, type PostFields, type Schema } from "./fakes";

function mountWith(plugin: ReturnType<typeof createLumiBase>, setup: () => unknown) {
  const app = createApp(defineComponent({ setup: () => (setup(), () => h("div")) }));
  app.use(plugin);
  app.mount(document.createElement("div"));
  return app;
}

describe("useItems", () => {
  it("fetches through the SDK's readItems and exposes typed rows", async () => {
    const { client, calls } = fakeClient();
    let state!: ReturnType<typeof useItems<Schema, "posts">>;
    mountWith(createLumiBase({ client }), () => {
      state = useItems("posts", { limit: 5, sort: ["-title"] }, { client });
    });
    await flush();
    expect(calls).toEqual(["/api/v1/items/posts?sort=-title&limit=5"]);
    expect(state.items.value.map((r) => r.data.title)).toEqual(["Hello"]);
    expect(state.pending.value).toBe(false);
    expectTypeOf(state.items.value).toEqualTypeOf<ItemRow<PostFields>[]>();
    expectTypeOf(state.data.value).toEqualTypeOf<ListItemsResponse<PostFields> | null>();
  });

  it("re-fetches when reactive params change", async () => {
    const { client, calls } = fakeClient();
    const limit = ref(1);
    mountWith(createLumiBase({ client }), () => {
      useItems("posts", () => ({ limit: limit.value }), { client });
    });
    await flush();
    limit.value = 2;
    await nextTick();
    await flush();
    expect(calls).toEqual(["/api/v1/items/posts?limit=1", "/api/v1/items/posts?limit=2"]);
  });

  it("skips the first fetch when initialData is given", async () => {
    const { client, calls } = fakeClient();
    const initial = { data: [row("x", "ssr")], meta: { total: 1, limit: 1, offset: 0 } };
    let titles: string[] = [];
    mountWith(createLumiBase({ client }), () => {
      const s = useItems("posts", undefined, { client, initialData: initial });
      titles = s.items.value.map((r) => r.data.title);
    });
    await flush();
    expect(calls).toEqual([]);
    expect(titles).toEqual(["ssr"]);
  });

  it("captures errors instead of throwing", async () => {
    const { client } = fakeClient(() => {
      throw new Error("boom");
    });
    let error: unknown;
    let state!: ReturnType<typeof useItems<Schema, "posts">>;
    mountWith(createLumiBase({ client }), () => {
      state = useItems("posts", undefined, { client });
    });
    await flush();
    error = state.error.value;
    expect(error).toBeInstanceOf(Error);
  });

  it("live: subscribes on mount, re-fetches on events, cleans up on unmount", async () => {
    const { client, calls } = fakeClient();
    const rt = fakeRealtime();
    const app = mountWith(createLumiBase({ client, realtime: rt.realtime }), () => {
      useItems("posts", undefined, { live: { filter: { action: { _eq: "update" } } } });
    });
    await flush();
    expect(rt.fake.connect).toHaveBeenCalledTimes(1);
    expect(rt.active("posts")).toBe(1);
    expect(rt.fake.subscribe).toHaveBeenCalledWith("posts", expect.any(Function), {
      filter: { action: { _eq: "update" } },
    });

    rt.emit("posts");
    await flush();
    expect(calls).toHaveLength(2);

    app.unmount();
    expect(rt.active("posts")).toBe(0);
    expect(rt.fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("live: a burst of events during a fetch collapses into one follow-up fetch", async () => {
    const { client, calls } = fakeClient();
    const rt = fakeRealtime();
    mountWith(createLumiBase({ client, realtime: rt.realtime }), () => {
      useItems("posts", undefined, { live: true });
    });
    await flush();
    rt.emit("posts");
    rt.emit("posts");
    rt.emit("posts");
    await flush();
    await flush();
    expect(calls).toHaveLength(3); // initial + running + one coalesced follow-up
  });
});

describe("useItem", () => {
  it("reads one row (unwrapped) and re-fetches only for its own id when live", async () => {
    const { client, calls } = fakeClient(() => [row("p1", "One"), row("p2", "Two")]);
    const rt = fakeRealtime();
    let state!: ReturnType<typeof useItem<Schema, "posts">>;
    const app = mountWith(createLumiBase({ client, realtime: rt.realtime }), () => {
      state = useItem("posts", "p2", { client, live: true });
    });
    await flush();
    expect(state.data.value?.data.title).toBe("Two");
    expectTypeOf(state.data.value).toEqualTypeOf<ItemRow<PostFields> | null>();

    rt.emit("posts", "p1");
    await flush();
    expect(calls).toHaveLength(1);
    rt.emit("posts", "p2");
    await flush();
    expect(calls).toHaveLength(2);

    app.unmount();
    expect(rt.active("posts")).toBe(0);
  });
});

describe("useRealtime", () => {
  it("shares one connection across components and releases it after the last unmount", async () => {
    const { client } = fakeClient();
    const rt = fakeRealtime();
    const plugin = createLumiBase({ client, realtime: rt.realtime });
    const one = mountWith(plugin, () => useRealtime("posts", () => {}));
    const two = mountWith(plugin, () => useRealtime("posts", () => {}));
    expect(rt.fake.connect).toHaveBeenCalledTimes(1);
    expect(rt.active("posts")).toBe(2);
    one.unmount();
    expect(rt.fake.disconnect).not.toHaveBeenCalled();
    two.unmount();
    expect(rt.fake.disconnect).toHaveBeenCalledTimes(1);
    expect(rt.active("posts")).toBe(0);
  });

  it("re-subscribes when a reactive collection changes", async () => {
    const { client } = fakeClient();
    const rt = fakeRealtime();
    const collection = ref("posts");
    const app = mountWith(createLumiBase({ client, realtime: rt.realtime }), () => useRealtime(collection, () => {}));
    collection.value = "pages";
    await nextTick();
    expect(rt.active("posts")).toBe(0);
    expect(rt.active("pages")).toBe(1);
    app.unmount();
    expect(rt.active("pages")).toBe(0);
  });

  it("works in a bare effect scope and stops on scope dispose", () => {
    const rt = fakeRealtime();
    const scope = effectScope();
    const handler = vi.fn();
    scope.run(() => useRealtime("posts", handler, { realtime: rt.realtime }));
    rt.emit("posts");
    expect(handler).toHaveBeenCalledTimes(1);
    scope.stop();
    expect(rt.active("posts")).toBe(0);
    expect(rt.fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("is a no-op without a realtime client", () => {
    const { client } = fakeClient();
    const app = mountWith(createLumiBase({ client }), () => {
      expect(useRealtime("posts", () => {}).stop).toBeTypeOf("function");
    });
    app.unmount();
  });
});

describe("usePresence", () => {
  it("announces presence, exposes peers, and clears everything on unmount", () => {
    const { client } = fakeClient();
    const rt = fakeRealtime();
    let users!: ReturnType<typeof usePresence>["users"];
    const app = mountWith(createLumiBase({ client, realtime: rt.realtime }), () => {
      users = usePresence({ collection: "posts", itemId: "p1" }).users;
    });
    expect(rt.presenceCalls).toEqual([{ collection: "posts", itemId: "p1" }]);
    rt.emitPresence([{ sessionId: "s", userId: "u", lastSeen: "now" }]);
    expect(users.value).toHaveLength(1);
    app.unmount();
    expect(rt.presenceListenerCount()).toBe(0);
    expect(rt.presenceCalls.at(-1)).toEqual({});
    expect(rt.fake.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("extension point", () => {
  it("runs extension setup in the browser and its cleanup on app unmount", () => {
    const { client } = fakeClient();
    const cleanup = vi.fn();
    const setup = vi.fn(() => cleanup);
    const app = mountWith(createLumiBase({ client, extensions: [{ name: "visual-editing", setup }] }), () => {});
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ client }));
    app.unmount();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("defineLumiComposables", () => {
  it("binds the schema so collection names are checked", () => {
    const typed = defineLumiComposables<Schema>();
    expectTypeOf(typed.useItems).parameter(0).toEqualTypeOf<import("vue").MaybeRefOrGetter<"posts">>();
    const { client } = fakeClient();
    mountWith(createLumiBase({ client }), () => {
      const s = typed.useItems("posts");
      expectTypeOf<(typeof s.items.value)[number]["data"]["views"]>().toEqualTypeOf<number>();
      // @ts-expect-error — not a collection of Schema
      typed.useItems("nope");
    });
  });

  it("throws a helpful error when no client was provided", () => {
    const app = createApp(
      defineComponent({
        setup() {
          expect(() => useItems("posts")).toThrow(/No LumiBase client provided/);
          return () => h("div");
        },
      }),
    );
    app.mount(document.createElement("div"));
  });
});
