/**
 * Tripwire for the Tauri version guard.
 *
 * Includes the real incident: `@tauri-apps/plugin-updater` 2.12.0 against
 * `tauri-plugin-updater` 2.10.1, which failed every desktop release build
 * from v0.26.0 to v1.0.0-rc.3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  crateFor,
  findMismatches,
  readCargoLock,
  readPnpmImporter,
} from '../check-tauri-versions.mjs';

const PNPM_LOCK = `importers:

  apps/other:
    dependencies:
      '@tauri-apps/plugin-updater':
        specifier: ^1.0.0
        version: 1.0.0

  apps/shell:
    dependencies:
      '@tauri-apps/api':
        specifier: ^2.9.0
        version: 2.11.1
      '@tauri-apps/plugin-updater':
        specifier: ^2.12.0
        version: 2.12.0
      '@tauri-apps/plugin-log':
        specifier: ^2.0.0
        version: 2.9.0(typescript@5.6.2)
    devDependencies:
      '@tauri-apps/cli':
        specifier: ^2.11.5
        version: 2.11.5

  apps/studio:
    dependencies:
      react:
        specifier: ^19.0.0
        version: 19.0.0

packages:
`;

const CARGO_LOCK = `version = 4

[[package]]
name = "tauri"
version = "2.11.3"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tauri-plugin-updater"
version = "2.10.1"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "tauri-plugin-log"
version = "2.9.2"
`;

test('reads only the requested importer, stripping peer suffixes', () => {
  const versions = readPnpmImporter(PNPM_LOCK, 'apps/shell');
  assert.equal(versions.get('@tauri-apps/api'), '2.11.1');
  assert.equal(versions.get('@tauri-apps/plugin-updater'), '2.12.0');
  assert.equal(versions.get('@tauri-apps/plugin-log'), '2.9.0');
  assert.equal(versions.get('@tauri-apps/cli'), '2.11.5');
  assert.equal(versions.has('react'), false);
});

test('maps npm packages to their crates', () => {
  assert.equal(crateFor('@tauri-apps/api'), 'tauri');
  assert.equal(crateFor('@tauri-apps/plugin-deep-link'), 'tauri-plugin-deep-link');
  assert.equal(crateFor('@tauri-apps/cli'), null);
});

test('flags the plugin-updater incident (2.12 npm vs 2.10 crate)', () => {
  const { checked, mismatches } = findMismatches(
    readPnpmImporter(PNPM_LOCK, 'apps/shell'),
    readCargoLock(CARGO_LOCK),
  );
  assert.equal(checked, 3);
  assert.deepEqual(mismatches, [
    {
      npmName: '@tauri-apps/plugin-updater',
      npmVersion: '2.12.0',
      crate: 'tauri-plugin-updater',
      crateVersion: '2.10.1',
    },
  ]);
});

test('passes when only the patch differs', () => {
  const fixed = CARGO_LOCK.replace('version = "2.10.1"', 'version = "2.12.4"');
  const { mismatches } = findMismatches(readPnpmImporter(PNPM_LOCK, 'apps/shell'), readCargoLock(fixed));
  assert.deepEqual(mismatches, []);
});

test('skips packages that exist on one side only', () => {
  const npm = new Map([['@tauri-apps/plugin-dialog', '2.7.3']]);
  const { checked, mismatches } = findMismatches(npm, readCargoLock(CARGO_LOCK));
  assert.equal(checked, 0);
  assert.deepEqual(mismatches, []);
});
