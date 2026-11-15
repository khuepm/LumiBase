// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { watchCollection } from "../client";
import { fakeRealtime } from "./fakes";

describe("watchCollection", () => {
  it("delivers events and cleans up on the returned stop", () => {
    const rt = fakeRealtime();
    const handler = vi.fn();
    const stop = watchCollection(rt.realtime, "posts", handler);
    rt.emit("posts");
    expect(handler).toHaveBeenCalledTimes(1);
    stop();
    stop();
    expect(rt.active("posts")).toBe(0);
    expect(rt.fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("cleans up on astro:before-swap (view transitions)", () => {
    const rt = fakeRealtime();
    watchCollection(rt.realtime, "posts", () => {});
    document.dispatchEvent(new Event("astro:before-swap"));
    expect(rt.active("posts")).toBe(0);
    expect(rt.fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("cleans up on pagehide", () => {
    const rt = fakeRealtime();
    watchCollection(rt.realtime, "posts", () => {}, { filter: { action: { _eq: "create" } } });
    expect(rt.fake.subscribe).toHaveBeenCalledWith("posts", expect.any(Function), { filter: { action: { _eq: "create" } } });
    window.dispatchEvent(new Event("pagehide"));
    expect(rt.active("posts")).toBe(0);
  });
});
