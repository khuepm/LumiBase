import { createRequire } from 'node:module';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { initCommand, resolveScaffoldBin } from './init.js';

const realRequire = createRequire(import.meta.url);

describe('resolveScaffoldBin', () => {
  it('resolves the create-lumibase executable from the dependency tree', () => {
    expect(resolveScaffoldBin(realRequire)).toMatch(/create-lumibase.*bin.*create-lumibase\.js$/);
  });

  it('explains what to do when the scaffolder is not installed', () => {
    const missing = Object.assign(
      () => {
        throw new Error('not reached');
      },
      {
        resolve: () => {
          throw new Error('MODULE_NOT_FOUND');
        },
      },
    ) as unknown as NodeRequire;

    expect(() => resolveScaffoldBin(missing)).toThrow(/Could not find the create-lumibase package/);
  });

  it('fails clearly when the installed scaffolder declares no bin', () => {
    const noBin = Object.assign((() => ({})) as unknown as NodeRequire, {
      resolve: () => '/somewhere/create-lumibase/package.json',
    }) as unknown as NodeRequire;

    expect(() => resolveScaffoldBin(noBin)).toThrow(/declares no executable/);
  });
});

describe('initCommand', () => {
  it('runs the scaffolder on the current node binary and forwards argv', () => {
    const seen: { command?: string; args?: string[] } = {};

    const code = initCommand(['my-site', '--pm', 'pnpm'], {
      requireFrom: realRequire,
      run: (command, args) => {
        seen.command = command;
        seen.args = args;
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(seen.command).toBe(process.execPath);
    expect(seen.args?.slice(1)).toEqual(['my-site', '--pm', 'pnpm']);
    expect(seen.args?.[0]).toMatch(/create-lumibase\.js$/);
  });

  it('propagates the scaffolder exit code', () => {
    const code = initCommand([], { requireFrom: realRequire, run: () => 3 });
    expect(code).toBe(3);
  });
});
