import { UPLOAD_CLAIM_TTL_MS, type UploadClaimStore } from '../upload-claims';

interface Row {
  principal: string;
  state: 'issued' | 'uploading' | 'uploaded' | 'registered';
  createdAt: Date;
  expiresAt: Date;
}

/** In-memory claim store with the same transitions as `dbUploadClaims`. */
export class MemoryUploadClaims implements UploadClaimStore {
  readonly rows = new Map<string, Row>();
  private k(siteId: string, key: string) {
    return `${siteId}\u0000${key}`;
  }
  async issue(siteId: string, key: string, principal: string, now = new Date()) {
    if (this.rows.has(this.k(siteId, key))) throw new Error('duplicate claim');
    this.rows.set(this.k(siteId, key), { principal, state: 'issued', createdAt: now, expiresAt: new Date(now.getTime() + UPLOAD_CLAIM_TTL_MS) });
  }
  /** Test helper: a claim already uploaded by `principal`. */
  seedUploaded(siteId: string, key: string, principal: string) {
    const now = new Date();
    this.rows.set(this.k(siteId, key), { principal, state: 'uploaded', createdAt: now, expiresAt: new Date(now.getTime() + UPLOAD_CLAIM_TTL_MS) });
  }
  async beginUpload(siteId: string, key: string) {
    const row = this.rows.get(this.k(siteId, key));
    if (!row) return 'missing' as const;
    if (row.state === 'registered') return 'registered' as const;
    if (row.state === 'uploading') return 'busy' as const;
    row.state = 'uploading';
    return 'ok' as const;
  }
  async finishUpload(siteId: string, key: string, ok: boolean) {
    const row = this.rows.get(this.k(siteId, key));
    if (row?.state === 'uploading') row.state = ok ? 'uploaded' : 'issued';
  }
  async register(siteId: string, key: string, principal: string, now = new Date()) {
    const row = this.rows.get(this.k(siteId, key));
    if (!row || row.principal !== principal || row.state === 'registered') return 'missing' as const;
    if (row.expiresAt.getTime() <= now.getTime()) return 'expired' as const;
    if (row.state !== 'uploaded') return 'not_uploaded' as const;
    row.state = 'registered';
    return 'ok' as const;
  }
  async unregister(siteId: string, key: string) {
    const row = this.rows.get(this.k(siteId, key));
    if (row?.state === 'registered') row.state = 'uploaded';
  }
  async sweep(siteId: string, before: Date) {
    let n = 0;
    for (const [k, row] of this.rows) {
      if (k.startsWith(`${siteId}\u0000`) && row.createdAt < before) {
        this.rows.delete(k);
        n += 1;
      }
    }
    return n;
  }
}
