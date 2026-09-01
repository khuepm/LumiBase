import { z } from 'zod';

/**
 * Custom-domain schemas — shared by CMS (validation) and Studio (form).
 * Mirrors the `site_domains` table. A site can register multiple hostnames:
 * a free `<slug>.lumibase.dev` subdomain and/or operator-owned custom domains
 * provisioned through Cloudflare for SaaS.
 */

/** Reserved suffix offered for free. Custom domains may NOT live under it. */
export const FREE_DOMAIN_SUFFIX = 'lumibase.dev';

/** A valid FQDN like `cms.example.com` (labels, lowercased, ≤253 chars). */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(HOSTNAME, { message: 'Enter a valid domain like cms.example.com.' });

export const DOMAIN_KINDS = ['subdomain', 'custom'] as const;
export const DomainKindSchema = z.enum(DOMAIN_KINDS);

export const DOMAIN_STATUSES = ['pending_dns', 'verifying', 'active', 'failed'] as const;
export const DomainStatusSchema = z.enum(DOMAIN_STATUSES);

/**
 * Create a domain. `custom` requires a full FQDN that is NOT under the free
 * suffix (those are claimed via `kind: 'subdomain'`). `subdomain` takes a bare
 * label (`acme`) which the server expands to `<label>.lumibase.dev`.
 */
export const DomainCreateSchema = z
  .object({
    kind: DomainKindSchema,
    /** FQDN for `custom`; bare DNS label for `subdomain`. */
    hostname: z.string().trim().toLowerCase().min(1).max(253),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'custom') {
      if (!HOSTNAME.test(value.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Enter a valid domain like cms.example.com.',
          path: ['hostname'],
        });
      }
      if (value.hostname === FREE_DOMAIN_SUFFIX || value.hostname.endsWith(`.${FREE_DOMAIN_SUFFIX}`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Use kind "subdomain" to claim a ${FREE_DOMAIN_SUFFIX} address.`,
          path: ['hostname'],
        });
      }
    } else {
      // subdomain: a single DNS label (no dots).
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value.hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Enter a single label like "acme" (letters, numbers, hyphens).',
          path: ['hostname'],
        });
      }
    }
  });

/** One DNS record the operator must create, surfaced verbatim in the UI. */
export const DomainVerificationRecordSchema = z.object({
  type: z.enum(['CNAME', 'TXT']),
  name: z.string(),
  value: z.string(),
  /** Why this record exists, shown as help text. */
  purpose: z.string().optional(),
});

/** Shape returned by the API for one domain row (secrets stripped). */
export const DomainResourceSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  kind: DomainKindSchema,
  isPrimary: z.boolean(),
  status: DomainStatusSchema,
  statusReason: z.string().nullable(),
  sslStatus: z.string().nullable(),
  verification: z
    .object({ records: z.array(DomainVerificationRecordSchema).default([]) })
    .default({ records: [] }),
  verifiedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DomainKind = z.infer<typeof DomainKindSchema>;
export type DomainStatus = z.infer<typeof DomainStatusSchema>;
export type DomainCreateInput = z.infer<typeof DomainCreateSchema>;
export type DomainVerificationRecord = z.infer<typeof DomainVerificationRecordSchema>;
export type DomainResource = z.infer<typeof DomainResourceSchema>;
