import { z } from 'zod';

/**
 * Draft review contracts (Jev J05, #512): versioned review profiles,
 * item-bound review runs and editor feedback. Shared by the CMS routes
 * (validation) and the SDK/Studio (types).
 *
 * A review only suggests. No endpoint here writes to an item.
 */

export const REVIEW_PRESETS = ['taxonomy', 'brand-voice', 'brief-alignment'] as const;
export const ReviewPresetSchema = z.enum(REVIEW_PRESETS);
export type ReviewPreset = z.infer<typeof ReviewPresetSchema>;

export const REVIEW_RUN_STATUSES = ['running', 'success', 'abstained', 'error'] as const;
export type ReviewRunStatus = (typeof REVIEW_RUN_STATUSES)[number];

export const REVIEW_VERDICTS = ['accept', 'edit', 'reject'] as const;
export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/** `content_changed` / `revision_changed`: the item moved on; `item_unavailable`: it is gone or unreadable. */
export const REVIEW_STALE_REASONS = ['content_changed', 'revision_changed', 'item_unavailable'] as const;
export type ReviewStaleReason = (typeof REVIEW_STALE_REASONS)[number];

/** Top-level item field. Dotted paths and relations are not reviewable in the MVP. */
export const ReviewFieldNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Invalid field name');
export const ReviewProfileKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid profile key');
const questionKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid question key');
const collectionName = z.string().min(1).max(128);

const payload = z.union([z.string().min(1).max(20_000), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

/** Same question shapes as `POST /ai/decisions`. */
export const ReviewQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    instructions: payload,
    criteria: z.object({ true: payload, false: payload }),
  }),
  z.object({
    type: z.literal('choice'),
    instructions: payload,
    criteria: z
      .record(z.string().min(1).max(128), payload.nullable())
      .refine((options) => {
        const count = Object.keys(options).length;
        return count >= 2 && count <= 255;
      }, 'A choice question needs 2-255 options'),
  }),
  z.object({
    type: z.literal('score'),
    instructions: payload,
    criteria: z.array(payload).min(2).max(10),
  }),
]);
export type ReviewQuestion = z.infer<typeof ReviewQuestionSchema>;

export const ReviewQuestionsSchema = z.record(questionKey, ReviewQuestionSchema).refine((questions) => {
  const count = Object.keys(questions).length;
  return count >= 1 && count <= 32;
}, 'Provide 1-32 questions');

export const ReviewPresetOptionsSchema = z.object({
  /** `taxonomy`: the categories to choose from (`other` and `unknown` are added). */
  categories: z.array(z.string().min(1).max(128)).min(1).max(200).optional(),
  /** `brand-voice`: the voice guidelines the tone rubrics score against. */
  voice: z.string().min(1).max(4_000).optional(),
});
export type ReviewPresetOptions = z.infer<typeof ReviewPresetOptionsSchema>;

const profileBody = z.object({
  /** Collection name the profile applies to; null or omitted = any collection. */
  collection: collectionName.nullable().optional(),
  fields: z.array(ReviewFieldNameSchema).min(1).max(64),
  preset: ReviewPresetSchema.optional(),
  presetOptions: ReviewPresetOptionsSchema.optional(),
  /** Custom questions; merged after the preset's questions. */
  questions: ReviewQuestionsSchema.optional(),
  /** A field holding the brief/source text that `brief-alignment` compares against. */
  sourceField: ReviewFieldNameSchema.nullable().optional(),
  minConfidence: z.number().min(0).max(1).nullable().optional(),
});

type ProfileBody = z.infer<typeof profileBody>;

function refineProfileBody(value: ProfileBody, ctx: z.RefinementCtx) {
  if (!value.preset && !value.questions) {
    ctx.addIssue({ code: 'custom', message: 'Provide questions or a preset', path: ['questions'] });
  }
  if (value.sourceField && !value.fields.includes(value.sourceField)) {
    ctx.addIssue({ code: 'custom', message: 'sourceField must be one of fields', path: ['sourceField'] });
  }
  if (value.preset === 'taxonomy' && !value.presetOptions?.categories) {
    ctx.addIssue({
      code: 'custom',
      message: 'The taxonomy preset needs presetOptions.categories',
      path: ['presetOptions', 'categories'],
    });
  }
  if (new Set(value.fields).size !== value.fields.length) {
    ctx.addIssue({ code: 'custom', message: 'fields must be unique', path: ['fields'] });
  }
}

/** `POST /ai/review-profiles/:key/versions` — the full next version. */
export const ReviewProfileVersionInputSchema = profileBody.superRefine(refineProfileBody);
export type ReviewProfileVersionInput = z.infer<typeof ReviewProfileVersionInputSchema>;

/** `POST /ai/review-profiles` — version 1 of a new key. */
export const ReviewProfileCreateInputSchema = profileBody
  .extend({ key: ReviewProfileKeySchema })
  .superRefine(refineProfileBody);
export type ReviewProfileCreateInput = z.infer<typeof ReviewProfileCreateInputSchema>;

/** `POST /ai/reviews`. Exactly one of `itemId` (saved item) or `snapshot` (unsaved draft). */
export const ReviewRunRequestSchema = z
  .object({
    profile: ReviewProfileKeySchema,
    /** Defaults to the active version. */
    profileVersion: z.number().int().positive().optional(),
    collection: collectionName,
    itemId: z.string().min(1).max(128).optional(),
    /** Unsaved field values. Every key must be a profile field the caller may read and write. */
    snapshot: z.record(z.string(), z.unknown()).optional(),
    /** Same key → same run, no second provider call. The `Idempotency-Key` header also works. */
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.snapshot === undefined && value.itemId === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Provide itemId or snapshot', path: ['itemId'] });
    }
  });
export type ReviewRunRequest = z.infer<typeof ReviewRunRequestSchema>;

export const ReviewFeedbackEntrySchema = z
  .object({
    questionKey: questionKey,
    verdict: ReviewVerdictSchema,
    /** Required for `edit`: the value the editor chose instead. */
    editedValue: z.unknown().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.verdict === 'edit' && value.editedValue === undefined) {
      ctx.addIssue({ code: 'custom', message: 'An edit needs editedValue', path: ['editedValue'] });
    }
  });

/** `POST /ai/reviews/:id/feedback`. */
export const ReviewFeedbackRequestSchema = z
  .object({
    entries: z.array(ReviewFeedbackEntrySchema).min(1).max(32),
    /** Accept/edit on a stale run is refused unless the editor acknowledges it. */
    acknowledgeStale: z.boolean().optional(),
    /** Snapshot runs: hash of the draft the editor sees now, to detect a changed draft. */
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'Invalid content hash').optional(),
  })
  .superRefine((value, ctx) => {
    const keys = value.entries.map((entry) => entry.questionKey);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', message: 'One entry per question', path: ['entries'] });
    }
  });
export type ReviewFeedbackRequest = z.infer<typeof ReviewFeedbackRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ReviewProfile {
  id: string;
  key: string;
  version: number;
  status: 'active' | 'archived';
  collection: string | null;
  preset: ReviewPreset | null;
  fields: string[];
  questions: Record<string, ReviewQuestion>;
  sourceField: string | null;
  minConfidence: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface ReviewRun {
  id: string;
  profileId: string;
  profileKey: string;
  profileVersion: number;
  collection: string;
  itemId: string | null;
  revisionId: string | null;
  contentHash: string;
  source: 'item' | 'snapshot';
  /** Profile fields the caller could not read; they were not sent. */
  omittedFields: string[];
  status: ReviewRunStatus;
  provider: string | null;
  model: string | null;
  calibrated: boolean | null;
  answers: Record<string, unknown> | null;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  latencyMs: number | null;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Item runs: whether the item changed since the run. Snapshot runs: `false` (checked on feedback). */
  stale: boolean;
  staleReason: ReviewStaleReason | null;
  /** Caveat from the profile, e.g. "no source — not a fact-check". */
  note: string | null;
}

export interface ReviewFeedback {
  id: string;
  runId: string;
  questionKey: string;
  verdict: ReviewVerdict;
  editedValue: unknown;
  principalType: string;
  principalId: string;
  createdAt: string;
}

export const REVIEW_ERROR_CODES = [
  'REVIEW_PROFILE_NOT_FOUND',
  'REVIEW_PROFILE_EXISTS',
  'REVIEW_PROFILE_CONFLICT',
  'REVIEW_ITEM_NOT_FOUND',
  'REVIEW_RUN_NOT_FOUND',
  'REVIEW_FIELD_NOT_ALLOWED',
  'REVIEW_COLLECTION_MISMATCH',
  'REVIEW_NOT_COMPLETE',
  'REVIEW_STALE',
] as const;
export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];
