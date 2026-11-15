// Node environment: what Astro's build and SSR see.
import { describe, expect, it } from "vitest";

import { fakeRealtime } from "./fakes";

describe("SSR safety", () => {
  it("imports every entry without browser globals", async () => {
    expect(typeof window).toBe("undefined");
    await expect(import("../index")).resolves.toBeDefined();
    await expect(import("../loader")).resolves.toBeDefined();
    await expect(import("../client")).resolves.toBeDefined();
  });

  it("watchCollection is a no-op on the server", async () => {
    const { watchCollection } = await import("../client");
    const rt = fakeRealtime();
    watchCollection(rt.realtime, "posts", () => {})();
    expect(rt.fake.connect).not.toHaveBeenCalled();
    expect(rt.fake.subscribe).not.toHaveBeenCalled();
  });
});
