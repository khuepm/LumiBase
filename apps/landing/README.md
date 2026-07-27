# LumiBase Landing Page

Official landing page for lumibase.dev - built with Next.js, TypeScript, and Tailwind CSS.

## Features

- **Modern Design**: Clean, responsive landing page with hero section, features, and CTAs
- **SEO Optimized**: Meta tags, sitemap.xml, and robots.txt for search engines
- **Legal Pages**: Terms of Service, Privacy Policy, and License pages (MIT License)
- **Cloudflare Ready**: Configured for deployment on Cloudflare Pages
- **Type-Safe**: Built with TypeScript for better developer experience
- **Dark Mode Support**: Automatic dark mode based on system preferences

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

## Environment Variables

Copy `.env.example` to `.env.local` and configure:

```env
NEXT_PUBLIC_GITHUB_REPO=https://github.com/khuepm/lumibase
NEXT_PUBLIC_DOCS_URL=https://docs.lumibase.dev
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
│   │   ├── tos/                # Terms of Service
│   │   ├── privacy/            # Privacy Policy
│   │   └── license/            # License page
│   └── components/
│       ├── Header.tsx          # Site header with navigation
│       └── Footer.tsx          # Site footer with links
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

This project is open-source and available under the MIT License. See the [License page](/license) for details.
