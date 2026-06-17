import { describe, expect, it, vi } from "vitest";
import { createLumiClient, LumiError } from "../../client";
import { graphql } from "../index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetcher: typeof fetch) {
  return createLumiClient({
    url: "https://api.test",
    token: "tok",
    siteId: "site-1",
    fetcher,
  }).with(graphql());
}

describe("graphql() SDK adapter", () => {
  it("POSTs the document + variables with auth and tenant headers", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: { articles: [{ id: "1" }] } }),
    );
    const client = makeClient(fetcher as unknown as typeof fetch);

    const data = await client.query<{ articles: Array<{ id: string }> }>(
      "query ($limit: Int) { articles(limit: $limit) { id } }",
      { limit: 10 },
    );

    expect(data.articles).toEqual([{ id: "1" }]);

    const call = fetcher.mock.calls[0]!;
    const url = call[0];
    const init = call[1];
    expect(url).toBe("https://api.test/api/v1/graphql");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "query ($limit: Int) { articles(limit: $limit) { id } }",
      variables: { limit: 10 },
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("x-lumi-site")).toBe("site-1");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("throws a LumiError carrying the GraphQL extensions.code", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        data: null,
        errors: [{ message: "no read", extensions: { code: "PERMISSION_DENIED", status: 403 } }],
      }),
    );
    const client = makeClient(fetcher as unknown as typeof fetch);

    await expect(client.query("query { articles { id } }")).rejects.toMatchObject({
      status: 403,
      body: { errors: [{ code: "PERMISSION_DENIED", message: "no read" }] },
    });
  });

  it("fires onUnauthorized via rawRequest on a 401", async () => {
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn(async () => jsonResponse({ errors: [{ code: "UNAUTHENTICATED", message: "nope" }] }, 401));
    const client = createLumiClient({
      url: "https://api.test",
      token: "tok",
      siteId: "site-1",
      fetcher: fetcher as unknown as typeof fetch,
      onUnauthorized,
    }).with(graphql());

    await expect(client.query("query { articles { id } }")).rejects.toBeInstanceOf(LumiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("mutate is an alias of query", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: { create_articles: { id: "new" } } }));
    const client = makeClient(fetcher as unknown as typeof fetch);

    const data = await client.mutate<{ create_articles: { id: string } }>(
      'mutation { create_articles(data: { title: "x" }) { id } }',
    );
    expect(data.create_articles).toEqual({ id: "new" });
  });
});
