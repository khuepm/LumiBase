// Runs in the node environment: no window, no document.
import { describe, expect, it } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";
import { renderToString } from "vue/server-renderer";

import { fakeClient, fakeRealtime } from "./fakes";

describe("SSR", () => {
  it("imports without touching browser globals", async () => {
    expect(typeof window).toBe("undefined");
    const mod = await import("../index");
    expect(mod.useItems).toBeTypeOf("function");
  });

  it("awaits the first fetch via onServerPrefetch and never opens realtime", async () => {
    const { createLumiBase, useItems, usePresence } = await import("../index");
    const { client, calls } = fakeClient();
    const rt = fakeRealtime();
    const app = createSSRApp(
      defineComponent({
        setup() {
          const { items } = useItems("posts", undefined, { client, live: true });
          usePresence({ collection: "posts" });
          return () => h("ul", items.value.map((r) => h("li", r.data.title)));
        },
      }),
    );
    app.use(createLumiBase({ client, realtime: rt.realtime }));
    const html = await renderToString(app);
    expect(html).toBe("<ul><li>Hello</li></ul>");
    expect(calls).toHaveLength(1);
    expect(rt.fake.connect).not.toHaveBeenCalled();
    expect(rt.fake.subscribe).not.toHaveBeenCalled();
    expect(rt.fake.presence).not.toHaveBeenCalled();
  });
});
