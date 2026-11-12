import { describe, expect, it, vi } from "vitest";

import { createLumiClient, LumiError } from "../client";
import { legacyRest } from "../rest/legacy";

/** SDK coverage for `items(name).export()` and `rawFetch` (#727). */

function setup(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: Array<{ url: URL; auth: string | null; site: string | null }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization"), site: headers.get("x-lumi-site") });
    return handler(url, init);
  });
  const client = createLumiClient({
    url: "https://api.example.test/",
    token: "tok",
    siteId: "site_1",
    fetcher: fetcher as unknown as typeof fetch,
  }).with(legacyRest());
  return { client, calls };
}

describe("items(name).export()", () => {
  it("builds the query and returns the unread streaming Response", async () => {
    const { client, calls } = setup(
      () => new Response("id,status\r\na,draft\r\n", { status: 200, headers: { "content-type": "text/csv" } }),
    );
    const res = await client.items("products").export({
      format: "csv",
      fields: ["title", "price"],
      locales: ["en", "vi"],
      relations: "slug",
      filter: { price: { _gt: 9 } },
      sort: ["-price"],
      status: "published",
    });
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe("id,status\r\na,draft\r\n");
    const { url, auth, site } = calls[0]!;
    expect(url.pathname).toBe("/api/v1/items/products/export");
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    expect(params).toEqual({
      format: "csv",
      fields: "title,price",
      locales: "en,vi",
      relations: "slug",
      filter: '{"price":{"_gt":9}}',
      sort: "-price",
      status: "published",
    });
    expect(auth).toBe("Bearer tok");
    expect(site).toBe("site_1");
  });

  it("omits the query string when called without options", async () => {
    const { client, calls } = setup(() => new Response("{}", { status: 200 }));
    await client.items("products").export();
    expect(calls[0]!.url.search).toBe("");
  });

  it("throws LumiError with the server's error body on failure", async () => {
    const { client } = setup(
      () =>
        new Response(JSON.stringify({ errors: [{ code: "UNKNOWN_FIELD", message: "nope" }] }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const err = await client.items("products").export({ fields: ["nope"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LumiError);
    expect((err as LumiError).status).toBe(400);
  });
});
