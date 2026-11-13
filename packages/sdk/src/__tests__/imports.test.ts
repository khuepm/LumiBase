import { describe, expect, it, vi } from "vitest";

import { createLumiClient } from "../client";
import { legacyRest } from "../rest/legacy";

/** SDK coverage for the imports namespace (#726). */

function setup() {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ data: { id: "job_1", status: "queued" } }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  });
  const client = createLumiClient({
    url: "https://api.example.test",
    token: "tok",
    siteId: "site_1",
    fetcher: fetcher as unknown as typeof fetch,
  }).with(legacyRest());
  return { client, calls };
}

describe("imports", () => {
  it("uploads multipart without forcing a JSON content type", async () => {
    const { client, calls } = setup();
    const res = await client.imports.create("products", "id,status\r\n,draft\r\n", { format: "csv", mode: "upsert" });
    expect(res.data.id).toBe("job_1");
    const { url, init } = calls[0]!;
    expect(url.pathname).toBe("/api/v1/imports");
    expect(url.searchParams.get("collection")).toBe("products");
    expect(url.searchParams.get("mode")).toBe("upsert");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect(new Headers(init?.headers).get("content-type")).toBeNull();
    const file = (init?.body as FormData).get("file") as File;
    expect(file.name).toBe("products.csv");
    expect(await file.text()).toBe("id,status\r\n,draft\r\n");
  });

  it("builds list, get, errors and cancel requests", async () => {
    const { client, calls } = setup();
    await client.imports.list({ collection: "products", status: "running", limit: 5 });
    await client.imports.get("job 1");
    await client.imports.errors("job_1");
    await client.imports.cancel("job_1");
    expect(calls.map((c) => `${c.init?.method ?? "GET"} ${c.url.pathname}${c.url.search}`)).toEqual([
      "GET /api/v1/imports?collection=products&status=running&limit=5",
      "GET /api/v1/imports/job%201",
      "GET /api/v1/imports/job_1/errors",
      "POST /api/v1/imports/job_1/cancel",
    ]);
  });
});
