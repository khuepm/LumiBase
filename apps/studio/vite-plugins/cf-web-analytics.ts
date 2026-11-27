import type { Plugin } from 'vite';

/**
 * Cloudflare Web Analytics beacon for the hosted Studio (#1045).
 *
 * The Studio is open source and self-hostable, so the beacon is never part of
 * the default build: a self-hosted Studio must not report page views to the
 * LumiBase Cloudflare account. It is injected only when the build sets
 * `LUMIBASE_CF_WEB_ANALYTICS_TOKEN`, which the workflows that deploy
 * `studio.lumibase.dev` do.
 *
 * The beacon host is allowed in `apps/studio/public/_headers` (`script-src`);
 * the CMS-served Studio (Docker) keeps `script-src 'self'` and never gets the
 * tag. The token is public by design (it ships in the page), so it is not a
 * secret, but it is validated so a malformed value cannot inject markup.
 */
export const CF_WEB_ANALYTICS_TOKEN_ENV = 'LUMIBASE_CF_WEB_ANALYTICS_TOKEN';
export const CF_BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

const TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export function cfBeaconTag(token: string): string {
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`${CF_WEB_ANALYTICS_TOKEN_ENV} must be 32 lowercase hex characters.`);
  }
  return `<script defer src="${CF_BEACON_SRC}" data-cf-beacon='{"token": "${token}"}'></script>`;
}

/** The page with the beacon before `</body>`, or unchanged without a token. */
export function injectCfBeacon(html: string, token: string | undefined): string {
  const trimmed = token?.trim() ?? '';
  return trimmed ? html.replace('</body>', `    ${cfBeaconTag(trimmed)}\n  </body>`) : html;
}

export function cfWebAnalyticsPlugin(token: string | undefined = process.env[CF_WEB_ANALYTICS_TOKEN_ENV]): Plugin {
  // Validate at config time so a bad value fails the build, not the page.
  injectCfBeacon('', token);
  return {
    name: 'lumibase-cf-web-analytics',
    apply: 'build',
    transformIndexHtml(html) {
      return injectCfBeacon(html, token);
    },
  };
}
