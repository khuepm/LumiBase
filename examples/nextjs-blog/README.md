# Next.js Blog Example with LumiBase SDK

This is a minimal, performance-optimized blog application built with Next.js (App Router, Server Components) that fetches data using the type-safe `@lumibase/sdk`.

## Features
- **Server-Side Fetching**: Fetches articles directly inside React Server Components.
- **Type-Safety**: Configured using a schema interface for compiler checks and auto-completion.
- **Dynamic SSG / ISR**: Demonstrates `generateStaticParams` for pre-rendering pages and `revalidate = 60` for Incremental Static Regeneration.

## Getting Started

1. **Configure Environment Variables**:
   Copy `.env.example` to `.env.local` and fill in the values:
   ```bash
   cp .env.example .env.local
   ```
   Set `LUMIBASE_TOKEN` and `LUMIBASE_SITE_ID` to match your local setup or cloud deploy.

2. **Install & Run**:
   ```bash
   pnpm install
   pnpm dev
   ```

3. **Open the Application**:
   Navigate to `http://localhost:3000`.
