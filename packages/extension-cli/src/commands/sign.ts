import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256Hex } from '@lumibase/shared/extensions';

/**
 * Sign an extension bundle with an Ed25519 private key.
 *
 *   lumibase-ext sign --bundle ./dist/index.mjs --key ./keys/<id>.key.pem --key-id <id>
 *
 * The signature is over the RAW bundle bytes (matching the verifier's message),
 * and the bundle's SHA-256 is recorded alongside. Writes a sidecar
 * `<bundle>.sig.json` consumed at publish time.
 */
export async function sign(args: Map<string, string | boolean>): Promise<void> {
  const bundlePath = args.get('bundle');
  const keyPath = args.get('key');
  const keyId = args.get('key-id');
  if (typeof bundlePath !== 'string') throw new Error('sign requires --bundle <path>');
  if (typeof keyPath !== 'string') throw new Error('sign requires --key <path>');
  if (typeof keyId !== 'string') throw new Error('sign requires --key-id <id>');

  const bundle = readFileSync(bundlePath);
  const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));

  // Ed25519 is a one-shot algorithm — pass null for the digest name.
  const signature = nodeSign(null, bundle, privateKey).toString('base64');
  const bundleSha256 = await sha256Hex(new Uint8Array(bundle));

  const sidecar = {
    bundleSha256,
    signature,
    publisherKeyId: keyId,
    signatureAlg: 'ed25519' as const,
  };
  const sidecarPath = `${bundlePath}.sig.json`;
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  process.stdout.write(
    [`Wrote ${sidecarPath}`, JSON.stringify(sidecar, null, 2), ''].join('\n'),
  );
}
