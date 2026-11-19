import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseReleasePublicKeys, verifyReleaseManifest } from '../manifest';

/**
 * `scripts/release-flags/manifest.mjs` is what LumiBase runs to issue a
 * manifest; the CMS verifier is what accepts it. This keeps the two in
 * lockstep: a change to either side that breaks the other fails here.
 */
const SCRIPT = resolve(__dirname, '../../../../../../scripts/release-flags/manifest.mjs');
const dir = mkdtempSync(join(tmpdir(), 'release-manifest-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('manifest.mjs ↔ verifyReleaseManifest', () => {
  it('keygen + sign produce an envelope the CMS accepts, with the printed env line', async () => {
    const keygen = execFileSync('node', [SCRIPT, 'keygen', '--out', dir, '--key-id', 'k-test'], { encoding: 'utf8' });
    const envLine = keygen.split('\n').find((l) => l.startsWith('LUMIBASE_RELEASE_PUBLIC_KEYS='))!;
    const publicKeys = parseReleasePublicKeys(envLine.slice(envLine.indexOf("'") + 1, envLine.lastIndexOf("'")));
    expect(Object.keys(publicKeys)).toEqual(['k-test']);

    const out = join(dir, 'm.json');
    execFileSync('node', [
      SCRIPT, 'sign', '--key', join(dir, 'k-test.private.pem'), '--key-id', 'k-test',
      '--flags', 'content-environments=on,other.flag=off', '--audience', 'prod-1', '--out', out,
    ], { encoding: 'utf8', stdio: 'pipe' });

    const result = await verifyReleaseManifest(JSON.parse(readFileSync(out, 'utf8')), {
      publicKeys, instanceId: 'prod-1', now: Date.now(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.payload).toMatchObject({
        audience: ['prod-1'],
        flags: { 'content-environments': true, 'other.flag': false },
      });
    }
  });

  it('refuses an empty manifest unless --allow-empty is passed', async () => {
    const key = join(dir, 'k-test.private.pem');
    expect(() =>
      execFileSync('node', [SCRIPT, 'sign', '--key', key, '--key-id', 'k-test'], { stdio: 'pipe' }),
    ).toThrow();
    const out = execFileSync('node', [SCRIPT, 'sign', '--key', key, '--key-id', 'k-test', '--allow-empty'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(JSON.parse(Buffer.from(JSON.parse(out).payload, 'base64').toString('utf8')).flags).toEqual({});
  });

  it('refuses an entry with more than one "="', () => {
    expect(() =>
      execFileSync('node', [SCRIPT, 'sign', '--key', join(dir, 'k-test.private.pem'), '--key-id', 'k-test', '--flags', 'a=on=off'], {
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('refuses a malformed flag entry', () => {
    expect(() =>
      execFileSync('node', [SCRIPT, 'sign', '--key', join(dir, 'k-test.private.pem'), '--key-id', 'k', '--flags', 'Bad=on'], {
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('signs from an environment variable (no key file in CI) and verify accepts the result', () => {
    const pem = readFileSync(join(dir, 'k-test.private.pem'), 'utf8');
    const publicKeys = JSON.stringify({ 'k-test': readFileSync(join(dir, 'k-test.public.pem'), 'utf8') });
    const out = join(dir, 'env-signed.json');
    execFileSync('node', [
      SCRIPT, 'sign', '--key-env', 'TEST_RELEASE_KEY', '--key-id', 'k-test',
      '--flags', 'content-environments=on', '--audience', 'lumibase-staging', '--out', out,
    ], { stdio: 'pipe', env: { ...process.env, TEST_RELEASE_KEY: pem } });

    const printed = JSON.parse(
      execFileSync('node', [SCRIPT, 'verify', '--in', out, '--public-keys', publicKeys, '--audience', 'lumibase-staging'], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    );
    expect(printed).toMatchObject({ keyId: 'k-test', v: 1, audience: ['lumibase-staging'], flags: { 'content-environments': true } });
    // Never echoes the key.
    expect(JSON.stringify(printed)).not.toContain('PRIVATE KEY');
  });

  it('verify refuses a tampered payload, an untrusted key and the wrong audience', () => {
    const publicKeys = JSON.stringify({ 'k-test': readFileSync(join(dir, 'k-test.public.pem'), 'utf8') });
    const signed = JSON.parse(readFileSync(join(dir, 'env-signed.json'), 'utf8')) as { payload: string };
    const run = (file: string, extra: string[] = [], keys = publicKeys) =>
      () => execFileSync('node', [SCRIPT, 'verify', '--in', file, '--public-keys', keys, ...extra], { stdio: 'pipe' });

    const tampered = join(dir, 'tampered.json');
    const payload = JSON.parse(Buffer.from(signed.payload, 'base64').toString('utf8'));
    payload.flags['content-environments'] = false;
    writeFileSync(tampered, JSON.stringify({ ...signed, payload: Buffer.from(JSON.stringify(payload)).toString('base64') }));
    expect(run(tampered)).toThrow();
    expect(run(join(dir, 'env-signed.json'), [], JSON.stringify({ other: 'x' }))).toThrow();
    expect(run(join(dir, 'env-signed.json'), ['--audience', 'lumibase-production'])).toThrow();
    expect(run(join(dir, 'env-signed.json'))).not.toThrow();
  });

  it('sign --key-env fails when the variable is missing', () => {
    expect(() =>
      execFileSync('node', [SCRIPT, 'sign', '--key-env', 'NOT_SET_ANYWHERE', '--key-id', 'k', '--flags', 'a=on'], {
        stdio: 'pipe',
        env: { PATH: process.env.PATH },
      }),
    ).toThrow();
  });
});
