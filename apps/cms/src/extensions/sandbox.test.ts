import { describe, expect, it } from 'vitest';
import { ExtensionSandbox } from './sandbox';

describe('ExtensionSandbox bundle trust policy', () => {
  it('rejects data: bundles before dynamic import executes attacker code', async () => {
    delete process.env.EXTENSION_BUNDLE_ORIGINS;
    delete (globalThis as { __lumibaseExtensionPwned?: boolean }).__lumibaseExtensionPwned;

    const sandbox = new ExtensionSandbox({}, undefined);
    const mod = await sandbox.load({
      name: 'pwn',
      bundleUrl:
        'data:text/javascript,globalThis.__lumibaseExtensionPwned=true;export default { handler() {} };',
      capabilities: [],
    });

    expect(mod).toBeNull();
    expect((globalThis as { __lumibaseExtensionPwned?: boolean }).__lumibaseExtensionPwned).toBeUndefined();
  });

  it('requires an explicit trusted origin allowlist for remote bundles', async () => {
    delete process.env.EXTENSION_BUNDLE_ORIGINS;

    const sandbox = new ExtensionSandbox({}, undefined);
    const mod = await sandbox.load({
      name: 'remote',
      bundleUrl: 'https://extensions.example.com/bundle.mjs',
      capabilities: [],
    });

    expect(mod).toBeNull();
  });
});
