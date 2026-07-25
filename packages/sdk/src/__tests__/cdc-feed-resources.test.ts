import { describe, expect, it, vi } from "vitest";

import { createLumiClient } from "../client";
import {
  ackCdcSubscription,
  createCdcSubscription,
  deleteCdcSubscription,
  dispatchCdcSubscription,
  listCdcSubscriptionDeliveries,
  listCdcSubscriptions,
  readCdcEvents,
  replayCdcSubscription,
  updateCdcSubscription,
} from "../rest";

/**
 * Change Feed SDK typed resources — verifies each command maps to the right
 * method/path/body and unwraps `{ data, meta }` correctly. The transport is a
 * captured fetcher; no server. Mirrors the routes in
 * apps/cms/src/modules/cdc/change-feed/routes.ts.
 */

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

function harness(responseBody: unknown) {
  const calls: Captured[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const client = createLumiClient({
    url: "https://api.example.test",
    token: "t",
    siteId: "site_1",
    fetcher: fetcher as unknown as typeof fetch,
  });
  return { client, calls };
}

describe("Change Feed SDK resources", () => {
  it("readCdcEvents builds the keyset query and returns data + meta", async () => {
    const meta = { nextCursor: "CURSOR_2", hasMore: true };
    const { client, calls } = harness({ data: [{ id: "evt_1" }], meta });
    const page = await client.request(
      readCdcEvents({ cursor: "CURSOR_1", collections: ["posts", "pages"], operations: ["update"], limit: 50 }),
    );
    expect(calls[0]!.method).toBe("GET");
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/cdc/events");
    expect(url.searchParams.get("cursor")).toBe("CURSOR_1");
    expect(url.searchParams.get("collections")).toBe("posts,pages");
    expect(url.searchParams.get("operations")).toBe("update");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(page.data).toEqual([{ id: "evt_1" }]);
    expect(page.meta).toEqual(meta);
  });

  it("readCdcEvents omits the query string entirely when no params given", async () => {
    const { client, calls } = harness({ data: [], meta: { nextCursor: null, hasMore: false } });
    await client.request(readCdcEvents());
    expect(calls[0]!.url).toBe("https://api.example.test/api/v1/cdc/events");
  });

  it("listCdcSubscriptions unwraps the data array", async () => {
    const { client, calls } = harness({ data: [{ id: "sub_1", name: "algolia" }] });
    const subs = await client.request(listCdcSubscriptions());
    expect(calls[0]!.url).toBe("https://api.example.test/api/v1/cdc/subscriptions");
    expect(subs).toEqual([{ id: "sub_1", name: "algolia" }]);
  });

  it("createCdcSubscription POSTs the create body", async () => {
    const { client, calls } = harness({ data: { id: "sub_new" } });
    await client.request(
      createCdcSubscription({ name: "algolia", kind: "webhook", webhook_id: "wh_1" }),
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.example.test/api/v1/cdc/subscriptions");
    expect(calls[0]!.body).toEqual({ name: "algolia", kind: "webhook", webhook_id: "wh_1" });
  });

  it("updateCdcSubscription PATCHes and encodes the id", async () => {
    const { client, calls } = harness({ data: { id: "sub 1" } });
    await client.request(updateCdcSubscription("sub 1", { status: "paused" }));
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.example.test/api/v1/cdc/subscriptions/sub%201");
    expect(calls[0]!.body).toEqual({ status: "paused" });
  });

  it("deleteCdcSubscription DELETEs", async () => {
    const { client, calls } = harness({ data: { ok: true } });
    const res = await client.request(deleteCdcSubscription("sub_1"));
    expect(calls[0]!.method).toBe("DELETE");
    expect(res).toEqual({ ok: true });
  });

  it("ackCdcSubscription POSTs the cursor to /ack", async () => {
    const { client, calls } = harness({ data: { id: "sub_1" } });
    await client.request(ackCdcSubscription("sub_1", "CURSOR_9"));
    expect(calls[0]!.url).toBe("https://api.example.test/api/v1/cdc/subscriptions/sub_1/ack");
    expect(calls[0]!.body).toEqual({ cursor: "CURSOR_9" });
  });

  it("replayCdcSubscription maps occurredAfter → occurred_after (snake_case wire)", async () => {
    const { client, calls } = harness({ data: { id: "sub_1", status: "active" } });
    await client.request(replayCdcSubscription("sub_1", { occurredAfter: "2026-07-01T00:00:00.000Z" }));
    expect(calls[0]!.url).toBe("https://api.example.test/api/v1/cdc/subscriptions/sub_1/replay");
    expect(calls[0]!.body).toEqual({ occurred_after: "2026-07-01T00:00:00.000Z" });
  });

  it("replayCdcSubscription forwards a cursor when given (and omits occurred_after)", async () => {
    const { client, calls } = harness({ data: { id: "sub_1" } });
    await client.request(replayCdcSubscription("sub_1", { cursor: "CURSOR_X" }));
    expect(calls[0]!.body).toEqual({ cursor: "CURSOR_X" });
  });

  it("dispatchCdcSubscription POSTs to /dispatch", async () => {
    const { client, calls } = harness({ data: { dispatched: true } });
    const res = await client.request(dispatchCdcSubscription("sub_1"));
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.example.test/api/v1/cdc/subscriptions/sub_1/dispatch");
    expect(res).toEqual({ dispatched: true });
  });

  it("listCdcSubscriptionDeliveries reads total from meta and passes pagination", async () => {
    const { client, calls } = harness({ data: [{ id: "d_1" }], meta: { total: 7 } });
    const res = await client.request(listCdcSubscriptionDeliveries("sub_1", { limit: 20, page: 2 }));
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/cdc/subscriptions/sub_1/deliveries");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("page")).toBe("2");
    expect(res).toEqual({ data: [{ id: "d_1" }], total: 7 });
  });
});
