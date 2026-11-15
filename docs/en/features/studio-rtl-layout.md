---
version: 2
sourceLang: en
lastUpdated: 2026-11-15T16:50:32.627Z
contentHash: 3e952805b2b9d3e6
codeVerified: 2026-11-15T16:50:32.627Z
codeVerifiedHash: 3e952805b2b9d3e6
codeVerifiedClaims: 20
---

# Right-to-left (RTL) layout in Studio

Studio mirrors its layout for right-to-left interface languages: **Arabic (`ar`)**, **Hebrew (`he`)** and **Persian / Farsi (`fa`)**. Choosing one sets `<html dir="rtl">`, so the sidebar, toolbars, tables, menus and directional icons flip to the other side. Content fields follow the direction of the *content* locale independently, so an Arabic translation is typed right-to-left even in an English interface.

Code: `apps/studio/src/lib/text-direction.ts`, `apps/studio/src/lib/ui-language.ts`, `apps/studio/src/components/site-language.tsx`, `apps/studio/src/components/ui-language-picker.tsx`.

## Choosing an RTL interface language

The interface language is resolved in this order (`resolveUiLanguage`):

1. the signed-in user's preference, `preferences.language` (`GET /api/v1/me/preferences`);
2. the site's default language (**Settings → Site → Default language**);
3. English.

Users change their own language with the **Interface language** selector in the top bar, which writes `preferences.language` through `PATCH /api/v1/me/preferences`. Site admins pick Arabic, Hebrew or Farsi as the site default under **Settings → Site**.

Studio supports `en`, `vi`, `ar`, `he` and `fa` as interface languages (`UI_LANGUAGES`). Tags match on their base language, so `ar-EG` selects `ar`; the legacy Hebrew tag `iw` selects `he`.

The last resolved language is remembered in the browser (`localStorage` key `lumibase.ui-language`), so the login page and the first paint after a reload already use the right direction instead of flashing left-to-right.

### Translated copy

`ar`, `he` and `fa` are supported for **layout**. Studio ships no bundled Arabic, Hebrew or Farsi copy (`BUNDLED_UI_LANGUAGES` is `en` and `vi`): strings without a translation in the CMS-managed `ui` namespace (**Settings → Translations**) fall back to English, shown inside the mirrored layout. Strings are never machine-translated automatically.

## How the direction is resolved

`directionOf(tag)` returns `rtl` or `ltr` from a fixed table, not from `Intl.Locale#getTextInfo()`, which Firefox and older WebKit (the desktop shell on macOS/Linux) lack:

- an explicit script subtag decides: `az-Arab` is RTL, `ks-Deva` is LTR;
- otherwise the base language: `ar`, `arc`, `ckb`, `dv`, `fa`, `he`, `iw`, `ks`, `mzn`, `pnb`, `ps`, `sd`, `syr`, `ug`, `ur` and `yi` are RTL;
- anything else, including a missing or malformed tag, is LTR.

`applyDocumentLanguage(lang)` writes both `lang` and `dir` on `<html>`. It runs before the first render (`main.tsx`), on every i18next `languageChanged` event (`lib/i18n.ts`) and after `SiteLanguageSync` resolves the signed-in language.

## Content direction

Text editors take the direction of the locale being edited, not of the interface (`contentDirProps(locale)`):

| Editor | Direction |
|---|---|
| `translatable-text` — one input per site locale | each input gets its locale's `dir` and `lang` |
| Translation mode — source and target side by side | each pane gets its locale's `dir` and `lang` |
| `input`, `input-multiline`, `markdown`, `wysiwyg` | the field's `locale` prop when the caller knows it, otherwise `dir="auto"` (the browser picks the direction from the first strong character typed) |

Site locales come from the `locales` setting (`value.supported`), the same source the Translations module uses.

These always stay left-to-right, whatever the language: Monaco code editors (JSON, code fields, generated types, policy JSON), the flow canvas, and `<pre>` code blocks.

## Writing RTL-safe Studio code

Use Tailwind's **logical** utilities (Tailwind v4 ships them all):

| Physical (do not use) | Logical |
|---|---|
| `ml-*` / `mr-*` | `ms-*` / `me-*` |
| `pl-*` / `pr-*` | `ps-*` / `pe-*` |
| `left-*` / `right-*` | `start-*` / `end-*` |
| `text-left` / `text-right` | `text-start` / `text-end` |
| `border-l` / `border-r` | `border-s` / `border-e` |
| `rounded-l-*` / `rounded-r-*` | `rounded-s-*` / `rounded-e-*` |
| `float-left` / `float-right` | `float-start` / `float-end` |
| `style={{ paddingLeft }}` | `style={{ paddingInlineStart }}` |

`space-x-*` and `divide-x-*` are already logical in Tailwind v4. A `translate-x-*` transform is physical: add the mirrored value under the `rtl:` variant, as the toggle knob does (`translate-x-[18px] rtl:-translate-x-[18px]`).

### The logical-CSS guard

`pnpm logical-css:check` (`scripts/check-logical-css.mjs`, part of `pnpm check:all`, so it runs in the pre-commit hook and CI) fails when `apps/studio/src` or `packages/ui/src` contains a physical-direction utility or inline-style key. It prints the logical replacement for each finding:

```bash
pnpm logical-css:check                       # report
node scripts/check-logical-css.mjs --fix     # rewrite in place (the codemod)
```

Not flagged: classes under an `rtl:` or `ltr:` variant, a line carrying a `rtl-physical-ok` comment, and the files in the script's `ALLOW_FILES` (the flow canvas node renderer and the peer-cursor overlay, which draw at physical coordinates).

### Icons

Directional icons mirror automatically in RTL through a rule in `apps/studio/src/index.css` keyed on lucide's icon classes: chevrons and arrows pointing left or right, first/last, panel open/close, sign in/out, send, reply/forward, undo/redo and list indent. Icons that name a physical side or are not directional are not mirrored: logos, media, checkmarks, external-link, text alignment, up/down arrows. An icon with its own `rotate-*` class is left alone. Add `rtl-no-flip` to opt one icon out, or `rtl-flip` to opt a custom SVG in.

Studio does not use Radix or another headless library that needs a `DirectionProvider`; native elements inherit `dir` from `<html>`.

## End-to-end check

`apps/studio/e2e/rtl-layout.e2e.mjs` serves Studio with Vite, answers every `/api/**` call from fixtures (no CMS needed) and renders the login page, a collection's item list, the item editor and **Settings → Site** in Arabic at desktop and mobile widths. For each screen it checks `<html dir="rtl">`, no horizontal page overflow, interactive controls inside the viewport, no overlap between sibling controls and no input icon covering the input text, and saves a screenshot:

```bash
cd apps/studio
node e2e/rtl-layout.e2e.mjs                    # screenshots in e2e/artifacts/
RTL_E2E_LANG=he node e2e/rtl-layout.e2e.mjs    # another RTL language
```

The `Studio RTL layout` workflow (`.github/workflows/studio-rtl-e2e.yml`) runs it on pull requests that touch Studio or `packages/ui` and uploads the screenshots as an artifact.

## Desktop and mobile shell

The Tauri shell renders the same document, so it follows `<html dir>` with no extra code. The native title bar and window controls follow the operating system's language, not the Studio language. The shell's contracts (token storage, API base URL, build output, dev port) are unchanged.
