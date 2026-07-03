import { describe, expect, it } from "vitest";

import { createLumiClient } from "../../client";
import { search } from "../index";

function createSdk(fetcher: typeof fetch) {
  return createLumiClient({
    url: "https://api.example.test",
    token: "dev:user",
    siteId: "site_1",
    fetcher,
  });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("search command", () => {
  it("builds a single-collection query", async () => {
    let calledUrl = "";
    const sdk = createSdk(async (url) => {
      calledUrl = String(url);
      return jsonResponse({ data: [], meta: { query: "ha noi", limit: 20, offset: 0 } });
    });

    await sdk.request(search("ha noi", { collection: "articles", limit: 10 }));

    const u = new URL(calledUrl);
    expect(u.pathname).toBe("/api/v1/search");
    expect(u.searchParams.get("q")).toBe("ha noi");
    expect(u.searchParams.get("collection")).toBe("articles");
    expect(u.searchParams.get("limit")).toBe("10");
  });

  it("omits collection for cross-collection (global) search", async () => {
    let calledUrl = "";
    const sdk = createSdk(async (url) => {
      calledUrl = String(url);
      return jsonResponse({ data: [], meta: { query: "x", limit: 20, offset: 0 } });
    });

    await sdk.request(search("x"));

    const u = new URL(calledUrl);
    expect(u.searchParams.get("q")).toBe("x");
    expect(u.searchParams.has("collection")).toBe(false);
  });

  it("returns the { data, meta } envelope", async () => {
    const sdk = createSdk(async () =>
      jsonResponse({
        data: [{ id: "i1", _collection: "articles", _title: "Hà Nội" }],
        meta: { query: "ha noi", limit: 20, offset: 0, collections: ["articles"] },
      }),
    );

    const res = await sdk.request(search("ha noi"));
    expect(res.data[0]?._title).toBe("Hà Nội");
    expect(res.meta.collections).toEqual(["articles"]);
  });
});
