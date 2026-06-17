#!/usr/bin/env node
/**
 * Idempotently attach a custom domain to a Cloudflare Pages project so the
 * hostname serves a given branch's deployments. Wrangler has no command for
 * Pages-domain-per-branch, so the CI deploy workflows call this against the
 * Cloudflare API instead of requiring a manual dashboard step.
 *
 * Usage:
 *   node scripts/ensure-pages-domain.mjs --project <name> --domain <host>
 *
 * Required env:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN   (needs Pages:Edit)
 *
 * Behaviour:
 *   - If the domain is already attached → no-op, exit 0.
 *   - If absent → create it, exit 0.
 *   - Missing credentials → warn and exit 0 (mirrors the can_deploy guard so
 *     unconfigured forks don't fail CI).
 *   - API/permission error → exit 1 with the Cloudflare error surfaced.
 *
 * Note: attaching the domain to the Pages project is enough for Cloudflare to
 * create the proxied DNS record automatically; no separate DNS call is needed.
 */

function parseArgs(argv) {
  const args = { project: '', domain: '' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--project') args.project = argv[++i];
    else if (v === '--domain') args.domain = argv[++i];
    else throw new Error(`Unknown argument: ${v}`);
  }
  if (!args.project) throw new Error('Missing required --project <name>');
  if (!args.domain) throw new Error('Missing required --domain <host>');
  return args;
}

async function cf(path, token, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function formatErrors(body) {
  if (Array.isArray(body?.errors) && body.errors.length) {
    return body.errors.map((e) => `${e.code ?? '?'}: ${e.message ?? JSON.stringify(e)}`).join('; ');
  }
  return JSON.stringify(body);
}

async function main() {
  const { project, domain } = parseArgs(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !token) {
    console.warn(
      `::warning::Skipping Pages domain attach for ${domain} — CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is not set.`,
    );
    return;
  }

  const base = `/accounts/${accountId}/pages/projects/${project}/domains`;

  // 1. Already attached? Then we're done.
  const list = await cf(base, token);
  if (!list.ok) {
    console.error(`Failed to list Pages domains for project "${project}": ${formatErrors(list.body)}`);
    process.exit(1);
  }
  const existing = (list.body?.result ?? []).find((d) => d?.name === domain);
  if (existing) {
    console.log(`Pages domain ${domain} already attached to ${project} (status: ${existing.status ?? 'unknown'}).`);
    return;
  }

  // 2. Attach it. Cloudflare provisions the proxied DNS record automatically.
  const create = await cf(base, token, {
    method: 'POST',
    body: JSON.stringify({ name: domain }),
  });
  if (!create.ok) {
    console.error(`Failed to attach Pages domain ${domain} to ${project}: ${formatErrors(create.body)}`);
    process.exit(1);
  }
  console.log(`Attached Pages domain ${domain} to ${project}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
