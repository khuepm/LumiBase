import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  const candidates = [
    "playwright",
    "/Users/jane/.shared-skills/Browser/node_modules/playwright",
    "/Users/jane/ZenDrop/node_modules/playwright",
    "/Users/jane/.nvm/versions/node/v22.14.0/lib/node_modules/@playwright/mcp/node_modules/playwright",
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try next candidate.
    }
  }
  throw new Error("Playwright not found. Run `npm install -D playwright` in the clone project, or install the Browser skill dependencies.");
}

export async function launchChromium(chromium) {
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const options = {
    headless: true,
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
  };
  try {
    return await chromium.launch(options);
  } catch (firstError) {
    try {
      return await chromium.launch({ ...options, channel: "chrome" });
    } catch {
      throw firstError;
    }
  }
}
