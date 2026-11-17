# Storybook landing page

The home page is a fairy tale told in WebGL: LumiBase steps out of a storybook, and Lumi — the
mascot — takes the genie's place, rising out of a lamp to help anyone bring an idea to life.
It replaces the iridescent page, which is kept on `feature/iridescent-landing` for comparison.

## Design and implementation

- One pinned three.js scene sits behind the page for the length of the story. All copy is HTML
  laid over it, so the page reads in full without WebGL, without JavaScript, and to crawlers.
- Seven screen-tall chapters drive the scene by scroll position: prologue (lamp, hills, castle),
  intent (scattered pages fall into order), earned autonomy (a staircase of stars — picking a
  level makes Lumi hop to it), Mission Control, MCP (visiting agents orbit inside a ring of
  rules), provenance (a trail of crumbs), and an epilogue back at the lamp.
- Lumi is procedural: shell-textured fur (the same sphere drawn in layers, strands kept by the
  fragment shader), a face, and an antenna on a spring. Fur trails behind motion. No model file.
- Everything else is procedural too — sky, stars, moon, paper-cut hills, castle, lamp, sparkles.
  The scene downloads no textures or models; the only new asset is the three.js bundle.
- Clicking Lumi makes it hop; clicking the lamp shakes loose a fountain of sparks. On desktop
  Lumi watches the pointer.
- Product copy and claims are carried over from the iridescent page; only the framing changed.
- Against `main` this is a smaller page: the detailed feature cards (collection builder,
  field-level permissions, realtime collaboration, typegen, CDC) and the positioning, trust-ladder
  and studio sections are gone. The FAQ and its `FAQPage` structured data stay, as an afterword
  below the story (`StoryFaq.tsx`).
- `CosmicBackground` moved from the root layout into `SiteBackground`, which renders it on every
  page except home (the scene is home's backdrop), so pricing and legal pages keep the starfield.
- Footer anchors (`#content-os`, `#ai-harness`, `#studio`, `#runtime`) and the legal/pricing
  routes are unchanged, as are metadata and structured data.
- No CMS, database, setup, authentication, deployment, or shell contracts change.

## Performance and accessibility

- three.js (about 160 KB gzipped) is a dynamic import started after first paint; the heading and
  call to action never wait on it. The canvas fades in once a frame exists.
- A quality ladder (pixel ratio, fur layers, multisampling, bloom) starts lower on phones and
  low-core devices and steps down when frames run long. It never steps back up.
- Rendering stops when the tab is hidden or the stage is off screen.
- `prefers-reduced-motion`: no intro, no idle motion, no particles; the scene is redrawn only
  when the reader scrolls or resizes.
- Without WebGL (or if the scene fails to load) a CSS night sky and an SVG Lumi stand in.
- On phones the scene takes the top of the screen. Copy fades as it scrolls into that band
  (CSS scroll-driven animation); browsers without it show the copy over the scene instead.
- The canvas is `aria-hidden`; controls are native links and buttons with visible focus.

## Files

- `src/components/storybook/StorybookLanding.tsx` and its CSS module: chapters, copy, controls.
- `src/components/storybook/StoryCanvas.tsx`: mounts the scene, feeds it scroll/pointer/level,
  owns the fallbacks.
- `src/components/storybook/StoryFaq.tsx`: the FAQ afterword and its `FAQPage` JSON-LD.
- `src/components/storybook/LumiMark.tsx`: the SVG Lumi (header logo and no-WebGL fallback).
- `src/components/storybook/scene/timeline.ts`: the choreography as pure numbers — where Lumi
  stands in each chapter, per layout. Unit-tested (`timeline.test.ts`); change staging here.
- `src/components/storybook/scene/lumi.ts`, `world.ts`, `props.ts`, `textures.ts`: the mascot,
  the stage, and one prop per chapter.
- `src/components/storybook/scene/createStoryScene.ts`: renderer, post-processing, the frame.
- `src/components/Header.tsx` and its CSS module: restyled to the storybook palette.

## Verification

`lint`, `typecheck`, `test` and `build` pass for `@lumibase/landing`. The page was checked in
headless Chromium on software WebGL (SwiftShader) at 1440×900 and an iPhone 13 viewport, with
each chapter centred, with reduced motion, and from the static export under `out/`.

Not verified: frame rate on real GPUs and real phones (software rendering says nothing about
it — the quality ladder is the mitigation, not a measurement), Safari and Firefox, and the
no-WebGL fallback in a browser that genuinely lacks WebGL.

## Local development

```sh
pnpm --filter @lumibase/landing dev --port 3010
pnpm --filter @lumibase/landing typecheck
pnpm --filter @lumibase/landing lint
pnpm --filter @lumibase/landing test
pnpm --filter @lumibase/landing build
```

This change is developed on `feature/storybook-landing`; production deployment is a separate action.

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
