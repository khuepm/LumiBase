/**
 * Shared HTTP helpers for the bootstrap and seed scripts.
 *
 * These run on the server only. The admin token they use is deliberately never
 * exposed to the browser: it lives in `LUMIBASE_ADMIN_TOKEN` (no `NEXT_PUBLIC_`
 * prefix), so Next.js cannot inline it into the client bundle.
 */

import { readFile, writeFile } from 'node:fs/promises';

export const CMS_URL = (
  process.env.NEXT_PUBLIC_LUMIBASE_URL ?? 'http://localhost:1989'
).replace(/\/$/, '');

export const SITE_ID = process.env.NEXT_PUBLIC_LUMIBASE_SITE_ID ?? '__default__';

/** The collection this starter ships. One collection, three fields. */
export const COLLECTION = 'posts';

export class CmsError extends Error {
  constructor(status, body, path) {
    // A validation failure carries its reasons in `details`, not `message` —
    // without this the error reads "VALIDATION_ERROR:" and says nothing.
    const detail =
      body?.errors
        ?.map((e) => {
          const reasons = Array.isArray(e.details)
            ? e.details
                .map((d) => `${Array.isArray(d.path) ? d.path.join('.') : d.path ?? ''} ${d.message ?? ''}`.trim())
                .join(', ')
            : '';
          return [e.code ?? 'ERROR', e.message || reasons].filter(Boolean).join(': ');
        })
        .join('; ') ?? (typeof body === 'string' ? body : JSON.stringify(body));
    super(`${path} → ${status} ${detail}`);
    this.name = 'CmsError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Call the CMS.
 *
 * `token` is optional so the same helper can drive the unauthenticated setup
 * wizard and, later, the authenticated admin calls.
 */
export async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const res = await fetch(`${CMS_URL}${path}`, {
    method,
    headers: {
      'x-lumi-site': SITE_ID,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!res.ok) throw new CmsError(res.status, parsed, path);
  return parsed;
}

/** Wait for the CMS to answer /health — the container runs migrations first. */
export async function waitForCms({ attempts = 60, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(`${CMS_URL}/health`);
      if (res.ok) return;
    } catch {
      // connection refused while the container is still starting
    }
    if (i === attempts) {
      throw new Error(
        `CMS did not become healthy at ${CMS_URL} after ${attempts} attempts.\n` +
          'Is it running? Try: npm run cms:up && npm run cms:logs',
      );
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** Log in and return a short-lived admin access token. */
export async function login(email, password) {
  const out = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  const token = out?.data?.token;
  if (!token) throw new Error('Login succeeded but returned no access token.');
  return token;
}

/**
 * Persist values back into `.env`.
 *
 * Rewrites keys in place when present and appends them otherwise, so running
 * bootstrap twice updates rather than duplicates.
 */
export async function updateEnvFile(updates, file = '.env') {
  let content = '';
  try {
    content = await readFile(file, 'utf8');
  } catch {
    content = '';
  }

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    content = pattern.test(content)
      ? content.replace(pattern, line)
      : `${content.replace(/\n*$/, '\n')}${line}\n`;
  }

  await writeFile(file, content, 'utf8');
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Fill it in .env (see .env.example).`);
  }
  return value;
}
