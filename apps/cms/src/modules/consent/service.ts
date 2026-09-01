import { userConsents, type Database } from '@lumibase/database';
import type { ConsentRecord, ConsentType } from '@lumibase/contracts/schemas';
import { and, eq } from 'drizzle-orm';

/**
 * Consent management business logic (GDPR Art. 7, Vietnam PDPD).
 *
 * Stores one current-state row per `(siteId, userId, consentType)` and upserts
 * on change. The full audit trail of grants/withdrawals is written by the route
 * to `audit_log`; this service is pure data access so it can be reused by other
 * call sites (e.g. the email send path checking `marketing` before dispatch).
 */

export interface ConsentServiceDeps {
  db: Database;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface SetConsentInput {
  siteId: string;
  userId: string;
  consentType: ConsentType;
  granted: boolean;
  source?: string;
  version?: string;
}

export interface SetConsentResult {
  record: ConsentRecord;
  /** Prior decision, or `null` if the user had no record for this type yet. */
  previousGranted: boolean | null;
}

type ConsentRow = typeof userConsents.$inferSelect;

function toRecord(row: ConsentRow): ConsentRecord {
  return {
    consentType: row.consentType as ConsentType,
    granted: row.granted,
    grantedAt: row.grantedAt ? row.grantedAt.toISOString() : null,
    withdrawnAt: row.withdrawnAt ? row.withdrawnAt.toISOString() : null,
    source: row.source ?? null,
    version: row.version ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class ConsentService {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(deps: ConsentServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
  }

  /** Every consent decision recorded for a user on a site. */
  async list(params: { siteId: string; userId: string }): Promise<ConsentRecord[]> {
    const rows = await this.db
      .select()
      .from(userConsents)
      .where(
        and(
          eq(userConsents.siteId, params.siteId),
          eq(userConsents.userId, params.userId),
        ),
      );
    return rows.map(toRecord);
  }

  /**
   * Record a grant or withdrawal. Upserts on the
   * `(site_id, user_id, consent_type)` unique index. When granting we stamp
   * `grantedAt` and clear `withdrawnAt`; when withdrawing we stamp `withdrawnAt`
   * and preserve the historical `grantedAt`.
   */
  async set(input: SetConsentInput): Promise<SetConsentResult> {
    const now = this.now();

    const existing = await this.db
      .select({ granted: userConsents.granted })
      .from(userConsents)
      .where(
        and(
          eq(userConsents.siteId, input.siteId),
          eq(userConsents.userId, input.userId),
          eq(userConsents.consentType, input.consentType),
        ),
      )
      .limit(1);
    const previousGranted = existing[0]?.granted ?? null;

    const grantedFields = input.granted
      ? { granted: true, grantedAt: now, withdrawnAt: null }
      : { granted: false, withdrawnAt: now };

    const [row] = await this.db
      .insert(userConsents)
      .values({
        siteId: input.siteId,
        userId: input.userId,
        consentType: input.consentType,
        granted: input.granted,
        grantedAt: input.granted ? now : null,
        withdrawnAt: input.granted ? null : now,
        source: input.source ?? null,
        version: input.version ?? null,
      })
      .onConflictDoUpdate({
        target: [
          userConsents.siteId,
          userConsents.userId,
          userConsents.consentType,
        ],
        set: {
          ...grantedFields,
          source: input.source ?? null,
          version: input.version ?? null,
          updatedAt: now,
        },
      })
      .returning();

    return { record: toRecord(row!), previousGranted };
  }
}
