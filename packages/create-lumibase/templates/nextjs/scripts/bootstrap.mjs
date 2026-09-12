/**
 * One-time provisioning: first admin, public access, and a browser-safe key.
 *
 * Run once after `npm run cms:up`:
 *
 *   npm run cms:bootstrap
 *
 * Idempotent. The CMS answers ALREADY_INITIALIZED once setup has run, and every
 * later step either upserts or is safe to repeat, so re-running after a partial
 * failure picks up where it stopped.
 *
 * ## The security-critical part
 *
 * The website is a public site: anyone can read it, nobody logs in. That means
 * the browser must NOT hold an admin credential. Two things make that true:
 *
 *  1. The browser gets a *publishable* key (`lbk_pub_`), never the admin token.
 *     The admin token exists only in this process and in `LUMIBASE_ADMIN_TOKEN`,
 *     which has no `NEXT_PUBLIC_` prefix and so cannot reach the bundle.
 *
 *  2. The grant is `publishedOnly`, which compiles to the row filter
 *     `status = published`. Without it a read grant would also serve drafts:
 *     `GET /api/v1/items` applies no implicit published-only filter of its own.
 *     `verify.mjs` asserts a draft stays invisible.
 */

import {
  api,
  login,
  waitForCms,
  updateEnvFile,
  requireEnv,
  COLLECTION,
  CmsError,
} from './lumibase.mjs';

const ADMIN_EMAIL = requireEnv('LUMIBASE_ADMIN_EMAIL');
const ADMIN_PASSWORD = requireEnv('LUMIBASE_ADMIN_PASSWORD');
const ADMIN_PATH = process.env.LUMIBASE_ADMIN_PATH || 'admin-a7f3c1';
const PUBLIC_ORIGIN = process.env.LUMIBASE_PUBLIC_ORIGIN || 'http://localhost:3000';
const SETUP_TOKEN = process.env.LUMIBASE_SETUP_TOKEN;

const step = (n, msg) => console.log(`\n[${n}/6] ${msg}`);

async function runSetup() {
  step(1, 'Creating the first administrator…');

  // `/setup/state` answers with the bare object, not the `{ data }` envelope.
  const state = await api('/api/v1/setup/state');
  if (state?.state === 'initialized') {
    console.log('      already initialized — skipping');
    return;
  }

  // Only sent when the instance actually asks for it. The default stack does
  // not enable the setup-token gate — see the comment in docker-compose.yml.
  if (state?.requiresSetupToken && !SETUP_TOKEN) {
    throw new Error(
      'This CMS requires a setup token, but LUMIBASE_SETUP_TOKEN is not set.\n' +
        'Note that v1.0.0-rc.1 never prints one: the flag gates setup without\n' +
        'any way to obtain the token. Unset LUMIBASE_REQUIRE_SETUP_TOKEN on the\n' +
        'container, recreate it, and run this again.',
    );
  }

  await api('/api/v1/setup/complete', {
    method: 'POST',
    body: {
      ...(SETUP_TOKEN ? { setupToken: SETUP_TOKEN } : {}),
      account: {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        firstName: 'Site',
        lastName: 'Admin',
      },
      adminPath: ADMIN_PATH,
      project: {
        defaultLanguage: 'en',
        siteUrl: PUBLIC_ORIGIN,
        displayTitle: 'My LumiBase site',
      },
    },
  });
  console.log('      done');
}

/** The editable shape Studio renders a form for. */
const FIELDS = [
  { name: 'title', type: 'string', interface: 'input', required: true },
  { name: 'slug', type: 'string', interface: 'input', required: true },
  { name: 'body', type: 'text', interface: 'textarea' },
];

async function ensureCollection(token) {
  step(3, `Creating the "${COLLECTION}" collection…`);
  try {
    // NOTE: `fields` is deliberately NOT sent here.
    //
    // `POST /api/v1/collections` validates with a schema that has no `fields`
    // property, so Zod strips it silently — the request succeeds, returns 201,
    // and creates a collection with no fields at all. Items still save, because
    // item validation accepts undeclared JSON keys, so nothing looks wrong until
    // Studio renders "No editable fields" and the edit flow this starter exists
    // to demonstrate is dead.
    //
    // Fields go through the field endpoint below instead.
    await api('/api/v1/collections', {
      method: 'POST',
      token,
      body: { name: COLLECTION, displayTemplate: '{{title}}' },
    });
    console.log('      done');
  } catch (err) {
    // A second run finds it already there. Anything else is a real failure.
    if (err instanceof CmsError && (err.status === 409 || err.status === 422)) {
      console.log('      already exists — skipping');
    } else {
      throw err;
    }
  }

  // Always reconcile the fields, even when the collection already existed: a
  // collection created by an earlier run of this script (or by a run that
  // failed here) would otherwise stay unusable in Studio forever.
  step('3b', 'Ensuring the editable fields…');
  // Fields come from their own endpoint: `GET /collections/:name` returns the
  // collection row only, with no `fields` key, so reading them from there
  // silently yields an empty set — which would make this block re-PUT every
  // field on every run and, worse, make the check at the end vacuous.
  const before = await api(`/api/v1/collections/${COLLECTION}/fields`, { token });
  const existing = new Set((before?.data ?? []).map((f) => f?.name));

  for (const field of FIELDS) {
    if (existing.has(field.name)) {
      console.log(`      = ${field.name} (already there)`);
      continue;
    }
    // PUT is an upsert keyed by field name, so this is safe to repeat.
    const { name, ...rest } = field;
    await api(`/api/v1/collections/${COLLECTION}/fields/${name}`, {
      method: 'PUT',
      token,
      body: rest,
    });
    console.log(`      + ${name}`);
  }

  // Prove it rather than assume it: a field that silently failed to register
  // leaves Studio with nothing to edit, which is exactly the failure this
  // block exists to prevent.
  const after = await api(`/api/v1/collections/${COLLECTION}/fields`, { token });
  const got = new Set((after?.data ?? []).map((f) => f?.name));
  const missing = FIELDS.map((f) => f.name).filter((n) => !got.has(n));
  if (missing.length > 0) {
    throw new Error(
      `The collection still has no ${missing.join(', ')} field(s). ` +
        'Studio would show "No editable fields" and the edit flow would not work.',
    );
  }
}

async function enablePublicRead(token) {
  step(4, 'Enabling public read access (published items only)…');

  // Provisioning the anonymous realm is a deliberate, audited act — a grant
  // will not do it as a side effect.
  const enabled = await api('/api/v1/access/grants/public/enable', {
    method: 'POST',
    token,
  });
  const roleId = enabled?.data?.roleId;
  if (!roleId) throw new Error('Enabling public access returned no roleId.');

  await api('/api/v1/access/grants/public', {
    method: 'POST',
    token,
    body: {
      collection: COLLECTION,
      action: 'read',
      // Explicit, even though `read` defaults it on. This is the line that
      // keeps drafts off the public website; it should not depend on a
      // server-side default staying what it is today.
      publishedOnly: true,
      fields: ['title', 'slug', 'body', 'status'],
    },
  });

  console.log('      done — anonymous readers see published posts only');
  return roleId;
}

/**
 * This project's identity, and why a display name is not enough.
 *
 * The key used to be found by the literal name "Website (publishable)". Every
 * project generated from this template writes that same name, so a second site
 * bootstrapped against the same CMS would find the FIRST site's key, decide it
 * owned it, and rotate it — silently breaking a running website, and still not
 * working itself, since rotation keeps the original origin allowlist.
 *
 * Ownership is therefore carried in the key's metadata under a per-project id,
 * with the origin as the natural key: one website serves one origin, and a key
 * is only reusable by the project whose origin it is locked to. The name stays
 * for humans reading the Studio list.
 */
const KEY_NAME = `Website (${PUBLIC_ORIGIN})`;
const OWNER_TAG = `lumibase-starter:${PUBLIC_ORIGIN}`;

/** Does this key belong to THIS project? Never match on the display name. */
function isOwnedByThisProject(key) {
  const owner = key?.metadata?.starterOwner;
  return owner === OWNER_TAG;
}

/**
 * Is this token actually usable right now?
 *
 * A token sitting in `.env` proves nothing: it may have been revoked, rotated
 * from Studio, or left over from a run that created a replacement and then
 * failed before saving it. Reusing it unchecked let bootstrap report success
 * while the website kept receiving 401, with a rerun unable to recover.
 *
 * So the token is spent against the API the website will use, with the Origin
 * the browser will send. A 2xx means usable; 401/403 means it is not, and the
 * caller rotates. Any other failure is left to bubble: a broken CMS must not be
 * read as "the token is fine".
 */
async function tokenWorks(candidate) {
  if (!candidate) return false;
  try {
    await api(`/api/v1/items/${COLLECTION}?limit=1`, {
      token: candidate,
      headers: { origin: PUBLIC_ORIGIN },
    });
    return true;
  } catch (err) {
    if (err instanceof CmsError && (err.status === 401 || err.status === 403)) return false;
    throw err;
  }
}

/**
 * Ensure exactly ONE publishable key for this project, and return a token that
 * has been proven to work.
 *
 *   - our key + a token that still authenticates → reuse it
 *   - our key + a dead or missing token          → rotate it (same key, new token)
 *   - no key of ours                             → create one
 *
 * Rotation is the honest move for the middle case: the plaintext is returned
 * only at creation, so a lost token cannot be recovered — but the key's
 * identity, roles and origin allowlist survive, and the old token stops working,
 * which is what you want from a credential you have lost track of.
 */
async function ensurePublishableKey(token, roleId) {
  step(5, 'Ensuring a publishable (browser-safe) API key…');

  const existing = await api('/api/v1/api-keys', { token });
  const mine = (existing?.data ?? []).find(
    (k) => k?.publishable && !k?.revokedAt && isOwnedByThisProject(k),
  );

  let keyId;
  let plaintext;

  if (mine && (await tokenWorks(process.env.NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY))) {
    console.log('      reusing the existing key (token verified)');
    keyId = mine.id;
    plaintext = process.env.NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY;
  } else if (mine) {
    console.log('      our key exists but its token no longer works — rotating it');
    const rotated = await api(`/api/v1/api-keys/${mine.id}/rotate`, {
      method: 'POST',
      token,
      body: {},
    });
    keyId = mine.id;
    plaintext = rotated?.data?.token;
    if (!plaintext) throw new Error('Rotation returned no token.');
  } else {
    const created = await api('/api/v1/api-keys', {
      method: 'POST',
      token,
      body: {
        name: KEY_NAME,
        description: 'Read-only key embedded in the Next.js site.',
        publishable: true,
        // An EMPTY allowlist means the key works from anywhere, so it is always
        // set explicitly here.
        allowedOrigins: [PUBLIC_ORIGIN],
        // What makes this key findable by THIS project and no other.
        metadata: { starterOwner: OWNER_TAG },
      },
    });
    keyId = created?.data?.id;
    plaintext = created?.data?.token;
    if (!keyId || !plaintext) {
      throw new Error('Key creation returned no token — it is shown only once.');
    }
    console.log('      created');
  }

  // Attach the role only when it is not already attached.
  //
  // The server does NOT treat a repeat attach as a no-op: the insert into
  // `api_key_roles` has no ON CONFLICT clause and the primary key is
  // (api_key_id, role_id), so re-posting the same pair errors rather than
  // doing nothing. Checking first is what makes re-running bootstrap safe.
  //
  // It still has to run on the reuse path: a key created by an earlier run that
  // failed before this point would otherwise stay permission-less, since an
  // api_key principal is built with `roles: []` and inherits nothing.
  const detail = await api(`/api/v1/api-keys/${keyId}`, { token });
  const attached = (detail?.data?.roles ?? []).some(
    (r) => r === roleId || r?.roleId === roleId || r?.id === roleId,
  );

  if (attached) {
    console.log('      role already attached');
  } else {
    await api(`/api/v1/api-keys/${keyId}/roles`, {
      method: 'POST',
      token,
      body: { roleId },
    });
  }

  // The role may have just been attached, so a token minted moments ago can be
  // permission-less until now. Verify what we are about to hand the website.
  if (!(await tokenWorks(plaintext))) {
    throw new Error(
      'The publishable key cannot read the collection even after its role was ' +
        'attached. Not writing it to .env — the website would only get 401s.',
    );
  }

  return plaintext;
}

async function main() {
  console.log('Bootstrapping LumiBase…');
  await waitForCms();

  await runSetup();

  step(2, 'Logging in…');
  const token = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log('      done');

  await ensureCollection(token);
  const roleId = await enablePublicRead(token);
  const publishableKey = await ensurePublishableKey(token, roleId);

  step(6, 'Writing .env…');
  await updateEnvFile({
    NEXT_PUBLIC_LUMIBASE_PUBLISHABLE_KEY: publishableKey,
    LUMIBASE_ADMIN_TOKEN: token,
  });
  console.log('      done');

  console.log('\n✔ Bootstrap complete.\n');
  console.log('  Next:');
  console.log('    npm run cms:seed    # add sample posts');
  console.log('    npm run dev         # start the website\n');
  console.log(`  Studio → ${process.env.NEXT_PUBLIC_LUMIBASE_URL}/${ADMIN_PATH}`);
  console.log(`  Sign in as ${ADMIN_EMAIL}\n`);
}

main().catch((err) => {
  console.error(`\n✖ Bootstrap failed: ${err.message}\n`);
  process.exit(1);
});
