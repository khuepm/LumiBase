import { describe, expect, it, vi } from "vitest";

import { createLumiClient } from "../client";
import { legacyRest } from "../rest/legacy";

/** SDK coverage for the JSON path index advisor (#729). */

function setup() {
  const calls: URL[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    calls.push(new URL(String(input)));
    return new Response(
      JSON.stringify({
        data: {
          path: "specs.weight",
          cast: "numeric",
          indexName: "items_json_x",
          expression: "x",
          ddl: "CREATE INDEX CONCURRENTLY x",
          notes: [],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const client = createLumiClient({
    url: "https://api.example.test",
    token: "tok",
    siteId: "site_1",
    fetcher: fetcher as unknown as typeof fetch,
  }).with(legacyRest());
  return { client, calls };
}

describe("schema.indexAdvice", () => {
  it("passes path and an explicit cast", async () => {
    const { client, calls } = setup();
    const res = await client.schema.indexAdvice("products", "specs.weight", "numeric");
    expect(res.data.ddl).toBe("CREATE INDEX CONCURRENTLY x");
    expect(calls[0]!.pathname).toBe("/api/v1/collections/products/index-advice");
    expect(calls[0]!.searchParams.get("path")).toBe("specs.weight");
    expect(calls[0]!.searchParams.get("cast")).toBe("numeric");
  });

  it("omits cast so the server uses the declared field type", async () => {
    const { client, calls } = setup();
    await client.schema.indexAdvice("my products", "price");
    expect(calls[0]!.pathname).toBe("/api/v1/collections/my%20products/index-advice");
    expect(calls[0]!.searchParams.has("cast")).toBe(false);
  });
});
