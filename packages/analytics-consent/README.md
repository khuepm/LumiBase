# @lumibase/analytics-consent

Consent-gated Google Analytics for the public LumiBase sites. Shared by
`apps/landing` (Next static export) and `apps/docs` (prerendered Vite SPA) so the
rules that decide whether GA runs live in exactly one place.

Cloudflare Web Analytics, which Pages injects, is cookieless and needs no
consent — it keeps counting either way. Everything here exists for GA4 alone: it
writes `_ga` cookies and is a third-country processor, which puts it behind an
opt-in.

## Invariants

These are the properties the test suite protects. Breaking one should fail a test,
not ship.

1. **No GA request before a grant.** Consumers do not render or inject the tag
   until consent is `granted`. Stricter than Consent Mode on its own, which loads
   the tag and merely withholds storage.
2. **Advertising signals are never granted.** `ad_storage`, `ad_user_data` and
   `ad_personalization` are emitted as `denied`, plus `allow_google_signals: false`
   and `allow_ad_personalization_signals: false`.
3. **The measurement ID is validated before interpolation.** It ends up inside an
   inline `<script>`, so `resolveMeasurementId()` accepts only `G-XXXXXXX`; a `UA-`
   property, a `GTM-` container, or an injection attempt resolves to `null`
   (analytics off) and the builders throw.
4. **Storage failures fail closed.** A browser that throws on `localStorage`
   (Safari private/Lockdown) reads as "no consent", never as consent. An
   unrecognised stored value reads as undecided, not as a grant.
5. **Unset means invisible.** With no measurement ID there is no tag, no cookie,
   and no banner to dismiss.

## Entry points

| Import | Contents |
| --- | --- |
| `@lumibase/analytics-consent` | Framework-free core: consent storage, ID validation, gating predicates, `buildGtagBootstrap()`, `loadGtag()`. Safe in a server component or a Node test. |
| `@lumibase/analytics-consent/react` | `useConsent()` plus a re-export of the core, for client components. |

`useConsent()` returns `'granted' | 'denied' | null | 'unhydrated'`. The
`'unhydrated'` state is not cosmetic: both consumers prerender to static HTML —
one file for every visitor — so a banner decided before hydration would flash at
people who already answered. Render nothing until it resolves.

## Two ways to load the tag

Which one you use depends on what the framework gives you:

- **`buildGtagBootstrap()` + `gtagScriptUrl()`** — for a declarative primitive
  such as Next's `<Script>`. Returns the inline snippet as a string.
- **`loadGtag()`** — imperative injection for apps without one. Idempotent by
  script `id`, so a re-rendering SPA cannot stack duplicate tags, and it accepts a
  `doc` option, which is what makes it testable without a DOM.

Both emit the same Consent Mode calls and the same config, in the same order.

## Withdrawal

`clearConsent()` forgets the decision and `revokeAnalyticsStorage()` handles the
awkward case: consent granted earlier in the session, withdrawn now. Un-mounting a
script does not unload a tag that already ran, so withdrawal flips Consent Mode
back to `denied` and deletes the `_ga*` cookies on both the exact host and the
registrable domain (GA sets them on the latter).

## Per-origin, not per-brand

`localStorage` is per-origin, so a decision on `lumibase.dev` says nothing about
`docs.lumibase.dev`. Every site that loads GA must ask for itself and offer its own
withdrawal control. Adding a new public site means adding both, not reusing
another site's answer.

## Page views on client-side navigation

Neither consumer fires its own `page_view` on route change. GA4 enhanced
measurement ("page changes based on browser history events") is on by default and
already counts them; adding our own would double-count. If you are here because
navigations look missing, check that setting in the GA property first.
