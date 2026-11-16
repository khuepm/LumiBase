import * as z from 'zod/mini';

/**
 * Studio ↔ frontend preview bridge protocol (epic #667 — V03 #681, V05 #683).
 *
 * Shared by the Studio preview pane and the frontend overlay. Both sides run
 * every inbound `MessageEvent` through {@link acceptPreviewMessage}:
 *
 *   1. `event.origin` must be on an exact allowlist (no wildcards, never `*`),
 *   2. `event.source` must be the expected window (parent / the iframe),
 *   3. the serialized payload must fit {@link MAX_MESSAGE_BYTES},
 *   4. `data` must match the strict schema for that direction.
 *
 * Anything else is dropped. Nothing in a message is ever evaluated, used as
 * HTML or as a URL to navigate to: values are data (Builder.io #4501).
 *
 * Threat model: docs/en/architecture/decisions/adr-014-preview-bridge-threat-model.md
 */

export const PREVIEW_CHANNEL = 'lumibase-preview';
export const PREVIEW_PROTOCOL_VERSION = 1;
/** Hard ceiling on one message's JSON size (TinaCMS #7134: keep payloads small). */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Max fields in one `patch` — patches are field-level and incremental. */
export const MAX_PATCH_FIELDS = 50;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z0-9_]{1,64}){0,7}$/;

const ident = z.string().check(z.regex(IDENT));
const itemId = z.string().check(z.regex(ITEM_ID));
const fieldPath = z.string().check(z.regex(FIELD_PATH));
const seq = z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER));

const envelope = {
  channel: z.literal(PREVIEW_CHANNEL),
  v: z.literal(PREVIEW_PROTOCOL_VERSION),
};

/** Which item a field belongs to. */
export const PreviewFieldRefSchema = z.strictObject({
  collection: ident,
  itemId,
  field: fieldPath,
});
export type PreviewFieldRef = z.infer<typeof PreviewFieldRefSchema>;

// ── frontend → Studio ──────────────────────────────────────────────────────

const ReadyMessage = z.strictObject({
  ...envelope,
  type: z.literal('ready'),
  /** Path + query of the framed page (no origin): display only. */
  path: z.string().check(z.maxLength(2048)),
});

const FocusMessage = z.strictObject({
  ...envelope,
  type: z.literal('focus'),
  target: PreviewFieldRefSchema,
});

export const FrontendToStudioSchema = z.discriminatedUnion('type', [ReadyMessage, FocusMessage]);
export type FrontendToStudioMessage = z.infer<typeof FrontendToStudioSchema>;

// ── Studio → frontend ──────────────────────────────────────────────────────

const HelloMessage = z.strictObject({
  ...envelope,
  type: z.literal('hello'),
});

const PatchMessage = z.strictObject({
  ...envelope,
  type: z.literal('patch'),
  seq,
  collection: ident,
  itemId,
  /** Changed top-level fields only, new values as JSON. */
  fields: z.record(ident, z.unknown()).check(
    z.refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= MAX_PATCH_FIELDS, {
      message: `A patch carries 1–${MAX_PATCH_FIELDS} fields.`,
    }),
  ),
});

const HighlightMessage = z.strictObject({
  ...envelope,
  type: z.literal('highlight'),
  target: z.nullable(PreviewFieldRefSchema),
});

const ReloadMessage = z.strictObject({
  ...envelope,
  type: z.literal('reload'),
});

export const StudioToFrontendSchema = z.discriminatedUnion('type', [
  HelloMessage,
  PatchMessage,
  HighlightMessage,
  ReloadMessage,
]);
export type StudioToFrontendMessage = z.infer<typeof StudioToFrontendSchema>;

export type PreviewDirection = 'to-studio' | 'to-frontend';

export type RejectReason = 'origin' | 'source' | 'size' | 'schema';

export type AcceptResult<T> =
  | { readonly ok: true; readonly message: T }
  | { readonly ok: false; readonly reason: RejectReason };

/** Exact-match origin allowlist check. `*` and `null` never match. */
export function isAllowedOrigin(origin: string, allowed: readonly string[]): boolean {
  if (!origin || origin === 'null' || origin === '*') return false;
  return allowed.some((candidate) => candidate !== '*' && candidate === origin);
}

/** JSON byte size of a message, or `Infinity` when it does not serialize. */
export function messageSize(data: unknown): number {
  try {
    const json = JSON.stringify(data);
    if (json === undefined) return Number.POSITIVE_INFINITY;
    return new TextEncoder().encode(json).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Schema check only (used after origin/source/size checks). */
export function parsePreviewMessage(direction: 'to-studio', data: unknown): FrontendToStudioMessage | null;
export function parsePreviewMessage(direction: 'to-frontend', data: unknown): StudioToFrontendMessage | null;
export function parsePreviewMessage(
  direction: PreviewDirection,
  data: unknown,
): FrontendToStudioMessage | StudioToFrontendMessage | null {
  const schema = direction === 'to-studio' ? FrontendToStudioSchema : StudioToFrontendSchema;
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

interface MessageEventLike {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

/**
 * The full inbound gate: origin allowlist → expected source → size budget →
 * strict schema. Order matters: an untrusted origin is rejected before its
 * payload is even measured.
 */
export function acceptPreviewMessage(
  direction: 'to-studio',
  event: MessageEventLike,
  opts: { allowedOrigins: readonly string[]; expectedSource: unknown },
): AcceptResult<FrontendToStudioMessage>;
export function acceptPreviewMessage(
  direction: 'to-frontend',
  event: MessageEventLike,
  opts: { allowedOrigins: readonly string[]; expectedSource: unknown },
): AcceptResult<StudioToFrontendMessage>;
export function acceptPreviewMessage(
  direction: PreviewDirection,
  event: MessageEventLike,
  opts: { allowedOrigins: readonly string[]; expectedSource: unknown },
): AcceptResult<FrontendToStudioMessage | StudioToFrontendMessage> {
  if (!isAllowedOrigin(event.origin, opts.allowedOrigins)) return { ok: false, reason: 'origin' };
  if (opts.expectedSource === null || opts.expectedSource === undefined || event.source !== opts.expectedSource) {
    return { ok: false, reason: 'source' };
  }
  if (messageSize(event.data) > MAX_MESSAGE_BYTES) return { ok: false, reason: 'size' };
  const message =
    direction === 'to-studio' ? parsePreviewMessage('to-studio', event.data) : parsePreviewMessage('to-frontend', event.data);
  if (!message) return { ok: false, reason: 'schema' };
  return { ok: true, message };
}

/** Build a message with the envelope filled in. */
export function previewMessage<T extends { type: string }>(body: T): T & { channel: typeof PREVIEW_CHANNEL; v: typeof PREVIEW_PROTOCOL_VERSION } {
  return { channel: PREVIEW_CHANNEL, v: PREVIEW_PROTOCOL_VERSION, ...body };
}

/** The `data-lumibase-field` attribute value for a field: `collection/itemId/field`. */
export function encodeFieldRef(ref: PreviewFieldRef): string {
  return `${ref.collection}/${ref.itemId}/${ref.field}`;
}

/** Parse a `data-lumibase-field` value; `null` when malformed. */
export function decodeFieldRef(value: string | null | undefined): PreviewFieldRef | null {
  if (!value || value.length > 256) return null;
  const parts = value.split('/');
  if (parts.length !== 3) return null;
  const parsed = PreviewFieldRefSchema.safeParse({ collection: parts[0], itemId: parts[1], field: parts[2] });
  return parsed.success ? parsed.data : null;
}
