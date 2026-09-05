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
