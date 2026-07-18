import { describe, expect, it, vi } from "vitest";

import { createLumiClient, LumiError } from "../client";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ok = (data: unknown) => jsonResponse(200, { data });
const unauthorized = () => jsonResponse(401, { errors: [{ code: "UNAUTHENTICATED", message: "nope" }] });
const refreshed = (n: number) =>
  jsonResponse(200, {
    data: { token: `access_${n}`, refreshToken: `refresh_${n}`, refreshTokenExpiresAt: "2030-01-01T00:00:00Z" },
  });

describe("createLumiClient auto-refresh", () => {
  it("refreshes on 401, retries once, and surfaces the rotated pair", async () => {
    const onTokensRefreshed = vi.fn();
    const calls: Array<{ path: string; auth: string | null }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ path, auth });
      if (path === "/api/v1/auth/refresh") return refreshed(2);
      // First data request (stale token) 401s; the retry (new token) succeeds.
      return auth === "Bearer access_2" ? ok({ ok: true }) : unauthorized();
    });

    const client = createLumiClient({
      url: "https://api.example.test",
      token: "access_1",
      refreshToken: "refresh_1",
      siteId: "site_1",
      fetcher: fetcher as unknown as typeof fetch,
      onTokensRefreshed,
    });

    const res = await client.rawRequest<{ ok: boolean }>("/api/v1/collections");
    expect(res.data.ok).toBe(true);

    // request(401) → refresh → request(retry) = 3 fetches.
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/collections",
      "/api/v1/auth/refresh",
      "/api/v1/collections",
    ]);
    expect(onTokensRefreshed).toHaveBeenCalledWith({
      token: "access_2",
      refreshToken: "refresh_2",
      refreshTokenExpiresAt: "2030-01-01T00:00:00Z",
    });
    // The client adopts the rotated access token for subsequent calls.
    expect(client.token).toBe("access_2");
  });

  it("falls back to onUnauthorized when refresh itself fails", async () => {
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/auth/refresh") return unauthorized();
      return unauthorized();
    });

    const client = createLumiClient({
      url: "https://api.example.test",
      token: "access_1",
      refreshToken: "refresh_1",
      siteId: "site_1",
      fetcher: fetcher as unknown as typeof fetch,
      onUnauthorized,
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toBeInstanceOf(LumiError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not retry when no refresh token is configured (legacy behaviour)", async () => {
    const onUnauthorized = vi.fn();
    const fetcher = vi.fn(async () => unauthorized());
    const client = createLumiClient({
      url: "https://api.example.test",
      token: "stale",
      siteId: "site_1",
      fetcher: fetcher as unknown as typeof fetch,
      onUnauthorized,
    });

    await expect(client.rawRequest("/api/v1/collections")).rejects.toBeInstanceOf(LumiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("coalesces parallel 401s into a single refresh", async () => {
    let refreshCount = 0;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const auth = new Headers(init?.headers).get("authorization");
      if (path === "/api/v1/auth/refresh") {
        refreshCount += 1;
        return refreshed(2);
      }
      return auth === "Bearer access_2" ? ok({ ok: true }) : unauthorized();
    });

    const client = createLumiClient({
      url: "https://api.example.test",
      token: "access_1",
      refreshToken: "refresh_1",
      siteId: "site_1",
      fetcher: fetcher as unknown as typeof fetch,
    });

    await Promise.all([
      client.rawRequest("/api/v1/a"),
      client.rawRequest("/api/v1/b"),
      client.rawRequest("/api/v1/c"),
    ]);
    expect(refreshCount).toBe(1);
  });
});
