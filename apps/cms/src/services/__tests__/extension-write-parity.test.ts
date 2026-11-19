import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { ExtensionSandbox } from '../../extensions/sandbox';
import { AISecureHarness } from '../ai-harness';
import { ExtensionVerifierService } from '../extension-verifier';
import { ExtensionsService } from '../extensions-service';
import { PermissionService } from '../permission-service';
import type { MagicContext } from '../permission-dsl';
import type { ApprovalRequesterResolution } from '../approval-requester';

const ctx: MagicContext = { siteId: 'site-a', userId: 'requester', roleId: null, user: null, ip: null, headers: {}, apiKey: null };
const input = { name: 'third-party', version: '1', type: 'panel' as const, bundleUrl: 'https://example.com/plugin.js' };
afterEach(() => vi.restoreAllMocks());
function allow() { return vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({ collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] })); }

describe('extension write boundary', () => {
  it('requires signature policy even for non-reserved names, without inserting', async () => {
    allow();
    const insert = vi.fn(); const db = { insert } as unknown as Database;
    vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: false, isOfficial: false, reason: 'missing-fields' });
    const service = new ExtensionsService({ db, siteId: ctx.siteId, permissionCtx: ctx });
    await expect(service.installExtension(input)).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' });
    expect(insert).not.toHaveBeenCalled();
  });
  it('checks additional enable/capability grants independently of install', async () => {
    const can = allow();
    can.mockImplementation(async (collection, action) => action === 'install' ? { collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] } : null);
    const insert = vi.fn(); const db = { insert } as unknown as Database;
    const verify = vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata');
    const service = new ExtensionsService({ db, siteId: ctx.siteId, permissionCtx: ctx });
    for (const extra of [{ enabled: true }, { capabilities: ['items:write'] }]) {
      await expect(service.installExtension({ ...input, ...extra })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(insert).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  });
  it('evicts the sandbox on a bundle update through the real skill', async () => {
    allow();
    const row = { ...input, id: 'ext-a', siteId: ctx.siteId, enabled: false, isOfficial: false, verifiedAt: null, capabilities: [] };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [row] }) }) }),
    } as unknown as Database;
    const evict = vi.spyOn(ExtensionSandbox.prototype, 'evict').mockImplementation(() => {});
    // A new bundle is re-verified before it replaces the old one (#990).
    vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: false, reason: 'ok' });
    const harness = new AISecureHarness({ db, siteId: ctx.siteId, extensionsService: new ExtensionsService({ db, siteId: ctx.siteId, permissionCtx: ctx }), enableAgentHarnessAudit: false });
    expect((await harness.runSkill('updateExtension', { id: row.id, bundleUrl: 'https://example.com/v2.js' })).success).toBe(true);
    expect(evict).toHaveBeenCalledWith(row.name);
  });
  describe('bundle change re-verifies the signature (#990)', () => {
    const signed = { ...input, id: 'ext-a', siteId: ctx.siteId, enabled: true, isOfficial: false, verifiedAt: new Date(0), capabilities: [],
      bundleSha256: 'a'.repeat(64), signature: 'sig', publisherKeyId: 'pub-1', signatureAlg: 'ed25519' };
    function dbCapturing(sets: unknown[]) {
      return {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [signed] }) }) }),
        update: () => ({ set: (v: unknown) => { sets.push(v); return { where: () => ({ returning: async () => [{ ...signed, ...(v as object) }] }) }; } }),
      } as unknown as Database;
    }
    it('refuses an unverifiable new bundle under the default policy and leaves the row untouched', async () => {
      allow();
      const sets: unknown[] = [];
      const verify = vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: false, isOfficial: false, reason: 'bad-signature' });
      const service = new ExtensionsService({ db: dbCapturing(sets), siteId: ctx.siteId, permissionCtx: ctx });
      await expect(service.updateExtension('ext-a', { bundleUrl: 'https://evil.example/x.js' })).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' });
      expect(sets).toEqual([]);
      // Verified against the row's signature metadata, at the NEW location.
      expect(verify).toHaveBeenCalledWith('third-party', expect.objectContaining({ bundleUrl: 'https://evil.example/x.js', bundleSha256: 'a'.repeat(64), signature: 'sig' }));
    });
    it('also re-verifies a version bump', async () => {
      allow();
      vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: false, isOfficial: false, reason: 'bad-signature' });
      const service = new ExtensionsService({ db: dbCapturing([]), siteId: ctx.siteId, permissionCtx: ctx });
      await expect(service.updateExtension('ext-a', { version: '2' })).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' });
    });
    it('stamps verifiedAt when the new bundle verifies', async () => {
      allow();
      const sets: unknown[] = [];
      vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: false, reason: 'ok' });
      const service = new ExtensionsService({ db: dbCapturing(sets), siteId: ctx.siteId, permissionCtx: ctx });
      await service.updateExtension('ext-a', { bundleUrl: 'https://example.com/v2.js' });
      expect((sets[0] as { verifiedAt: Date }).verifiedAt.getTime()).toBeGreaterThan(0);
    });
    it('under the warn policy, accepts it but clears verifiedAt', async () => {
      allow();
      const sets: unknown[] = [];
      vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: false, isOfficial: false, reason: 'missing-fields' });
      const service = new ExtensionsService({ db: dbCapturing(sets), siteId: ctx.siteId, permissionCtx: ctx, env: { LUMIBASE_EXT_SIGNATURE_POLICY: 'warn' } as never });
      await service.updateExtension('ext-a', { bundleUrl: 'https://example.com/v3.js' });
      expect(sets[0]).toMatchObject({ verifiedAt: null });
    });
    it('does not re-verify a change that keeps the bundle (e.g. enable toggle)', async () => {
      allow();
      const verify = vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata');
      const service = new ExtensionsService({ db: dbCapturing([]), siteId: ctx.siteId, permissionCtx: ctx });
      await service.updateExtension('ext-a', { enabled: false });
      expect(verify).not.toHaveBeenCalled();
    });
  });
  it('approval scope binds the extension principal even when ItemService is absent, then restores it', async () => {
    const db = {} as Database;
    const bind = vi.spyOn(ExtensionsService.prototype, 'withPermissionContext');
    const service = new ExtensionsService({ db, siteId: ctx.siteId, permissionCtx: { ...ctx, userId: 'reviewer' } });
    const harness = new AISecureHarness({ db, siteId: ctx.siteId, extensionsService: service, enableAgentHarnessAudit: false });
    // Exercise the scope used by executeApproved independently of approval persistence.
    const scope = harness as unknown as { scopeToRequester(grant: ApprovalRequesterResolution): () => void };
    const restore = scope.scopeToRequester({ allowed: true, capabilities: ['admin'], permissionContext: ctx } as ApprovalRequesterResolution);
    expect(bind).toHaveBeenCalledWith(ctx);
    const can = vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(null);
    expect((await harness.runSkill('installExtension', input)).success).toBe(false);
    expect(can).toHaveBeenCalledWith('extensions', 'install');
    restore();
    const restoreMissing = scope.scopeToRequester({ allowed: true, capabilities: ['extensions:write'] } as ApprovalRequesterResolution);
    can.mockClear();
    expect((await harness.runSkill('installExtension', input)).success).toBe(false);
    expect(can).not.toHaveBeenCalled();
    restoreMissing();
  });
});
