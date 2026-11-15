---
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:55:15.280Z
contentHash: 926006bb5a72acbe
codeVerified: 2026-11-15T16:55:15.280Z
codeVerifiedHash: 926006bb5a72acbe
codeVerifiedClaims: 4
---

# Studio Intent Links

An **intent link** is a stable URL that asks Studio to open, create or edit a
piece of content — in a given locale, scrolled to a given field — without the
link's producer knowing Studio's internal routes. A preview overlay, a
notification, a chat agent or an email can all mint the same link, and it keeps
working when the Studio layout changes.

```
https://cms.example.com/lumi-7f3a9c/intent/edit?collection=posts&id=p_123&locale=vi&field=title
```

## Contract (version 1)

The URL shape is `{studioOrigin}{adminPath?}/intent/{action}?{params}`.

| Param | Required | Meaning |
|---|---|---|
| `collection` | always | Collection name (identifier: letters, digits, `_`). |
| `id` | `edit`; optional for `open`; forbidden for `create` | Item id. `open` without an id opens the collection list. The ids `new` and `reviews` are reserved and refused. |
| `locale` | optional | Locale tag (`en`, `vi`, `pt-BR`). The site's first locale opens the Fields tab; any other enabled locale opens Translation mode with that target. |
| `field` | optional | Field to scroll to and focus. Needs an item (`open`/`edit` with `id`) or `create`. |
| `site` | optional | Site id. When it differs from the active site Studio asks before switching, and refuses if the user has no access. |
| `v` | optional | Contract version; absent means `1`. |

Actions: `open`, `create`, `edit`.

Rules that keep the contract stable:

- Unknown params, duplicated params, an unknown `v` and malformed values are
  refused with a friendly error page that lists every problem — Studio never
  guesses. `utm_*` tracking params are the one tolerated exception.
- New optional params may be added within v1; a change in meaning bumps `v`.
- Without `site`, the link acts on the user's active site. Producers that know
  the site (every CMS-side producer does) should always set it.

### Building links

`@lumibase/contracts/intents` exports the builder and parser shared by the CMS,
Studio and extensions. The builder validates with the same rules Studio
applies, so a producer can never mint a link Studio would refuse.

```ts
import { buildStudioIntentPath, buildStudioIntentUrl } from '@lumibase/contracts/intents';

// Admin-relative — for in-app links and notification `deepLink`s.
buildStudioIntentPath({ action: 'edit', collection: 'posts', id: 'p_123', field: 'title' });
// → '/intent/edit?collection=posts&id=p_123&field=title'

// Absolute — for email, chat and push.
buildStudioIntentUrl(
  { action: 'edit', collection: 'posts', id: 'p_123', locale: 'vi', field: 'title', site: 'site_1' },
  { studioUrl: 'https://cms.example.com', adminPath: '/lumi-7f3a9c' },
);
```

`parseStudioIntent(action, params)` returns `{ ok: true, intent }` or
`{ ok: false, errors }`; `studioIntentRoute(intent)` gives the built-in Studio
route. The veto-window diff in Mission Control uses `buildStudioIntentPath`
(via the Studio `IntentLink` component) so "Open item" lands on the first field
the agent wants to change.

## How Studio resolves a link

1. **Sign-in.** A signed-out visitor to `/{adminPath}/intent/...` is sent to
   `/{adminPath}/login?next=/intent/...`. After sign-in (including the MFA
   step) Studio returns to the intent, admin prefix included. An expired
   session that hits an intent link keeps it the same way.
2. **Validation.** The raw query string is parsed against the v1 contract.
3. **Site.** If `site` differs from the active site, Studio asks the CMS
   (`GET /api/v1/auth/me` with that site's `X-Lumi-Site`) whether the session
   may use it. Allowed → an explicit "Switch site?" confirmation; denied → an
   error page. Nothing is ever opened in the current site instead.
4. **Extension claims**, then the **built-in route**
   (`/content/{collection}/{id}?locale=&field=`, `/content/{collection}/new`, or
   `/content/{collection}`).
5. **Editor.** The item editor applies `locale` (respecting the site's enabled
   locales and which fields are translatable), opens any collapsed group that
   holds `field`, scrolls it into view and focuses its editor. A locale the site
   does not enable, a non-translatable field or a field the user cannot see
   produces a visible notice instead of being dropped silently.

### No open redirects

Every target is internal. The login `next` must be an admin-relative intent
path; absolute URLs, `//host`, backslash tricks, control characters, fragments
and dot-segment rewrites are refused. Paths returned by extension handlers go
through the same check, and a handler cannot send the user back into
`/intent/...`.

## Extensions claiming intents

A Studio extension can take over an intent (for example, open a custom review
panel instead of the default editor). Export handlers as `intents` from the
bundle and request a capability for each claim:

```ts
import { defineIntentHandler } from '@lumibase/extension-sdk';

export const intents = [
  defineIntentHandler({
    id: 'seo-panel',
    canHandle: (intent) => (intent.action === 'edit' && intent.field === 'seo' ? 10 : 0),
    // Send "edit the seo group" links to the concrete field editors care about.
    handle: (intent) => ({ navigate: `/content/${intent.collection}/${intent.id}?field=seo_title` }),
  }),
];
```

- **Capability scoping.** A handler is only offered intents that the
  extension's granted capabilities cover:
  `intents:claim:<action>:<collection>`, with `*` allowed in either part
  (`intents:claim:edit:posts`, `intents:claim:*:posts`).
- **Deterministic resolution.** Among covered handlers whose `canHandle`
  returns a finite number greater than 0, the highest wins; ties break on
  extension name, then handler `id`. Returning `0`, `false` or `null` declines.
- **Fallback.** If the winning `handle` throws, returns `{ fallback: true }`, or
  returns an unsafe path, the built-in route runs. The runner-up is not tried.
- Bundles of extensions with an `intents:claim:*` capability are imported only
  when an intent is being resolved, not on a normal Studio load.

## Form layouts

Field reveal is generic: the editor publishes the focus target and the chain of
containers that hold it through `FieldRevealContext`
(`apps/studio/src/modules/content/field-focus.tsx`). Group containers call
`useRevealContainer(name)` to open themselves. A future tabbed form layout can
do the same, or read `useFieldReveal()` and switch to the tab that contains the
target field.

## Desktop and mobile shell

The Tauri shell forwards `lumibase://` deep links to Studio as the
`shell://deep-link` event. Studio maps the intent form onto the same route the
browser uses:

```
lumibase://intent/edit?collection=posts&id=p_123&field=title
```

On mobile, universal links on `studio.lumibase.dev` are currently registered
only for `/oauth` and `/auth`; once `/intent` is added to the shell's
`pathPrefix` (and the host's association file), those links reach the same
handler with no Studio change. A link that launches the desktop app from a
cold start may arrive before Studio subscribes to the event; open it again in
that case.

## Known limits

- An admin path chosen as exactly `/intent` would collide with the intent
  route (the same limitation already applies to `/content`, `/settings`, …).
- `locale` on a `create` intent is accepted but the new-item form always starts
  in the site's default locale.
