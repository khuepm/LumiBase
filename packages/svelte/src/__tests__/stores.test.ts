// @vitest-environment jsdom
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { get } from "svelte/store";
import type { ItemRow, ListItemsResponse } from "@lumibase/sdk";

import {
  defineLumiStores,
  itemsStore,
  itemStore,
  lumiPresence,
  presenceStore,
  realtimeStore,
  type AsyncValue,
} from "../index";
import { fakeClient, fakeRealtime, flush, row, type PostFields } from "./fakes";

describe("itemsStore", () => {
  it("fetches through readItems on first subscribe and types the rows", async () => {
    const { client, calls } = fakeClient();
    const store = itemsStore(client, "posts", { limit: 3 });
    expect(calls).toEqual([]); // lazy until subscribed
    const values: AsyncValue<ListItemsResponse<PostFields>>[] = [];
    const unsub = store.subscribe((v) => values.push(v));
    await flush();
    expect(calls).toEqual(["/api/v1/items/posts?limit=3"]);
    const last = values.at(-1)!;
    expect(last.loading).toBe(false);
    expect(last.data?.data[0]?.data.title).toBe("Hello");
    expectTypeOf(last.data).toEqualTypeOf<ListItemsResponse<PostFields> | null>();
    unsub();
  });

  it("captures errors in the store value", async () => {
    const { client } = fakeClient(() => {
      throw new Error("boom");
    });
    const store = itemsStore(client, "posts");
    const unsub = store.subscribe(() => {});
    await flush();
    expect(get(store).error).toBeInstanceOf(Error);
    unsub();
  });

  it("skips the first fetch with initialData", async () => {
    const { client, calls } = fakeClient();
    const initialData = { data: [row("x", "seed")], meta: { total: 1, limit: 1, offset: 0 } };
    const store = itemsStore(client, "posts", undefined, { initialData });
    const unsub = store.subscribe(() => {});
    await flush();
    expect(calls).toEqual([]);
    expect(get(store).data?.data[0]?.data.title).toBe("seed");
    unsub();
  });

  it("live: subscribes while observed, re-fetches on events, cleans up on last unsubscribe", async () => {
    const { client, calls } = fakeClient();
    const rt = fakeRealtime();
    const store = itemsStore(client, "posts", undefined, { live: { filter: { action: { _eq: "create" } } }, realtime: rt.realtime });
    const a = store.subscribe(() => {});
    const b = store.subscribe(() => {});
    await flush();
    expect(rt.active("posts")).toBe(1);
    expect(rt.fake.connect).toHaveBeenCalledTimes(1);
    rt.emit("posts");
    await flush();
    expect(calls).toHaveLength(2);
    a();
    expect(rt.active("posts")).toBe(1);
    b();
    expect(rt.active("posts")).toBe(0);
    expect(rt.fake.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("itemStore", () => {
  it("reads one row and only re-fetches for its own id", async () => {
    const { client, calls } = fakeClient(() => [row("p1", "One"), row("p2", "Two")]);
    const rt = fakeRealtime();
    const store = itemStore(client, "posts", "p2", { live: true, realtime: rt.realtime });
    const unsub = store.subscribe(() => {});
    await flush();
    expect(get(store).data?.data.title).toBe("Two");
    expectTypeOf(get(store).data).toEqualTypeOf<ItemRow<PostFields> | null>();
    rt.emit("posts", "p1");
    await flush();
    expect(calls).toHaveLength(1);
    rt.emit("posts", "p2");
    await flush();
    expect(calls).toHaveLength(2);
    unsub();
    expect(rt.active("posts")).toBe(0);
  });
});

describe("realtimeStore / presenceStore", () => {
  it("emits events and unsubscribes on destroy", () => {
    const rt = fakeRealtime();
    const store = realtimeStore(rt.realtime, "posts");
    const seen = vi.fn();
    const unsub = store.subscribe(seen);
    rt.emit("posts", "p9");
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "p9" }));
    unsub();
    expect(rt.active("posts")).toBe(0);
    expect(rt.fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("announces presence and clears it on destroy", () => {
    const rt = fakeRealtime();
    const store = presenceStore(rt.realtime, { collection: "posts", itemId: "p1" });
    const unsub = store.subscribe(() => {});
    rt.emitPresence([{ sessionId: "s", userId: "u", lastSeen: "now" }]);
    expect(get(store)).toHaveLength(1);
    unsub();
    expect(rt.presenceListenerCount()).toBe(0);
    expect(rt.presenceCalls.at(-1)).toEqual({});
  });
});

describe("lumiPresence action", () => {
  it("announces, updates and clears on destroy", () => {
    const rt = fakeRealtime();
    const node = document.createElement("div");
    const handle = lumiPresence(node, { realtime: rt.realtime, collection: "posts", itemId: "a" })!;
    handle.update!({ realtime: rt.realtime, collection: "posts", itemId: "b" });
    handle.destroy!();
    expect(rt.presenceCalls).toEqual([{ collection: "posts", itemId: "a" }, { collection: "posts", itemId: "b" }, {}]);
    expect(rt.fake.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("defineLumiStores", () => {
  it("binds the schema so collection names are checked", () => {
    const { client } = fakeClient();
    const lumi = defineLumiStores(client);
    const posts = lumi.items("posts");
    expectTypeOf(get(posts).data).toEqualTypeOf<ListItemsResponse<PostFields> | null>();
    // @ts-expect-error — not a collection of the schema
    lumi.items("nope");
  });
});
