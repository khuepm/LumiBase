# LumiBase Landing Page

Official landing page for lumibase.dev - built with Next.js, TypeScript, and Tailwind CSS.

## Features

- **Modern Design**: Clean, responsive landing page with hero section, features, and CTAs
- **SEO Optimized**: Meta tags, sitemap.xml, and robots.txt for search engines
- **Legal Pages**: Terms of Service, Privacy Policy, and License pages (Apache License 2.0)
- **Cloudflare Ready**: Configured for deployment on Cloudflare Pages
- **Type-Safe**: Built with TypeScript for better developer experience
- **Dark Theme**: Ships as a dark-only theme (the root layout sets `class="dark"`)

## Development

### Prerequisites

- Node.js >= 20
- pnpm >= 9

### Installation

```bash
pnpm install
```

### Local Development

```bash
pnpm dev
```

Visit [http://localhost:3000](http://localhost:3000) to see the landing page.

### Build

```bash
pnpm build
```

### Type Checking

```bash
pnpm typecheck
```

### Linting

```bash
pnpm lint
```

## Deployment to Cloudflare Pages

### Option 1: Using Cloudflare Pages Dashboard

1. Build the project locally:
   ```bash
   pnpm build
   ```

2. Deploy the `out` directory to Cloudflare Pages via the dashboard

### Option 2: Using Cloudflare Pages with Git Integration

1. Push this branch to your GitHub repository
2. Connect your repository to Cloudflare Pages
3. Configure build settings:
   - **Build command**: `cd apps/landing && pnpm build`
   - **Build output directory**: `apps/landing/out`
   - **Node.js version**: 20

### Option 3: Using Wrangler CLI

```bash
# Install Wrangler
pnpm add -g wrangler

# Login to Cloudflare
wrangler login

# Deploy
wrangler pages deploy out
```

## Sponsor rewards store

`src/lib/rewards/` implements the GitHub Sponsors reward-token flow behind a
single `SponsorStore` interface, so every read and write (record a sponsorship,
look a token up, claim it) goes through one store:

| Implementation | Persistence | Use |
| --- | --- | --- |
| `InMemorySponsorStore` | process-local, lost on restart, not shared across instances | local dev and tests (**default**) |
| `D1SponsorStore` | Cloudflare D1 (SQLite) | deployed environments |

Claiming is atomic in both: given N concurrent requests with the same valid
token, exactly one succeeds and the rest get `Reward already claimed`. In D1
that is a single `UPDATE … WHERE reward_token = ? AND claimed = 0 RETURNING tier`
compare-and-set — no read-then-write race.

### Enabling persistence

The landing app currently builds as a static export (`output: 'export'`), so the
route handlers that use this module live in `src/_api-routes-disabled/` and are
not part of the build. Persistence is therefore wired up only when those routes
are re-enabled on a server runtime (e.g. `@cloudflare/next-on-pages`):

1. Create the database and apply the migration:

   ```bash
   wrangler d1 create lumibase-sponsors
   wrangler d1 migrations apply lumibase-sponsors --remote
   ```

2. Add the binding to `wrangler.toml` (a commented block is already there) using
   the `database_id` printed by `d1 create`.

3. Install the store once at request/boot time, before any rewards helper runs:

   ```ts
   import { getRequestContext } from '@cloudflare/next-on-pages';
   import { configureSponsorStore, resolveSponsorStore } from '@/lib/rewards';

   configureSponsorStore(resolveSponsorStore(getRequestContext().env));
   ```

`resolveSponsorStore(env)` returns a `D1SponsorStore` when `env.SPONSORS_DB` is
present and otherwise falls back to the in-memory store, logging a warning in
production. Without step 3 the module keeps working, but only in memory.

The table DDL lives in `migrations/0001_sponsors.sql` and is mirrored by
`SPONSORS_TABLE_DDL` in `src/lib/rewards/d1-store.ts` — keep the two in sync.

## Analytics and consent

Two measurement paths run side by side, and they are not interchangeable:

| Source | Cookies | Consent | Where it is configured |
| --- | --- | --- | --- |
| Cloudflare Web Analytics | none | not required | Cloudflare dashboard (Pages injects the beacon) — **not in this repo** |
| Google Analytics 4 | `_ga`, `_ga_<id>` | opt-in required | `NEXT_PUBLIC_GA_ID` at build time |

`src/lib/analytics/` owns the logic; `src/components/analytics/` owns the UI.

- **GA never loads before a grant.** `Analytics.tsx` does not render the tag
  `<Script>` at all until consent is `granted`. That is stricter than Consent Mode
  on its own, which loads the tag and merely withholds storage.
- **Advertising signals stay denied.** `buildGtagBootstrap()` emits
  `ad_storage`/`ad_user_data`/`ad_personalization` as `denied` plus
  `allow_google_signals: false`, and the test suite fails if a `granted` ever
  appears next to one of them.
- **The measurement ID is validated before it is interpolated.** It lands inside
  an inline `<script>`, so `resolveMeasurementId()` accepts only `G-XXXXXXX`; an
  ID of any other shape resolves to `null` (analytics off) and the builders throw.
- **Unset means invisible.** With no `NEXT_PUBLIC_GA_ID`, the layout renders no
  `<Analytics>`, the privacy page shows "not configured on this deployment", and
  no banner appears. Verify with `grep -rl googletagmanager out/`.
- **Withdrawal works after the fact.** The privacy page control clears the stored
  decision, flips Consent Mode back to `denied`, and deletes the `_ga*` cookies,
  then re-opens the banner so the visitor chooses again.

Page views on client-side navigations rely on GA4 enhanced measurement
("page changes based on browser history events", on by default). We deliberately
do **not** fire our own `page_view` on route change — that would double-count.

Deployment: set the repo variable `NEXT_PUBLIC_GA_ID` (Settings → Variables), which
`release.yml` and `pages-deploy.yml` pass to the build. It is inlined into the
static export, so rotating the property needs a rebuild, not a runtime change.

### Test coverage caveat

The landing vitest project runs `environment: 'node'` and only picks up
`src/**/*.test.ts`, so the pure logic above is covered but the banner interaction
is not. See `B17` in `.kiro/steering/out-of-scope-backlog.md`.

## Environment Variables

Copy `.env.example` to `.env.local` and configure:

```env
NEXT_PUBLIC_GITHUB_REPO=https://github.com/khuepm/lumibase
NEXT_PUBLIC_DOCS_URL=https://docs.lumibase.dev
# Optional — enables the GA4 tag behind an opt-in banner. Unset = no cookies.
NEXT_PUBLIC_GA_ID=G-XXXXXXXXXX
```

## Project Structure

```
apps/landing/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # Root layout with metadata
│   │   ├── page.tsx            # Landing page
│   │   ├── globals.css         # Global styles
│   │   ├── sitemap.ts          # Sitemap generation
│   │   ├── opengraph-image.tsx # Social share card
│   │   ├── pricing/            # Pricing page
│   │   ├── tos/                # Terms of Service
│   │   ├── privacy/            # Privacy Policy
│   │   └── license/            # License page
│   └── components/
│       ├── Header.tsx          # Site header with navigation
│       ├── Footer.tsx          # Site footer with links
│       ├── Hero.tsx            # Hero headline + orbital stage
│       ├── ProductSection.tsx  # Product pillar sections
│       ├── SectionVisuals.tsx  # Per-pillar mini-visuals
│       ├── TrustViz.tsx        # Trust-ladder visual
│       └── PricingCard.tsx     # Pricing tier card
├── public/
│   └── robots.txt              # SEO robots.txt
├── next.config.ts              # Next.js configuration
├── tailwind.config.ts          # Tailwind CSS configuration
├── tsconfig.json               # TypeScript configuration
└── package.json                # Dependencies
```

## Customization

### GitHub Repository Links

Replace `https://github.com/khuepm/lumibase` with your actual GitHub repository URL in:
- `src/components/Header.tsx`
- `src/components/Footer.tsx`
- `src/app/page.tsx`
- Environment variables

### Branding

Update the branding in:
- `src/app/layout.tsx` - Metadata and title
- `src/components/Header.tsx` - Logo and navigation
- `src/components/Footer.tsx` - Footer branding

### Colors

Modify the color scheme in `src/app/globals.css` and `tailwind.config.ts`.

## License

This project is open-source and available under the Apache License, Version 2.0. See the [License page](/license) for details. `v0.22.0` was the final release under the MIT License; the relicense to Apache 2.0 took effect in `v0.23.0`.
