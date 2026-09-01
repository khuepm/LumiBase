import { readFileSync } from 'node:fs';
import {
  verifyBundle,
  type BundleSignature,
  type ResolvedKey,
} from '@lumibase/contracts/extensions';

/**
 * Locally verify a signed bundle against a public key — a pre-publish check.
 *
 *   lumibase-ext verify --bundle ./dist/index.mjs --pub ./keys/<id>.pub.pem
 *
 * Reads the sidecar `<bundle>.sig.json` produced by `sign`.
 */
export async function verify(args: Map<string, string | boolean>): Promise<void> {
  const bundlePath = args.get('bundle');
  const pubPath = args.get('pub');
  if (typeof bundlePath !== 'string') throw new Error('verify requires --bundle <path>');
  if (typeof pubPath !== 'string') throw new Error('verify requires --pub <path>');

  const bundle = readFileSync(bundlePath);
  const sidecar = JSON.parse(readFileSync(`${bundlePath}.sig.json`, 'utf8')) as {
    bundleSha256: string;
    signature: string;
    publisherKeyId: string;
    signatureAlg: 'ed25519' | 'rsa-pss-sha256';
  };
  const pubPem = readFileSync(pubPath, 'utf8');

  const sig: BundleSignature = {
    sha256: sidecar.bundleSha256,
    signature: sidecar.signature,
    keyId: sidecar.publisherKeyId,
    alg: sidecar.signatureAlg,
  };
  const resolved: ResolvedKey = {
    publicKeyPem: pubPem,
    publisher: sidecar.publisherKeyId,
    official: false,
    revoked: false,
  };

  const result = await verifyBundle(new Uint8Array(bundle), sig, () => resolved);
  process.stdout.write(`${result.ok ? 'OK' : 'FAIL'} — ${result.reason}\n`);
  if (!result.ok) process.exitCode = 1;
}
