import { readFile } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();
const rootPackagePath = path.join(repoRoot, 'package.json');
const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'));

const expectedPackageManager = 'pnpm@9.12.0';
const expectedNodeEngine = '>=20';

const failures = [];

if (rootPackage.packageManager !== expectedPackageManager) {
  failures.push(
    `packageManager must be ${expectedPackageManager}; found ${rootPackage.packageManager ?? '<missing>'}`,
  );
}

if (rootPackage.engines?.node !== expectedNodeEngine) {
  failures.push(
    `engines.node must be ${expectedNodeEngine}; found ${rootPackage.engines?.node ?? '<missing>'}`,
  );
}

const lockfile = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
const expectedLockfileVersion = "lockfileVersion: '9.0'";

if (!lockfile.includes(expectedLockfileVersion)) {
  failures.push(`pnpm-lock.yaml must use ${expectedLockfileVersion}`);
}

if (!lockfile.includes('importers:\n\n  .:')) {
  failures.push('pnpm-lock.yaml is missing the root workspace importer');
}

if (failures.length > 0) {
  console.error('Version policy check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Version policy OK: ${expectedPackageManager}, Node ${expectedNodeEngine}`);
