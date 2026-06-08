import { describe, it, expect } from 'vitest';

describe('Performance Baseline', () => {
  it('measures sequence vs parallel fetching', async () => {
    // mock delay
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Simulate API responses
    const roles = Array.from({ length: 10 }).map((_, i) => ({ id: `role-${i}`, adminAccess: false, appAccess: false }));
    const client = {
      roles: {
        list: async () => { await delay(10); return { data: roles }; },
        detail: async (id: string) => { await delay(20); return { data: { id, policies: [{ policyId: 'p1' }, { policyId: 'p2' }] } }; }
      },
      policies: {
        detail: async (id: string) => { await delay(10); return { data: { id, permissions: [] } }; }
      }
    };

    const collection = 'test';

    // Original implementation
    const t0 = performance.now();
    const fetchedRoles = (await client.roles.list()).data.filter(r => !r.adminAccess && !r.appAccess);
    const outSeq = [];
    for (const role of fetchedRoles) {
      const detail = (await client.roles.detail(role.id)).data;
      const policyDetails = await Promise.all(
        detail.policies.map(binding => client.policies.detail(binding.policyId).then(res => res.data))
      );
      const permissions = policyDetails.flatMap((policy: any) => policy.permissions ?? []);
      const hasRead = permissions.some((perm: any) => perm.collection === collection && perm.action === 'read');
      const hasNonRead = permissions.some((perm: any) => perm.action !== 'read');
      if (hasRead && !hasNonRead) outSeq.push(role);
    }
    const t1 = performance.now();
    const seqTime = t1 - t0;

    // Optimized implementation
    const t2 = performance.now();
    const fetchedRoles2 = (await client.roles.list()).data.filter(r => !r.adminAccess && !r.appAccess);
    const outPar = await Promise.all(
      fetchedRoles2.map(async (role) => {
        const detail = (await client.roles.detail(role.id)).data;
        const policyDetails = await Promise.all(
          detail.policies.map(binding => client.policies.detail(binding.policyId).then(res => res.data))
        );
        const permissions = policyDetails.flatMap((policy: any) => policy.permissions ?? []);
        const hasRead = permissions.some((perm: any) => perm.collection === collection && perm.action === 'read');
        const hasNonRead = permissions.some((perm: any) => perm.action !== 'read');
        return (hasRead && !hasNonRead) ? role : null;
      })
    );
    const resultPar = outPar.filter(Boolean);
    const t3 = performance.now();
    const parTime = t3 - t2;

    console.log(`Sequential Time: ${seqTime}ms`);
    console.log(`Parallel Time: ${parTime}ms`);
    console.log(`Improvement: ${Math.round(((seqTime - parTime) / seqTime) * 100)}%`);

    expect(parTime).toBeLessThan(seqTime);
  });
});
