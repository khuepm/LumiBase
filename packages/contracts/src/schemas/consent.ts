import { z } from 'zod';

/**
 * Consent management DTOs (GDPR Art. 7, Vietnam PDPD).
 *
 * `CONSENT_TYPES` is the canonical set of consent categories. Keep it in sync
 * with the `consent_type` values written to the `user_consents` table and with
 * any place that enforces a consent (e.g. the email send path checks
 * `marketing`).
 */

export const CONSENT_TYPES = [
  'marketing',
  'analytics',
  'personalization',
  'functional',
  // CCPA/CPRA "Do Not Sell or Share". Semantics: `granted: true` = the user
  // consents to sale/sharing; `granted: false` (or no record) = opted out. The
  // safe default (absent) is therefore "opted out".
  'sale_share',
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

export const ConsentTypeSchema = z.enum(CONSENT_TYPES);

/**
 * Payload for `PUT /api/v1/me/consents/:type` — record a grant or withdrawal
 * for the current user. `consentType` comes from the URL param, so the body
 * only carries the decision and optional provenance.
 */
export const ConsentSetSchema = z.object({
  granted: z.boolean(),
  /** Where the decision came from, e.g. `preference_center`, `signup`. */
  source: z.string().trim().min(1).max(64).optional(),
  /** Version of the privacy notice / consent text the user agreed to. */
  version: z.string().trim().min(1).max(64).optional(),
});

export type ConsentSetInput = z.infer<typeof ConsentSetSchema>;

/** Shape returned to clients for a single consent record. */
export interface ConsentRecord {
  consentType: ConsentType;
  granted: boolean;
  grantedAt: string | null;
  withdrawnAt: string | null;
  source: string | null;
  version: string | null;
  updatedAt: string;
}
