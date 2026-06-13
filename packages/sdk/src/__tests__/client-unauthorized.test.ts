import { describe, expect, it, vi } from "vitest";

import { createLumiClient, LumiError } from "../client";

function errorResponse(status: number, code = "UNAUTHENTICATED") {
  return new Response(JSON.stringify({ errors: [{ code, message: "nope" }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createLumiClient onUnauthorized", () => {
  it("fires onUnauthorized once and still throws LumiError on a 401", async () => {
    const onUnauthorized = vi.fn();
    const client = createLumiClient({
      url: "https://api.example.test",
      token: "stale",
      siteId: "site_1",
      fetcher: async () => errorResponse(401),
      onUnauthorized,
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toBeInstanceOf(
      LumiError,
    );
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onUnauthorized on non-401 errors", async () => {
    const onUnauthorized = vi.fn();
    const client = createLumiClient({
      url: "https://api.example.test",
      token: "ok",
      siteId: "site_1",
      fetcher: async () => errorResponse(403, "FORBIDDEN"),
      onUnauthorized,
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toBeInstanceOf(
      LumiError,
    );
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("a throwing onUnauthorized handler does not mask the LumiError", async () => {
    const client = createLumiClient({
      url: "https://api.example.test",
      token: "stale",
      siteId: "site_1",
      fetcher: async () => errorResponse(401),
      onUnauthorized: () => {
        throw new Error("handler blew up");
      },
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toMatchObject({
      name: "LumiError",
      status: 401,
    });
  });
});
