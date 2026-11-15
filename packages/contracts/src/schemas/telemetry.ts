import { z } from 'zod';

/**
 * Activation milestones and the anonymous usage-telemetry event.
 *
 * Two separate things live here on purpose:
 *
 *   1. `ACTIVATION_MILESTONES` — per-site, in-product. Stored in the site's own
 *      database and read by the site's own admins. Never leaves the install.
 *   2. `TelemetryEventSchema` — the ONLY shape the opt-in telemetry emitter may
 *      send off the install. It is `.strict()`: a payload carrying any field
 *      not listed here fails validation and is not sent.
 *
 * The JSON Schema twin of (2) is `docs/schemas/telemetry-event.v1.schema.json`;
 * a test in `apps/cms` keeps the two in lockstep.
 */

/** Per-site milestones, in funnel order. */
export const ACTIVATION_MILESTONES = [
  'site_created',
  'item_published',
  'delivery_request',
  'agent_run',
] as const;

export type ActivationMilestone = (typeof ACTIVATION_MILESTONES)[number];

export const ActivationMilestoneSchema = z.enum(ACTIVATION_MILESTONES);

/** How a milestone timestamp was obtained. */
export const ACTIVATION_SOURCES = ['event', 'derived'] as const;
export type ActivationSource = (typeof ACTIVATION_SOURCES)[number];

export const ActivationMilestoneStateSchema = z.object({
  key: ActivationMilestoneSchema,
  /** ISO timestamp, or `null` while the milestone has not been reached. */
  reachedAt: z.string().datetime().nullable(),
  /** `event`: recorded when it happened. `derived`: read back from existing rows. */
  source: z.enum(ACTIVATION_SOURCES).nullable(),
  /** Whole seconds between `site_created` and this milestone (never negative). */
  secondsSinceSiteCreated: z.number().int().nonnegative().nullable(),
});
export type ActivationMilestoneState = z.infer<typeof ActivationMilestoneStateSchema>;

export const ActivationFunnelSchema = z.object({
  siteId: z.string(),
  milestones: z.array(ActivationMilestoneStateSchema),
  reached: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type ActivationFunnel = z.infer<typeof ActivationFunnelSchema>;

// ── Telemetry (install-level, opt-in) ───────────────────────────────────────

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/**
 * Install-level events: the first time ANY site on the install reaches the
 * matching milestone. One event per kind per install, ever.
 */
export const TELEMETRY_EVENTS = [
  'first_site_created',
  'first_item_published',
  'first_delivery_request',
  'first_agent_run',
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

/** Which per-site milestone each install-level event is derived from. */
export const TELEMETRY_EVENT_MILESTONE: Record<TelemetryEventName, ActivationMilestone> = {
  first_site_created: 'site_created',
  first_item_published: 'item_published',
  first_delivery_request: 'delivery_request',
  first_agent_run: 'agent_run',
};

export const TelemetryEventSchema = z
  .object({
    schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
    /** Random UUID v4 generated on the install at opt-in. Not derived from anything. */
    installId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    event: z.enum(TELEMETRY_EVENTS),
    /** UTC calendar day the milestone was reached. Day precision only. */
    occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** LumiBase version string, or `unknown`. */
    version: z.string().min(1).max(64),
    runtime: z.enum(['cloudflare', 'docker']),
  })
  .strict();

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
