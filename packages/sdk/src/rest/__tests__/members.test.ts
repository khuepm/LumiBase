import { describe, expect, it } from "vitest";

import { createLumiClient, LumiError } from "../../client";
import { getMember, getMemberPortalConfig, requestMemberLink, updateMember, verifyMemberLink } from "../members";

function client(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { c: createLumiClient({ url: "https://cms.example.test", token: "member-jwt", siteId: "site_1", fetcher }), calls };
}

describe("member portal commands", () => {
  it("hits the portal endpoints with the site header", async () => {
    const { c, calls } = client((url) =>
      new Response(JSON.stringify({ data: url.includes("config") ? { allowSelfSignup: true, newsletters: [], tiers: [], copy: {} } : { status: "pending" } }), { status: 200 }),
    );
    expect((await c.request(getMemberPortalConfig("vi"))).allowSelfSignup).toBe(true);
    await c.request(requestMemberLink({ email: "a@example.test", newsletters: ["weekly"] }));
    expect(calls[0]!.url).toBe("https://cms.example.test/api/v1/portal/config?locale=vi");
    expect(calls[1]!.url).toBe("https://cms.example.test/api/v1/portal/magic-link");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ email: "a@example.test", newsletters: ["weekly"] });
    expect(new Headers(calls[1]!.init.headers).get("x-lumi-site")).toBe("site_1");
  });

  it("sends the member session on /me and surfaces errors", async () => {
    const { c, calls } = client((url, init) =>
      init.method === "PATCH"
        ? new Response(JSON.stringify({ errors: [{ code: "NEWSLETTER_NOT_AVAILABLE", message: "no" }] }), { status: 400 })
        : new Response(JSON.stringify({ data: { id: "m1", token: "t" } }), { status: 200 }),
    );
    expect((await c.request(getMember())).id).toBe("m1");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer member-jwt");
    expect((await c.request(verifyMemberLink("x"))).token).toBe("t");
    await expect(c.request(updateMember({ newsletters: { nl: true } }))).rejects.toBeInstanceOf(LumiError);
  });
});
