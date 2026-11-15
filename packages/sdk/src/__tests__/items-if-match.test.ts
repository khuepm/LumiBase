import { describe, expect, it, vi } from "vitest";

import { createLumiClient, LumiError } from "../client";
import { legacyRest } from "../rest/legacy";

/** `items(name).patch/replace` send `If-Match` only when `ifMatch` is given. */

function setup(response: () => Response) {
  const calls: Array<{ method: string | undefined; ifMatch: string | null; body: string | null }> = [];
  const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method,
      ifMatch: headers.get("if-match"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return response();
  });
  const client = createLumiClient({
    url: "https://api.example.test/",
    token: "tok",
    siteId: "site_1",
    fetcher: fetcher as unknown as typeof fetch,
  }).with(legacyRest());
  return { client, calls };
}

const ok = () =>
  new Response(JSON.stringify({ data: { id: "a", version: 4 } }), {
    status: 200,
    headers: { "content-type": "application/json", etag: '"4"' },
  });

describe("items(name) write preconditions", () => {
  it("omits If-Match by default", async () => {
    const { client, calls } = setup(ok);
    await client.items("posts").patch("a", { data: { title: "x" } });
    expect(calls[0]!.ifMatch).toBeNull();
  });

  it("sends a strong tag for patch and replace", async () => {
    const { client, calls } = setup(ok);
    await client.items("posts").patch("a", { data: { title: "x" } }, { ifMatch: 3 });
    await client.items("posts").replace("a", { data: { title: "x" } }, { ifMatch: 0 });
    expect(calls.map((c) => [c.method, c.ifMatch])).toEqual([
      ["PATCH", '"3"'],
      ["PUT", '"0"'],
    ]);
    // The header does not displace the JSON body or its content type.
    expect(JSON.parse(calls[1]!.body!)).toEqual({ data: { title: "x" } });
  });

  it("surfaces 412 as a LumiError with PRECONDITION_FAILED", async () => {
    const { client } = setup(
      () =>
        new Response(JSON.stringify({ errors: [{ code: "PRECONDITION_FAILED", message: "changed" }] }), {
          status: 412,
          headers: { "content-type": "application/json" },
        }),
    );
    const err = await client
      .items("posts")
      .patch("a", { data: { title: "x" } }, { ifMatch: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LumiError);
    expect((err as LumiError).status).toBe(412);
    expect((err as LumiError).body.errors[0]?.code).toBe("PRECONDITION_FAILED");
  });
});
