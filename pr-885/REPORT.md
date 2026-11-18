# PR #885 — storybook landing vs iridescent landing: visual and performance evidence

- **storybook**: `feature/storybook-landing` @ `681dad62` (WebGL/three.js scene, PR #885)
- **iridescent**: `feature/iridescent-landing` @ `75a0b1b6` (static images + CSS, comparison baseline)

Both built with `pnpm --filter @lumibase/landing build` (Next 16, `output: 'export'`) and served from `out/` with `python3 -m http.server` on 127.0.0.1 (no compression — byte counts are uncompressed, with a gzip-6 estimate alongside). No source on either branch was modified.

## Environment limits (read first)

- Headless Chromium (Playwright) on a 4-core Linux container with **no GPU**. WebGL ran on **SwiftShader** (CPU rasterisation). Absolute frame times and TBT for the scene are **not representative of real devices**; the relative comparison and throttled runs are indicative only.
- "iPhone 13" / "Pixel 7" are Playwright device emulations (viewport, DPR, UA, touch) on the **Chromium engine** — the iPhone runs are not WebKit.
- "CPU 4x" = CDP `Emulation.setCPUThrottlingRate(4)`. It throttles the renderer main thread only, not the GPU process where SwiftShader rasterises.
- No network throttling (localhost).
- **Not tested: real Safari/WebKit, Firefox, real low-end / low-memory phones, any real GPU.** No physical device was available.

## Method

- Captures: scroll each chapter (`#top`, `#content-os`, `#ai-harness`, `#studio`, `#mcp`, `#provenance`, `#runtime`) to centre, wait for `canvas[data-live="true"]` (set after the first drawn frame) + 1.8 s, JPEG q80. Desktop 1440×900, iPhone 13, Pixel 7; `reducedMotion: 'reduce'` (desktop + iPhone 13); no-WebGL (`--disable-webgl --disable-webgl2 --disable-gpu` + init script making `getContext('webgl'|'webgl2'|'experimental-webgl')` return `null`) on desktop + iPhone 13.
- Metrics: 5 cold runs per variant per config (fresh browser/context, cache disabled, variants interleaved). Navigation Timing, FCP/LCP (LCP read before scrolling), `longtask` observer, bytes/requests from CDP `encodedDataLength`, storybook first frame via `data-live`. TBT = Σ(long task − 50 ms) during load (until first frame + 3 s) and during a 10 s scripted scroll sweep. rAF frame intervals: 5 s idle on hero, then during the sweep (">16.7 ms" uses 17.5 ms for vsync jitter, ">33 ms" uses 34 ms). Medians shown; raw data in `metrics-*.json`.

## Load comparison (desktop, unthrottled, median of 5)

| Metric | storybook | iridescent |
|---|---:|---:|
| TTFB | 5.6 ms | 4.9 ms |
| DOMContentLoaded | 50 ms | 58 ms |
| load | 233 ms | 390 ms |
| FCP | 224 ms | 328 ms |
| LCP | 224 ms (text) | 348 ms |
| Scene first frame | 954 ms (831–1053) | n/a |
| Requests | 21 | 33 |
| Bytes (uncompressed) | 1.81 MB | 2.20 MB |
| Bytes (gzip-6 est.) | 0.74 MB | 1.58 MB (images) |
| JS (uncompressed / gzip est.) | 1,177 KB / 323 KB | 540 KB / 161 KB |
| Largest JS chunk (gzip) | 160 KB (three.js, dynamic import) | 71 KB |
| Long tasks during load | 4 | 1 |
| TBT load | 6,395 ms (longest 5,849 ms) | 20 ms (longest 70 ms) |
| TBT 10 s scroll | 10,441 ms (12 long tasks) | 0 ms |

Other configs (ms, median of 5):

| Config | Variant | FCP | LCP | First frame | TBT load | Longest task | TBT scroll |
|---|---|---:|---:|---:|---:|---:|---:|
| desktop CPU 4x | storybook | 384 | 384 | 1,892 | 4,255 | 3,237 | 9,673 |
| desktop CPU 4x | iridescent | 444 | 444 | n/a | 172 | 150 | 0 |
| Pixel 7 CPU 4x | storybook | 340 | 340 | 1,788 | 3,777 | 2,428 | 8,285 |
| Pixel 7 CPU 4x | iridescent | 336 | 336 | n/a | 152 | 141 | 0 |
| desktop reduced motion | storybook | 160 | 160 | 563 | 3,009 | 2,754 | 8,613 |
| desktop reduced motion | iridescent | 276 | 276 | n/a | 10 | 59 | 0 |

Storybook's FCP/LCP are earlier because the heading is plain HTML and three.js is imported after first paint. Its large TBT is the WebGL scene on the main thread; under SwiftShader every GL call is CPU rasterisation, which produces multi-second tasks. The scene does add main-thread work after the page is interactive; its size on a real GPU/phone was not measured.

## Frame budget (rAF intervals, median of 5)

| Config | Variant | Phase | Median | p95 | % >16.7 ms | % >33 ms | ~fps |
|---|---|---|---:|---:|---:|---:|---:|
| desktop | storybook | idle 5 s | 667 ms | 1,083 ms | 100 | 100 | 1.4 |
| desktop | storybook | scroll 10 s | 983 ms | 1,317 ms | 100 | 100 | 1.0 |
| desktop | iridescent | idle 5 s | 16.7 ms | 16.8 ms | 5.0 | 0.7 | 56 |
| desktop | iridescent | scroll 10 s | 16.7 ms | 16.8 ms | 4.2 | 0.5 | 57 |
| desktop CPU 4x | storybook | idle | 400 ms | 567 ms | 100 | 100 | 2.3 |
| desktop CPU 4x | storybook | scroll | 583 ms | 733 ms | 100 | 100 | 1.8 |
| desktop CPU 4x | iridescent | idle | 16.7 ms | 16.8 ms | 1.4 | 0 | 59 |
| desktop CPU 4x | iridescent | scroll | 16.7 ms | 16.8 ms | 0.8 | 0 | 60 |
| Pixel 7 CPU 4x | storybook | idle | 200 ms | 233 ms | 100 | 100 | 5.1 |
| Pixel 7 CPU 4x | storybook | scroll | 250 ms | 300 ms | 100 | 100 | 3.9 |
| Pixel 7 CPU 4x | iridescent | idle | 16.7 ms | 16.8 ms | 0 | 0 | 60 |
| Pixel 7 CPU 4x | iridescent | scroll | 16.7 ms | 16.7 ms | 0 | 0 | 60 |
| desktop reduced motion | storybook | idle | 16.7 ms | 16.7 ms | 0 | 0 | 60 |
| desktop reduced motion | storybook | scroll | 300 ms | 383 ms | 94 | 94 | 3.4 |
| desktop reduced motion | iridescent | idle | 16.7 ms | 16.8 ms | 0 | 0 | 60 |
| desktop reduced motion | iridescent | scroll | 16.7 ms | 33.3 ms | 9.1 | 0.4 | 55 |

Storybook produced only 5–41 frames per phase (p95 ≈ max); iridescent ~270–600.

- Under SwiftShader storybook never reaches an interactive frame rate (1–5 fps); iridescent holds ~60 fps everywhere.
- Pixel 7 is ~3× faster than desktop for storybook: lower starting quality tier and a 412 CSS-px canvas suit fill-rate-bound rendering.
- Desktop CPU 4x is *better* than unthrottled: throttling does not slow SwiftShader and 4 shared cores are noisy. Not evidence that throttling helps.
- Reduced motion works as designed (no idle rendering); each scroll frame still costs ~300 ms here.
- Frame rate on a real GPU/phone: not measured.

## Visual observations (images reviewed)

**Storybook, desktop** (`storybook-desktop-01..07-*.jpg`)
- Copy legible in every chapter; scene right, copy left.
- `-04-studio.jpg`: Lumi peeks over the Mission Control card corner (looks intentional). `-06-provenance.jpg`: Lumi overlaps the moon (cosmetic).
- **Epilogue: Lumi in transit for a long time.** `-07-runtime.jpg` (1.8 s after arriving): Lumi stretched into an egg shape over "Explore the license" and "next chapter." `storybook-desktop-epilogue-t2000/6000/10000ms.jpg`: it settles round below the buttons after ~10 s. Likely cause: `createStoryScene.ts:365` caps the per-frame timestep at 0.05 s, so below 20 fps all motion runs slow (here ~1/10 speed) and the motion stretch (`:470`) lingers. Any real device under 20 fps would show the same.
- **Hero intro slowed the same way**: `storybook-desktop-hero-t500/3000/7000ms.jpg` — still small, tilted and squinting 7 s after first frame. The reduced-motion hero shows the intended final pose.
- **Quality ladder (code reading, not observed)**: the watchdog ignores frames > 0.5 s (`createStoryScene.ts:330`) and needs 24 warm-up + 60 sampled frames before deciding, so on very slow devices it may never step down, and at 2–5 fps a decision takes 17–40 s. Whether it stepped down in these runs was not measured.

**Storybook, mobile** (`storybook-iphone13-*.jpg`, `storybook-pixel7-*.jpg`)
- Scene occupies the top band; copy fades as it scrolls into it.
- With a chapter centred, its heading sits in that band half-faded with scene objects behind it: `storybook-iphone13-02-content-os.jpg` ("Declare intent" nearly invisible under the pages and Lumi), `-03-ai-harness.jpg` (stars behind "You set the limits.").
- At reading position (heading ~55% of viewport) every heading and body text is clear and legible: `storybook-iphone13-reading-{content-os,ai-harness,studio,mcp}.jpg`.
- Pixel 7: a glowing star behind "CHAPTER TWO" + heading (`storybook-pixel7-03-ai-harness.jpg`); Lumi touches "THE LOOKING GLASS" (`-04-studio.jpg`). Local contrast drops; text still readable.
- Moon shows a dark disc where it overlaps Lumi (`storybook-*-05-provenance.jpg`) — minor artefact.
- Epilogue Lumi again egg-shaped in transit (`storybook-iphone13-06-runtime.jpg`). No horizontal overflow at any viewport.

**Storybook, reduced motion**: final poses immediately, no particles. The mobile copy fade still applies (`storybook-iphone13-reduced-motion-02-ai-harness.jpg`).

**Storybook, no WebGL** (`storybook-nowebgl-*.jpg`)
- Fallback triggers (canvas stays `data-live="false"`, `.fallback` visible), no console errors, all copy present.
- Desktop: SVG Lumi right of centre, clear of the hero copy; dimmed through the Mission Control card on chapter 3. The CSS night sky is very subtle (few stars).
- **iPhone 13: the 260 px SVG Lumi sits centred behind the hero body text and buttons.** Its cream body is under white text and the "Read the docs" label nearly disappears (`storybook-nowebgl-iphone13-01-hero.jpg`) — a real contrast problem. Chapter 2: Lumi shows through the level cards — readable but cluttered.

**Iridescent (baseline)**: all copy legible at every viewport. The footer video (`flower.mp4` from `api.getlayers.ai`) failed with `net::ERR_ABORTED` in this sandbox, leaving a black band with a "PAUSE VIDEO" button (`iridescent-desktop-07-runtime.jpg`). `Footer.tsx` is shared by both branches, so this is environmental, not variant-specific.

**Console**: storybook WebGL runs logged 2–4 "GPU stall due to ReadPixels" warnings each (screenshot readback on SwiftShader). No error-level messages or page errors in either variant or any perf run.

## Not tested

- Real Safari/WebKit (the "iPhone 13" runs are Chromium with an iPhone UA)
- Firefox
- Real low-end / low-memory devices, thermal throttling, battery saver, 30 fps-locked displays
- Any real GPU (all WebGL numbers are SwiftShader)
- Throttled network, production CDN compression
- Whether the quality ladder stepped down during these runs

## Decision

These captures and numbers describe behaviour under the conditions above. **The final visual direction is the user's decision**; this report does not recommend either variant.
