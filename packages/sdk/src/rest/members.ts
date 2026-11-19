/**
 * Member Portal commands (epic #672, `/api/v1/portal/*`) for frontends that
 * use the SDK directly instead of the `@lumibase/portal` widget. Command
 * factories `(client) => Promise<T>`, like the rest of the REST module.
 *
 * Magic-link requests and redemption are public; `getMember` and friends need
 * the `frontend` session that `verifyMemberLink` returns (pass it as the
 * client's `token`).
 */

import type { LumiClient } from "../client";

export interface MemberPortalCopy {
  heading: string;
  description: string;
  placeholder: string;
  nameLabel: string;
  button: string;
  success: string;
  error: string;
}

export interface MemberPortalConfig {
  allowSelfSignup: boolean;
  newsletters: Array<{ id: string; key: string; name: string; description: string | null; audience: "members" | "paid" }>;
  tiers: Array<{
    key: string;
    name: string;
    description: string | null;
    kind: "free" | "paid";
    monthlyPriceCents: number | null;
    yearlyPriceCents: number | null;
    currency: string | null;
    benefits: string[];
  }>;
  copy: MemberPortalCopy;
}

export interface MemberProfile {
  id: string;
  email: string;
  name: string | null;
  status: "free" | "paid" | "comped";
  tier: { key: string; name: string; kind: string } | null;
  tierExpiresAt: string | null;
  newsletters: Array<{ id: string; key: string; name: string }>;
  createdAt: string;
}

export interface MemberLinkRequest {
  email: string;
  name?: string;
  /** Newsletter keys or ids; omitted = the site's defaults. */
  newsletters?: string[];
  /** Must be one of the site's registered landing URIs. */
  redirectUri?: string;
  intent?: "signup" | "signin";
  locale?: string;
}

export interface MemberSession {
  token: string;
  refreshToken?: string;
  [key: string]: unknown;
}

export const getMemberPortalConfig = (locale?: string) => async (client: LumiClient) =>
  (await client.rawRequest<MemberPortalConfig>(`/api/v1/portal/config${locale ? `?locale=${encodeURIComponent(locale)}` : ""}`)).data;

export const requestMemberLink = (input: MemberLinkRequest) => async (client: LumiClient) =>
  (await client.rawRequest<{ status: string; message: string }>("/api/v1/portal/magic-link", { method: "POST", body: JSON.stringify(input) })).data;

export const verifyMemberLink = (token: string) => async (client: LumiClient) =>
  (await client.rawRequest<MemberSession>("/api/v1/portal/magic-link/verify", { method: "POST", body: JSON.stringify({ token }) })).data;

export const getMember = () => async (client: LumiClient) => (await client.rawRequest<MemberProfile>("/api/v1/portal/me")).data;

export const updateMember =
  (patch: { name?: string | null; newsletters?: Record<string, boolean>; unsubscribeAll?: boolean }) => async (client: LumiClient) =>
    (await client.rawRequest<MemberProfile>("/api/v1/portal/me", { method: "PATCH", body: JSON.stringify(patch) })).data;

export const switchMemberTier =
  (input: { tier: string; interval?: "month" | "year"; returnUrl?: string }) => async (client: LumiClient) =>
    (
      await client.rawRequest<{ status: "switched"; accessChanged: boolean } | { status: "checkout"; checkoutUrl: string }>("/api/v1/portal/me/tier", {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).data;

export const leaveMembership = () => async (client: LumiClient) => {
  await client.rawRequest<null>("/api/v1/portal/me", { method: "DELETE" });
};
