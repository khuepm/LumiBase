#!/usr/bin/env node
/**
 * Release manifest tool (#869) — what LumiBase runs to "give the command".
 *
 *   node scripts/release-flags/manifest.mjs keygen  --out <dir> [--key-id lumibase-release-v1]
 *   node scripts/release-flags/manifest.mjs sign    --key <private.pem> --key-id <id>
 *        --flags key=on,other=off [--audience id1,id2] [--not-after 2026-12-31T00:00:00Z]
 *        [--issued-at <iso>] [--out manifest.json] [--allow-empty]
 *
 * `keygen` writes an Ed25519 key pair and prints the JSON line to put in
 * `LUMIBASE_RELEASE_PUBLIC_KEYS`. Keep the private key out of the repository.
 * `sign` prints (or writes) the envelope accepted by
 * `PUT /api/v1/release-flags/manifest` and served at `LUMIBASE_RELEASE_MANIFEST_URL`.
 *
 * Every manifest replaces the previous one as a whole and must be issued later
 * than it: include every flag you want released, not only the one that changed.
 */
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ON = new Set(['on', 'true', '1', 'yes']);
const OFF = new Set(['off', 'false', '0', 'no']);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseFlags(raw) {
  const flags = {};
  for (const entry of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
    const parts = entry.split('=');
    const [key, value = ''] = parts;
    const v = value.toLowerCase();
    if (parts.length !== 2 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(key ?? '') || (!ON.has(v) && !OFF.has(v))) {
      fail(`bad flag entry "${entry}" (expected key=on|off)`);
    }
    flags[key] = ON.has(v);
  }
  return flags;
}

function isoOrFail(value, name) {
  if (Number.isNaN(Date.parse(value))) fail(`--${name} is not a date: ${value}`);
  return new Date(value).toISOString();
}

const [command, ...rest] = process.argv.slice(2);
const opt = args(rest);

if (command === 'keygen') {
  const dir = opt.out ?? fail('--out <dir> is required');
  const keyId = opt['key-id'] ?? 'lumibase-release-v1';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dir, { recursive: true });
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(join(dir, `${keyId}.private.pem`), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(dir, `${keyId}.public.pem`), pub);
  console.log(`wrote ${join(dir, `${keyId}.private.pem`)} (keep secret) and ${keyId}.public.pem`);
  console.log(`LUMIBASE_RELEASE_PUBLIC_KEYS='${JSON.stringify({ [keyId]: pub })}'`);
} else if (command === 'sign') {
  const keyPath = opt.key ?? fail('--key <private.pem> is required');
  const keyId = opt['key-id'] ?? fail('--key-id is required');
  const payload = {
    v: 1,
    issuedAt: opt['issued-at'] ? isoOrFail(opt['issued-at'], 'issued-at') : new Date().toISOString(),
    ...(opt['not-after'] ? { notAfter: isoOrFail(opt['not-after'], 'not-after') } : {}),
    audience: opt.audience ? opt.audience.split(',').map((s) => s.trim()).filter(Boolean) : '*',
    flags: parseFlags(opt.flags),
  };
  // A manifest replaces the previous one as a whole, so an empty one withdraws
  // every released feature. Refuse it unless that is explicitly intended.
  if (Object.keys(payload.flags).length === 0 && opt['allow-empty'] !== 'true') {
    fail('no flags given (--flags key=on,...). An empty manifest withdraws every released feature; pass --allow-empty if that is intended.');
  }
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, bytes, createPrivateKey(readFileSync(keyPath)));
  const envelope = { keyId, payload: bytes.toString('base64'), signature: signature.toString('base64') };
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  if (opt.out) {
    writeFileSync(opt.out, text);
    console.error(`wrote ${opt.out} (issuedAt ${payload.issuedAt}, ${Object.keys(payload.flags).length} flag(s))`);
  } else process.stdout.write(text);
} else {
  console.error('usage: manifest.mjs keygen --out <dir> [--key-id id] | sign --key <pem> --key-id <id> --flags k=on,...');
  process.exit(command ? 1 : 0);
}
