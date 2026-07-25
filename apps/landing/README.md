# LumiBase Landing Page

Official landing page for lumibase.dev - built with Next.js, TypeScript, and Tailwind CSS.

## Features

- **Modern Design**: Clean, responsive landing page with hero section, features, and CTAs
- **SEO Optimized**: Meta tags, sitemap.xml, and robots.txt for search engines
- **Legal Pages**: Terms of Service, Privacy Policy, and License pages (MIT License)
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

This project is open-source and available under the MIT License. See the [License page](/license) for details.
