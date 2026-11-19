import { describe, expect, it, vi } from "vitest";

import { createLumiClient } from "../client";
import { legacyRest } from "../rest/legacy";

/** SDK coverage for epic #668: cohorts (#688), modified filter (#687), duplicate (#689), saveRevision (#693). */

function setup() {
  const calls: Array<{ url: URL; method: string; body: string | null }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), method: init?.method ?? "GET", body: (init?.body as string) ?? null });
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createLumiClient({
    url: "https://api.example.test/",
    token: "tok",
    siteId: "site_1",
    fetcher: fetcher as unknown as typeof fetch,
  }).with(legacyRest());
  return { client, calls };
}

describe("items editorial options", () => {
  it("sends publicationState and modifiedSincePublish on list", async () => {
    const { client, calls } = setup();
    await client.items("posts").list({ publicationState: "preview", modifiedSincePublish: true });
    expect(calls[0]!.url.searchParams.get("publicationState")).toBe("preview");
    expect(calls[0]!.url.searchParams.get("modifiedSincePublish")).toBe("true");
  });

  it("posts duplicate options to /duplicate", async () => {
    const { client, calls } = setup();
    await client.items("posts").duplicate("p 1", { relations: "deep", translations: false });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/api/v1/items/posts/p%201/duplicate");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ relations: "deep", translations: false });
  });

  it("patchWithoutRevision sets saveRevision=false", async () => {
    const { client, calls } = setup();
    await client.items("posts").patchWithoutRevision("p1", { data: { title: "x" } });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.searchParams.get("saveRevision")).toBe("false");
  });

  it("posts reorder targets to /reorder", async () => {
    const { client, calls } = setup();
    await client.items("posts").reorder("p1", { before: "p0" });
    expect(calls[0]!.url.pathname).toBe("/api/v1/items/posts/p1/reorder");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ before: "p0" });
  });

  it("compares revisions and restores fields (#686)", async () => {
    const { client, calls } = setup();
    await client.items("posts").compareRevisions("p1", { from: "r1" });
    expect(calls[0]!.url.pathname).toBe("/api/v1/items/posts/p1/revisions/compare");
    expect(calls[0]!.url.searchParams.get("from")).toBe("r1");
    expect(calls[0]!.url.searchParams.get("to")).toBe("current");
    await client.items("posts").restoreRevisionFields("p1", "r1", ["title"]);
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url.pathname).toBe("/api/v1/items/posts/p1/revisions/r1/restore");
    expect(JSON.parse(calls[1]!.body!)).toEqual({ fields: ["title"] });
  });
});
