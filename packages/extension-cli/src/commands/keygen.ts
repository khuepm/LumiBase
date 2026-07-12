import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Generate an Ed25519 keypair for signing extension bundles.
 *
 *   lumibase-ext keygen --key-id <id> [--out ./keys] [--official]
 *
 * Writes `<id>.pub.pem` (SPKI — matches the verifier's importKey('spki')) and
 * `<id>.key.pem` (PKCS8). The private key must NEVER be committed; store it in
 * a CI secret / KMS. Prints the JSON fragment for `MARKETPLACE_PUBLIC_KEYS` and
 * the SQL row for `lumibase_publisher_keys`.
 */
export function keygen(args: Map<string, string | boolean>): void {
  const keyId = args.get('key-id');
  if (typeof keyId !== 'string' || keyId.length === 0) {
    throw new Error('keygen requires --key-id <id>');
  }
  const outDir = typeof args.get('out') === 'string' ? (args.get('out') as string) : './keys';
  const official = args.get('official') === true;

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  mkdirSync(outDir, { recursive: true });
  const pubPath = join(outDir, `${keyId}.pub.pem`);
  const keyPath = join(outDir, `${keyId}.key.pem`);
  writeFileSync(pubPath, pubPem);
  writeFileSync(keyPath, keyPem, { mode: 0o600 });

  const envFragment = JSON.stringify({ [keyId]: pubPem });
  const sqlRow =
    `INSERT INTO lumibase_publisher_keys (id, key_id, public_key_pem, publisher, official, revoked)\n` +
    `VALUES ('<nanoid>', '${keyId}', '<pem>', '<publisher>', ${official}, false);`;

  process.stdout.write(
    [
      `Wrote ${pubPath}`,
      `Wrote ${keyPath}  (keep private — do NOT commit)`,
      '',
      'MARKETPLACE_PUBLIC_KEYS fragment:',
      envFragment,
      '',
      'Publisher-keys row (fill <pem> from the .pub.pem, <publisher>, an id):',
      sqlRow,
      '',
    ].join('\n'),
  );
}
