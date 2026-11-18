import { describe, expect, it, vi } from "vitest";

import { createLumiClient } from "../client";
import { legacyRest } from "../rest/legacy";

/** SDK coverage for video state / retry / playback and caption tracks (#871). */

function setup() {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ data: null }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createLumiClient({
    url: "https://api.example.test",
    token: "tok",
    siteId: "site_1",
    fetcher: fetcher as unknown as typeof fetch,
  }).with(legacyRest());
  return { client, calls };
}

describe("files.video / files.captions", () => {
  it("hits the video endpoints with encoded ids", async () => {
    const { client, calls } = setup();
    await client.files.video.get("a/b");
    await client.files.video.retry("v1");
    await client.files.video.playback("v1");
    expect(calls.map((c) => [c.init?.method ?? "GET", c.url.pathname])).toEqual([
      ["GET", "/api/v1/files/a%2Fb/video"],
      ["POST", "/api/v1/files/v1/video/retry"],
      ["GET", "/api/v1/files/v1/video/playback"],
    ]);
  });

  it("lists, adds, updates and removes caption tracks", async () => {
    const { client, calls } = setup();
    await client.files.captions.list("v1");
    await client.files.captions.add("v1", { captionFileId: "c1", locale: "en", kind: "captions", isDefault: true });
    await client.files.captions.update("v1", "t1", { label: "English (CC)" });
    await client.files.captions.remove("v1", "t1");
    expect(calls.map((c) => [c.init?.method ?? "GET", c.url.pathname, c.init?.body ?? null])).toEqual([
      ["GET", "/api/v1/files/v1/captions", null],
      ["POST", "/api/v1/files/v1/captions", JSON.stringify({ captionFileId: "c1", locale: "en", kind: "captions", isDefault: true })],
      ["PATCH", "/api/v1/files/v1/captions/t1", JSON.stringify({ label: "English (CC)" })],
      ["DELETE", "/api/v1/files/v1/captions/t1", null],
    ]);
  });
});
