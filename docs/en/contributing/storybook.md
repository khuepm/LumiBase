---
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:56:37.070Z
contentHash: f07af56f0b41a29c
codeVerified: 2026-11-15T16:56:37.070Z
codeVerifiedHash: f07af56f0b41a29c
codeVerifiedClaims: 16
---

# Storybook: UI catalogue, a11y and visual tests

LumiBase ships a Storybook for the `@lumibase/ui` primitives and for a representative set of Studio components: field interfaces, displays, a data table and dialogs. It is published with the docs site at [`/storybook/`](/storybook/).

Storybook has its own workspace package, `apps/storybook`. `packages/ui` and `apps/studio` carry no Storybook dependencies. Stories import Studio components from source through Studio's `@/` alias, so a story always renders the code that ships.

| What | Where |
| --- | --- |
| Storybook config (addons, Vite alias, relative base) | `apps/storybook/.storybook/main.ts` |
| Theme toolbar, QueryClient decorator, a11y gate | `apps/storybook/.storybook/preview.tsx` |
| `@lumibase/ui` stories | `apps/storybook/src/ui/` |
| Studio stories | `apps/storybook/src/studio/` |
| Field fixtures and label frames | `apps/storybook/src/support/fixtures.tsx` |
| Justified a11y exceptions | `apps/storybook/src/support/a11y.ts` |
| Visual regression script | `apps/storybook/scripts/visual-snapshots.mjs` |
| CI workflow | `.github/workflows/storybook.yml` |

Versions: Storybook `10.6.7` with `@storybook/react-vite`, which accepts Vite 5 to 8 (Studio is on Vite 8), and `@storybook/addon-vitest` on Vitest 5 browser mode with Playwright.

## Running it

```bash
pnpm storybook                                   # dev server on http://localhost:6006
pnpm storybook:build                             # static build → apps/storybook/storybook-static
pnpm --filter @lumibase/storybook test           # guards (node, fast)
pnpm storybook:test                              # every story in Chromium, light + dark
pnpm --filter @lumibase/storybook test:visual    # screenshots → apps/storybook/visual-output/current
```

The browser tests need a Chromium build that matches the `playwright` devDependency. On a fresh machine, run `pnpm --filter @lumibase/storybook exec playwright install chromium` once.

## Writing a story

1. Put it next to its peers: `src/ui/<name>.stories.tsx` for a `@lumibase/ui` export, `src/studio/<area>.stories.tsx` for Studio.
2. Use CSF 3 with a `title` under `UI/` or `Studio/`. Give each story the props it needs. Never call the CMS.
3. Data: a component that reads through TanStack Query gets a fresh `QueryClient` per story, with retries off. Seed it with `parameters.queryData: [[queryKey, data], …]`. Do not mock `fetch`.
4. Labels: Studio interfaces render inside a labelled form row. Wrap them in `FieldFrame`, or in `FieldGroupFrame` when the interface has several controls, so the a11y scan judges the control as users meet it.
5. Add a `play` function for behaviour that matters (typing, toggling, a disabled submit). It runs in CI as a test.
6. Keep it deterministic: fixed dates (or dates relative to render time), no random data, no timers. The visual check screenshots the final state after `play`.

### Every `@lumibase/ui` primitive has a story

The `guards` project uses the TypeScript compiler API to resolve every value export of `packages/ui/src/index.ts`. It fails when an export is not imported by any story under `src/ui/`. When you add a primitive (`Button`, `Dialog`, …), add its story in the same PR.

## Accessibility gate

`@storybook/addon-a11y` runs axe on every story, and `.storybook/preview.tsx` sets `parameters.a11y.test = 'error'`. Any violation fails `pnpm storybook:test`. The run happens twice, once per theme (`stories-light`, `stories-dark` Vitest projects), so colour contrast is checked against both palettes.

Fix the component whenever you can. When a violation really is not the component's to fix, disable that one rule for that one story with `a11yException()`:

```tsx
import { a11yException } from '../support/a11y';

export const InsideShellOnly: Story = {
  parameters: a11yException([
    { rule: 'region', justification: 'Rendered without the app shell landmarks; the real page wraps it in <main>.' },
  ]),
};
```

The justification must be at least 40 characters. The guards fail when a story disables the gate any other way (`enabled: false`, `test: 'off' | 'todo'`, `disable: true`, `manual: true`). There are no exceptions today. Wiring up the gate found real issues, and they were fixed in Studio:

- the light `--muted-foreground` and both `--destructive` tokens missed WCAG AA 4.5:1 (dark-mode destructive text was about 2:1);
- `rating-stars` put `aria-label` on a plain `span` (now `role="img"`);
- the save-bookmark dialog had no accessible name;
- the slider, colour and tags interfaces had inputs without a name.

## Light and dark

The toolbar **Theme** global toggles the `.dark` class on `<html>`, the same switch Studio's `site-theme.tsx` uses. Every story must read well in both themes. CI tests both, and the visual check captures both.

## Visual regression

`scripts/visual-snapshots.mjs capture` serves a static build and takes a screenshot of every story in both themes, with fixed settings: viewport 800×600, scale 1, `en-US`, UTC, reduced motion, and animations, transitions and the caret turned off. `compare` diffs two captures with pixelmatch. A snapshot counts as changed when more than 0.1% of its pixels differ.

On pull requests, the `visual` job captures the **base** and **head** builds on the **same runner** and compares them. We chose this over committed baseline PNGs. Baselines rendered on a contributor's machine never match a CI runner's font rasterisation. They also add binary churn to every UI change. Comparing on one machine cancels both out. Diff images, plus both captures, are uploaded as the `storybook-visual-diff` artifact, and the job summary lists the changed snapshots. An intended visual change fails the job until a maintainer adds the `visual-change-approved` label.

## Publishing

The release workflow (`pages-deploy.yml`) runs `pnpm storybook:build` before `pnpm docs:build`. The docs build ends with `apps/docs/scripts/copy-storybook.mjs`, which copies `storybook-static` into `apps/docs/dist/storybook/`. Storybook builds with a relative base, so it works from that sub-path without a redirect rule. `STORYBOOK_REQUIRED=1` makes a release fail rather than ship the navbar's **Storybook** link pointing at nothing. Local docs builds without a Storybook build print a warning and skip the copy. The deploy check also fetches `/storybook/index.json`.
