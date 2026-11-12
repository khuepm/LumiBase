---
version: 4
lastUpdated: 2026-11-12T06:58:59.409Z
sourceLang: en
contentHash: 7fb7ff68405b0a37
codeVerified: 2026-11-12T06:58:59.409Z
codeVerifiedHash: 7fb7ff68405b0a37
codeVerifiedClaims: 8
---

# Organization settings

Organizations group sites under fixed roles. On narrow screens, expand **Settings navigation** to reach the organization page. Existing installations receive an organization with slug `default`; setup creates it before the first site. Open **Settings → Organization** as an owner or admin. This entry remains visible with one organization; the header switcher appears only when you belong to more than one.

## Roles

- Owner: organization settings, members, keys, site creation/deletion/transfer, and organization deletion.
- Admin: settings, members, keys, and site creation. Only an owner can change a slug or manage owners.
- Billing and member: organization reads. Write tabs are hidden; API permissions remain authoritative.

## Select an organization and a site

The header switcher selects the organization shown in Organization settings. In **Sites**, use **Open site** to choose the content workspace. **Create site** provisions its roles and membership, selects the new site, and reloads Studio after clearing cached data. Site requests continue to use `X-Lumi-Site`; organization requests omit it.

An owner can transfer a site only to an organization they also own. Deletion and transfer require an explicit confirmation. The last owner cannot be removed or demoted. An organization must have no sites before deletion.

## Keys and approvals

**Keys** creates, rotates, and revokes `lbo_` credentials. A new key appears in a dismissible human receipt; copy it into secure storage. The list contains only key metadata. **General** can enable organization MCP tools; the instance-wide kill switch still applies.

**Approvals** lists organization MCP requests. Review the operation and its parameters, then approve or reject it. The API rechecks the requester's live access and the human decider's permissions. Owner-only actions still require an owner, including ownership of both organizations for transfers. Newly minted key plaintext appears only in the human receipt, never in the agent response. A revoked requester cannot be approved; the request can still be rejected.

## Multi-tenancy

Organization selection is a browser preference, never an authorization grant. Queries include the organization id and a non-secret session scope; switching organizations remounts forms and discards displayed key secrets. Switching sites cancels queries, clears cached content, and reloads the shell. The server separately verifies organization membership and site ownership on every request.

Organization owner/admin login and refresh use current organization membership even without a direct site membership. A weaker direct role does not override that inherited authority. Removing the inherited grant blocks renewal unless a direct site role still authorizes it; a remaining frontend role renews with a frontend audience.

Password login and refresh still require a real site. Before deleting the last site, retain a valid organization key or Studio session to recreate one through the organization API. If all such credentials expire or are lost, restore a backup. Site-free instance recovery is a separate design (backlog B196).

For a legacy installation migrated without a bootstrap user, an operator can restore an owner for the backfilled organization. Choose an active user who already administers every site in that organization, then run `pnpm -F @lumibase/database recover:organization-owner <organization-id> <user-id> CONFIRM:<organization-id>` with `DATABASE_SYSTEM_URL` (or an operator `DATABASE_URL`). The command refuses an organization that already has an owner and does not grant site access to a new user. A site-free organization can be recovered with any active user selected by the operator.

## Desktop and verification

The desktop/mobile shell contracts C1–C7 remain intact: existing token-store accessors and API origin resolution are reused, session formats and the default development port are unchanged, and refresh tokens travel in the body. After a site switch, refresh and logout route to the session's original site. Clipboard failure offers manual copying. CORS permits `X-Confirm-Delete` from configured Studio/shell origins.

Verification covers organization profiles, permissions, confirmation, key receipts, site cache clearing, both Settings route trees, login/refresh inheritance, and cross-origin deletion preflight. See `apps/studio/src/modules/organization/__tests__`, `apps/studio/src/lib/__tests__/api.test.ts`, `apps/cms/src/routes/__tests__/organization-session.db.integration.test.ts`, and `apps/cms/src/__tests__/organization-cors.test.ts`.
