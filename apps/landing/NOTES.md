# Iridescent landing page

Visual reconstruction of the user-supplied LumiBase composition dated September 19, 2026 (`04_04_55 AM.png`), implemented in the existing Next.js app. The reference is a static image; interactions and responsive layouts are implemented here, not inferred from a source website.

## Design and implementation

- Navy canvas with cyan, violet, pink, and pearl highlights; transparent artwork is layered around live HTML copy and controls.
- Sections: hero, content intent, earned autonomy, Mission Control, MCP, provenance, open-source runtime.
- Trust levels are selectable. Mission Control rows reveal illustrative change details; no backend operations are performed.
- Copy distinguishes bounded autonomy, human-approved promotion, publishing standards, and the governed HTTP MCP endpoint.
- The existing flower-video footer, reveal animations, oversized wordmark, and neon accents are preserved.
- Existing footer product anchors and legal/pricing routes remain available. Metadata and SoftwareApplication structured data are preserved; the removed FAQ no longer emits FAQ structured data.
- Decorative motion respects reduced-motion preferences. Native links, labeled buttons, focus outlines, a skip link, and expandable preview rows remain keyboard accessible.
- No CMS, database, setup, authentication, deployment, or shell contracts change.

## Files

- `src/components/IridescentLanding.tsx` and its CSS module: page content, artwork placement, and illustrative interactions.
- `src/components/Header.tsx` and its CSS module: desktop navigation and mobile menu.
- `src/app/page.tsx`: server page and structured data.
- `src/app/layout.tsx`: shared layout; retired the global WebGL starfield from this layout.
- `public/assets/iridescent/`: locally served WebP assets, about 1 MB total. Original user-supplied PNGs remain unchanged.

## Artwork sources

All source filenames start with `ChatGPT Image Sep 19, 2026, ` and end in `.png`. They were supplied directly by the user for this implementation. Transparent outer padding was trimmed and images were resized and encoded as WebP (quality 86, alpha quality 95); no artwork was regenerated.

| Output | Source timestamp | Export width |
|---|---|---|
| wordmark.webp | 01_42_11 AM | 1500 |
| butterfly.webp | 03_45_49 AM (1) | 680 |
| flower.webp | 03_45_49 AM (2) | 680 |
| ribbon.webp | 03_45_51 AM (3) | 800 |
| fish.webp | 03_45_51 AM (4) | 850 |
| crystal.webp | 03_45_51 AM (5) | 600 |
| mcp.webp | 03_45_52 AM (6) | 480 |
| agent-api.webp | 03_45_52 AM (7) | 420 |
| sdk.webp | 03_45_52 AM (8) | 360 |
| garden-orb.webp | 01_57_58 AM (5) | 820 |
| world-orb.webp | 01_57_59 AM (7) | 650 |
| bird.webp | 01_57_57 AM (3) | 600 |

## Local development

Use the repo-pinned pnpm 9.12.0 with the installed workspace dependencies:

```sh
pnpm --filter @lumibase/landing dev --port 3010
pnpm --filter @lumibase/landing typecheck
pnpm --filter @lumibase/landing lint
pnpm --filter @lumibase/landing test
pnpm --filter @lumibase/landing build
```

This change is developed on `feature/iridescent-landing`; production deployment is a separate action.

---

# Landing footer and typography

The footer adapts the user-supplied Loopstack reference into the existing Next.js
site. It keeps LumiBase branding, all previous navigation destinations, normal
page scrolling, and the existing Archivo/Literata font pairing. The large wordmark,
serif heading, black fade, flower video, neon status dot, and pointer decoration
are the reference's main visual elements. Layout is responsive rather than fixed
to one desktop viewport.

## Files and assets

- `src/components/Footer.tsx` and `Footer.module.css`: content and visual layout.
- `src/components/FooterMotion.tsx` and `FooterMotion.module.css`: lazy playback,
  pause control, entrance observation, and scoped pointer decoration.
- Flower source supplied with the reference:
  `https://api.getlayers.ai/storage/v1/object/public/public/assets/loopstack-f8c64439bf/flower.mp4`.
  The video remains on that host. `public/assets/footer-flower.jpg` is a still
  extracted at two seconds for reduced motion, loading, and media failures.
- `font-display` in `src/app/globals.css` applies Literata regular to marketing
  headings. Archivo remains the interface/wordmark face; DM Mono remains for code.
- Literata and Archivo are SIL OFL 1.1 fonts. Copyright and license files are in
  `public/fonts/licenses/` and linked from `/license/`.

The footer is shared by every page. Video playback stops offscreen and when the
page is hidden. Reduced motion uses the poster; text stays readable without JS.
The decorative cursor only runs over this footer with a fine hover pointer.

## Verification

Run `pnpm -F @lumibase/landing lint`, `typecheck`, `test`, and `build`.
The build is a static export under `out/`; preview it with a static server.
Check the home and legal-page footers at desktop and mobile widths, keyboard
focus, pause/resume, and in-page navigation. The supplied reference is a text
specification, so no pixel-identical comparison with an original screenshot is
claimed. The design intentionally uses LumiBase copy/fonts and retains legal links.
