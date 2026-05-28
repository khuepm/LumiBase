/**
 * Cloudflare Workers entrypoint.
 *
 * This file is used as `main` in wrangler.toml for Cloudflare deployments.
 * It re-exports the Hono app default export AND the Durable Object classes
 * that Wrangler needs to register (via class_name in wrangler.toml).
 *
 * IMPORTANT: Do NOT import this file from serve.ts or any Node.js code path.
 * `site-room.ts` imports `cloudflare:workers` which is unavailable in Node.js
 * and will crash the Docker build.
 *
 * Build targets:
 *   - Cloudflare Workers: wrangler deploy (uses this file via wrangler.toml)
 *   - Docker / Node.js:   esbuild src/serve.ts → dist/serve.js (index.ts, no SiteRoom)
 */

// Hono app (shared between CF and Node builds via index.ts)
export { default } from './index';

// Durable Object class — only bundled by Wrangler's CF bundler.
// Wrangler reads `class_name = "SiteRoom"` in wrangler.toml and expects
// this export to exist in the compiled worker bundle.
export { SiteRoom } from './realtime/site-room';
