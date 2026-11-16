/**
 * Opt-in Flows templates for Jev metadata automation (J11, #518).
 *
 *   taxonomy-tagging    ai:decision (choice) → ai:apply-tags
 *   editorial-routing   ai:decision (choice or noul) → editorial:route
 *
 * A template is a function of its parameters: the decision node needs one
 * branch per choice key, so the graph cannot be a fixed document. Every
 * built flow is a `draft`, `manual`-trigger flow: an admin reviews and
 * activates it, and the manual run carries the principal the operations act
 * for. Event/schedule triggers have no principal, so `ai:decision` refuses
 * them (J10).
 *
 * The decision maps `unknown` to the action node as well, so the abstention is
 * recorded (skipped, `decision_unknown`) instead of ending the run silently;
 * `error` ends the run. Built flows start in shadow mode whatever the site
 * settings say about the template: the mode is decided per action when the
 * node executes (`ai-automation.ts`).
 */

import { z } from 'zod';

export const AUTOMATION_TEMPLATE_KEYS = ['taxonomy-tagging', 'editorial-routing'] as const;
export type AutomationTemplateKey = (typeof AUTOMATION_TEMPLATE_KEYS)[number];

const RESERVED_BRANCHES = new Set(['true', 'false', 'unknown', 'error', 'other']);

const branchKey = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be a branch key');
const choiceKey = branchKey.refine((key) => !RESERVED_BRANCHES.has(key), 'true/false/unknown/error/other are reserved');
const fieldName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be a field name');
const common = {
  name: z.string().min(1).max(200).optional(),
  profileKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'must be a review profile key'),
  profileVersion: z.number().int().positive(),
  collection: z.string().min(1).max(128),
  questionKey: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be a profile question key'),
};

export const taxonomyTaggingParams = z
  .object({
    ...common,
    choices: z.array(choiceKey).min(1).max(32),
    minConfidence: z.number().min(0).max(1).default(0.8),
    tagField: fieldName,
    tagMap: z.record(z.string().min(1).max(128), z.string().min(1).max(128)).optional(),
  })
  .strict();

export const editorialRoutingParams = z
  .object({
    ...common,
    questionType: z.enum(['choice', 'noul']),
    choices: z.array(choiceKey).max(32).optional(),
    minConfidence: z.number().min(0).max(1).default(0.8),
    noulThreshold: z.number().min(0.5).max(1).default(0.8),
    queueField: fieldName,
    queues: z.record(branchKey, z.string().min(1).max(128)).default({}),
    manualQueue: z.string().min(1).max(128).optional(),
    submitForReview: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.questionType === 'choice' && (!value.choices || value.choices.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'A choice question needs at least one choice.' });
    }
  });

export interface TemplateParameterDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface AutomationFlowDraft {
  name: string;
  description: string;
  status: 'draft';
  triggerType: 'manual';
  triggerOptions: Record<string, never>;
  graph: {
    entry: string;
    nodes: Array<{
      id: string;
      key: string;
      options: Record<string, unknown>;
      next?: string | null;
      branches?: Record<string, string | null>;
    }>;
  };
}

export interface AutomationTemplate {
  key: AutomationTemplateKey;
  name: string;
  description: string;
  parameters: TemplateParameterDoc[];
  /** The flow built from `exampleParams`, so a client can preview the shape. */
  example: AutomationFlowDraft;
  exampleParams: Record<string, unknown>;
}

export class AutomationTemplateError extends Error {
  constructor(readonly issues: Array<{ path: string[]; message: string }>) {
    super(issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; '));
    this.name = 'AutomationTemplateError';
  }
}

const COMMON_DOCS: TemplateParameterDoc[] = [
  { name: 'name', type: 'string', required: false, description: 'Flow name.' },
  { name: 'profileKey', type: 'string', required: true, description: 'Review profile key.' },
  { name: 'profileVersion', type: 'number', required: true, description: 'Pinned profile version.' },
  { name: 'collection', type: 'string', required: true, description: 'Collection the flow acts on.' },
  { name: 'questionKey', type: 'string', required: true, description: 'Profile question that decides.' },
];

function decisionNode(
  options: Record<string, unknown>,
  branchKeys: readonly string[],
  target: string,
): AutomationFlowDraft['graph']['nodes'][number] {
  const branches: Record<string, string | null> = {};
  for (const key of branchKeys) branches[key] = target;
  branches['unknown'] = target;
  branches['error'] = null;
  return { id: 'decide', key: 'ai:decision', options, branches };
}

function issuesOf(error: z.ZodError): Array<{ path: string[]; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }));
}

export function buildAutomationTemplate(key: AutomationTemplateKey, raw: unknown): AutomationFlowDraft {
  if (key === 'taxonomy-tagging') {
    const parsed = taxonomyTaggingParams.safeParse(raw);
    if (!parsed.success) throw new AutomationTemplateError(issuesOf(parsed.error));
    const p = parsed.data;
    return {
      name: p.name ?? `Jev taxonomy tagging — ${p.collection}`,
      description: `Shadow-first: proposes a "${p.tagField}" tag from "${p.profileKey}" v${p.profileVersion} / ${p.questionKey}.`,
      status: 'draft',
      triggerType: 'manual',
      triggerOptions: {},
      graph: {
        entry: 'decide',
        nodes: [
          decisionNode(
            {
              profileKey: p.profileKey,
              profileVersion: p.profileVersion,
              collection: p.collection,
              questionKey: p.questionKey,
              minConfidence: p.minConfidence,
              choices: p.choices,
            },
            p.choices,
            'tag',
          ),
          {
            id: 'tag',
            key: 'ai:apply-tags',
            options: {
              decisionNode: 'decide',
              collection: p.collection,
              tagField: p.tagField,
              ...(p.tagMap ? { tagMap: p.tagMap } : {}),
            },
            next: null,
          },
        ],
      },
    };
  }

  const parsed = editorialRoutingParams.safeParse(raw);
  if (!parsed.success) throw new AutomationTemplateError(issuesOf(parsed.error));
  const p = parsed.data;
  const branchKeys = p.questionType === 'choice' ? (p.choices ?? []) : ['true', 'false'];
  return {
    name: p.name ?? `Jev review routing — ${p.collection}`,
    description: `Shadow-first: proposes a "${p.queueField}" queue from "${p.profileKey}" v${p.profileVersion} / ${p.questionKey}. Never publishes.`,
    status: 'draft',
    triggerType: 'manual',
    triggerOptions: {},
    graph: {
      entry: 'decide',
      nodes: [
        decisionNode(
          {
            profileKey: p.profileKey,
            profileVersion: p.profileVersion,
            collection: p.collection,
            questionKey: p.questionKey,
            ...(p.questionType === 'choice'
              ? { minConfidence: p.minConfidence, choices: p.choices }
              : { noulThreshold: p.noulThreshold }),
          },
          branchKeys,
          'route',
        ),
        {
          id: 'route',
          key: 'editorial:route',
          options: {
            decisionNode: 'decide',
            collection: p.collection,
            queueField: p.queueField,
            queues: p.queues,
            ...(p.manualQueue ? { manualQueue: p.manualQueue } : {}),
            submitForReview: p.submitForReview,
          },
          next: null,
        },
      ],
    },
  };
}

const EXAMPLES: Record<AutomationTemplateKey, Record<string, unknown>> = {
  'taxonomy-tagging': {
    profileKey: 'taxonomy',
    profileVersion: 1,
    collection: 'posts',
    questionKey: 'category',
    choices: ['news', 'guide', 'opinion'],
    minConfidence: 0.8,
    tagField: 'tags',
  },
  'editorial-routing': {
    profileKey: 'brand-voice',
    profileVersion: 1,
    collection: 'posts',
    questionKey: 'needs_review',
    questionType: 'noul',
    noulThreshold: 0.8,
    queueField: 'review_queue',
    queues: { true: 'brand-review', false: 'standard' },
    manualQueue: 'manual-triage',
    submitForReview: true,
  },
};

export function listAutomationTemplates(): AutomationTemplate[] {
  return [
    {
      key: 'taxonomy-tagging',
      name: 'Taxonomy tagging',
      description:
        'Decide a category with a pinned review profile, then propose adding it as a tag. Shadow by default; never publishes.',
      parameters: [
        ...COMMON_DOCS,
        { name: 'choices', type: 'string[]', required: true, description: 'Choice keys of the question (one branch each).' },
        { name: 'minConfidence', type: 'number', required: false, description: "Decision cut below which the branch is 'unknown' (default 0.8)." },
        { name: 'tagField', type: 'string', required: true, description: 'Array-of-strings field the tag is added to.' },
        { name: 'tagMap', type: 'object', required: false, description: 'Choice key → tag value.' },
      ],
      exampleParams: EXAMPLES['taxonomy-tagging'],
      example: buildAutomationTemplate('taxonomy-tagging', EXAMPLES['taxonomy-tagging']),
    },
    {
      key: 'editorial-routing',
      name: 'Editorial queue routing',
      description:
        'Decide which review queue an item belongs in, then propose the routing field (and the submit_review transition). Shadow by default; never publishes.',
      parameters: [
        ...COMMON_DOCS,
        { name: 'questionType', type: "'choice' | 'noul'", required: true, description: 'Type of the deciding question.' },
        { name: 'choices', type: 'string[]', required: false, description: 'Choice keys (choice questions).' },
        { name: 'minConfidence', type: 'number', required: false, description: 'Choice cut (default 0.8).' },
        { name: 'noulThreshold', type: 'number', required: false, description: 'noul cut, 0.5–1 (default 0.8).' },
        { name: 'queueField', type: 'string', required: true, description: 'Field holding the queue name.' },
        { name: 'queues', type: 'object', required: false, description: 'Decision branch → queue name.' },
        { name: 'manualQueue', type: 'string', required: false, description: "Queue suggested for 'unknown' (never live)." },
        { name: 'submitForReview', type: 'boolean', required: false, description: 'Also propose submit_review when allowed.' },
      ],
      exampleParams: EXAMPLES['editorial-routing'],
      example: buildAutomationTemplate('editorial-routing', EXAMPLES['editorial-routing']),
    },
  ];
}

export function isAutomationTemplateKey(value: string): value is AutomationTemplateKey {
  return (AUTOMATION_TEMPLATE_KEYS as readonly string[]).includes(value);
}
