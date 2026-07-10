import { z } from 'zod';

/**
 * Change Feed Zod schemas + cursor codec
 * (spec: `.kiro/specs/cdc-extension-integration`).
 *
 * Cursor convention: the feed is ordered by the composite keyset
 * `(occurred_at, id)` — event PKs are nanoid (matching the audit-table
 * convention; no uuidv7 dependency), so the id alone carries no order.
 * A cursor is the opaque base64url token of `"<occurredAtMs>:<eventId>"`,
 * shared by the pull API (`meta.nextCursor`), ack, and replay so consumers
 * never construct or interpret the pair themselves.
 */

export const CDC_FEED_SCHEMA_VERSION = 1;

export const CdcOperationSchema = z.enum(['create', 'update', 'delete']);
export const CdcActorTypeSchema = z.enum(['user', 'api_key', 'agent', 'system']);
export const CdcSourceSchema = z.enum(['api', 'agent', 'flow', 'system']);
export const CdcPayloadModeSchema = z.enum(['reference', 'snapshot']);
export const CdcSubscriptionKindSchema = z.enum(['pull', 'webhook', 'extension']);
export const CdcSubscriptionStatusSchema = z.enum(['active', 'paused', 'dead', 'stale']);

export interface CdcCursor {
  /** Epoch milliseconds of the event's `occurred_at` (keyset major key). */
  occurredAtMs: number;
  /** Event id (nanoid) — deterministic tie-breaker within the same ms. */
  eventId: string;
}

const CURSOR_SEPARATOR = ':';

/** base64url without padding — WebCrypto-era safe on Workers and Node. */
function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input: string): string | null {
  try {
    const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export function encodeCdcCursor(cursor: CdcCursor): string {
  return toBase64Url(`${cursor.occurredAtMs}${CURSOR_SEPARATOR}${cursor.eventId}`);
}

/** Returns null on any malformed token — callers map that to 400. */
export function decodeCdcCursor(token: string): CdcCursor | null {
  const raw = fromBase64Url(token);
  if (raw === null) return null;
  const sep = raw.indexOf(CURSOR_SEPARATOR);
  if (sep <= 0 || sep === raw.length - 1) return null;
  const ms = Number(raw.slice(0, sep));
  const eventId = raw.slice(sep + 1);
  if (!Number.isSafeInteger(ms) || ms < 0 || eventId.length === 0) return null;
  return { occurredAtMs: ms, eventId };
}

export const CdcCursorTokenSchema = z
  .string()
  .min(1)
  .refine((token) => decodeCdcCursor(token) !== null, {
    message: 'Malformed cursor token',
  });

/**
 * Delivery envelope (design §4). `id` is the idempotency key; `cursor` is
 * this event's own keyset token so consumers can ack mid-batch. `data` is
 * present only in snapshot mode and is already masked.
 */
export const EventEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().regex(/^items\.(create|update|delete)$/),
  schemaVersion: z.number().int().min(1),
  siteId: z.string().min(1),
  collection: z.string().min(1),
  itemId: z.string().min(1),
  operation: CdcOperationSchema,
  occurredAt: z.string().datetime(),
  actor: z.object({
    type: CdcActorTypeSchema,
    id: z.string().min(1).optional(),
  }),
  source: CdcSourceSchema,
  changedFields: z.array(z.string()).optional(),
  data: z.record(z.unknown()).optional(),
  cursor: CdcCursorTokenSchema,
});

export const CdcSubscriptionCreateSchema = z
  .object({
    name: z.string().min(1).max(128),
    kind: CdcSubscriptionKindSchema,
    collections: z.array(z.string().min(1)).default([]),
    operations: z.array(CdcOperationSchema).default([]),
    payload_mode: CdcPayloadModeSchema.default('reference'),
    webhook_id: z.string().min(1).optional(),
    extension_name: z.string().min(1).optional(),
  })
  .superRefine((sub, ctx) => {
    if (sub.kind === 'webhook' && !sub.webhook_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['webhook_id'],
        message: 'webhook_id is required for kind=webhook',
      });
    }
    if (sub.kind === 'extension' && !sub.extension_name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['extension_name'],
        message: 'extension_name is required for kind=extension',
      });
    }
  });

/** kind is immutable after creation; status flips only between active/paused here. */
export const CdcSubscriptionPatchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  collections: z.array(z.string().min(1)).optional(),
  operations: z.array(CdcOperationSchema).optional(),
  payload_mode: CdcPayloadModeSchema.optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export const CdcAckSchema = z.object({
  cursor: CdcCursorTokenSchema,
});

export const CdcReplaySchema = z
  .object({
    cursor: CdcCursorTokenSchema.optional(),
    occurred_after: z.string().datetime().optional(),
  })
  .refine((r) => (r.cursor !== undefined) !== (r.occurred_after !== undefined), {
    message: 'Provide exactly one of cursor or occurred_after',
  });

const csvToArray = (value: unknown) =>
  typeof value === 'string' && value.length > 0 ? value.split(',') : value;

export const CdcFeedQuerySchema = z.object({
  cursor: CdcCursorTokenSchema.optional(),
  collections: z.preprocess(csvToArray, z.array(z.string().min(1)).optional()),
  operations: z.preprocess(csvToArray, z.array(CdcOperationSchema).optional()),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Per-site settings under key `cdc_feed` (Req 1.5, 6.1). */
export const CdcFeedSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  retentionDays: z.number().int().min(1).max(90).default(7),
});

export type CdcOperation = z.infer<typeof CdcOperationSchema>;
export type CdcActorType = z.infer<typeof CdcActorTypeSchema>;
export type CdcSource = z.infer<typeof CdcSourceSchema>;
export type CdcPayloadMode = z.infer<typeof CdcPayloadModeSchema>;
export type CdcSubscriptionKind = z.infer<typeof CdcSubscriptionKindSchema>;
export type CdcSubscriptionStatus = z.infer<typeof CdcSubscriptionStatusSchema>;
export type CdcEventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type CdcSubscriptionCreateInput = z.infer<typeof CdcSubscriptionCreateSchema>;
export type CdcSubscriptionPatchInput = z.infer<typeof CdcSubscriptionPatchSchema>;
export type CdcAckInput = z.infer<typeof CdcAckSchema>;
export type CdcReplayInput = z.infer<typeof CdcReplaySchema>;
export type CdcFeedQuery = z.infer<typeof CdcFeedQuerySchema>;
export type CdcFeedSettings = z.infer<typeof CdcFeedSettingsSchema>;
