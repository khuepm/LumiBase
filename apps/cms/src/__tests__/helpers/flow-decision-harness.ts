/**
 * Test harness for the Flows `ai:decision` operation (J10, #517).
 *
 * Everything below the operation is real except the edges: a real
 * ReviewService over the in-memory store (same unique constraints as the DB),
 * the real governed decision path (`runGovernedDecision` → quota ledger on a
 * MemoryCacheProvider → audit mapping) and a fake upstream provider that
 * counts calls. Grants and site settings are mutable so a test can revoke a
 * capability or flip the kill switch between enqueue and execution.
 */
import { vi } from 'vitest';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { ReviewProfileCreateInputSchema } from '@lumibase/contracts/schemas';
import {
  DEFAULT_DECISION_QUOTA,
  runGovernedDecision,
  type DecisionQuota,
  type DecisionSiteSettings,
} from '../../services/decision-governance';
import {
  DEFAULT_DECISION_LIMITS,
  type ConfiguredDecisionProvider,
  type DecisionAnswer,
  type DecisionCallOptions,
  type DecisionRequest,
  type DecisionResponse,
} from '../../services/decision-provider';
import type { AuthenticatedPrincipalRef } from '../../services/effective-capability-service';
import type { AiDecisionRuntime } from '../../services/flow-ai-decision';
import type { GovernedCapabilityResolution } from '../../services/governed-capabilities';
import type { MagicContext } from '../../services/permission-dsl';
import { ReviewService, ReviewServiceError, type ReviewContentAccess } from '../../services/review-service';
import { MemoryReviewStore } from './memory-review-store';

export const SITE = 'site_1';
export const editorRef: AuthenticatedPrincipalRef = { type: 'user', siteId: SITE, userId: 'usr_editor' };

export const PROFILE_KEY = 'moderation';

/** A profile with a noul and a choice question; v1 is pinned by the tests. */
export const profileInput = ReviewProfileCreateInputSchema.parse({
  key: PROFILE_KEY,
  collection: 'posts',
  fields: ['title', 'body'],
  questions: {
    spam: { type: 'noul', instructions: 'Is this post spam?', criteria: { true: 'spam', false: 'legitimate' } },
    category: {
      type: 'choice',
      instructions: 'Which section does this post belong to?',
      criteria: { news: 'News', promo: 'Promotion', other: null, unknown: null },
    },
    tone: { type: 'score', instructions: 'How formal is it?', criteria: ['casual', 'neutral', 'formal'] },
  },
});

function permissionContext(ref: AuthenticatedPrincipalRef): MagicContext {
  return {
    userId: ref.type === 'user' ? ref.userId : null,
    siteId: ref.siteId,
    roleId: null,
    user: null,
    ip: null,
    headers: {},
    apiKey: ref.type === 'api_key' ? { id: ref.apiKeyId } : null,
  } as MagicContext;
}

export interface DecisionHarness {
  runtime: AiDecisionRuntime;
  store: MemoryReviewStore;
  settings: { value: DecisionSiteSettings };
  /** Capabilities per principal id; absent = the principal no longer resolves. */
  grants: Map<string, string[]>;
  /** Answers the fake provider returns, or an error it throws. */
  upstream: { answers: Record<string, DecisionAnswer>; error: Error | null };
  provider: ConfiguredDecisionProvider & { provider: { decide: ReturnType<typeof vi.fn> } };
  /** Set to null to simulate an unconfigured provider. */
  configured: { value: ConfiguredDecisionProvider | null };
  content: ReviewContentAccess & { onRead?: () => void; items: Record<string, Record<string, unknown>> };
  quota: { value: DecisionQuota };
}

function idOf(ref: AuthenticatedPrincipalRef): string {
  return ref.type === 'user' ? ref.userId : ref.type === 'api_key' ? ref.apiKeyId : 'dev';
}

export async function decisionHarness(siteId = SITE): Promise<DecisionHarness> {
  const store = new MemoryReviewStore();
  const cache = new MemoryCacheProvider();
  const settings = { value: { enabled: true, allowedStateFields: null, flows: true } as DecisionSiteSettings };
  const grants = new Map<string, string[]>([['usr_editor', ['ai:decide', 'items:read']]]);
  const upstream: DecisionHarness['upstream'] = {
    answers: {
      spam: { type: 'noul', noul: 0.95 },
      category: { type: 'choice', choice: 'news', probabilities: { news: 0.9, promo: 0.1 }, confidence: 0.9 },
      tone: { type: 'score', score: 1, legend: {}, probabilities: {}, confidence: 0.8 },
    },
    error: null,
  };
  const decide = vi.fn(async (_request: DecisionRequest, options?: DecisionCallOptions): Promise<DecisionResponse> => {
    if (options?.signal?.aborted) {
      const { DecisionProviderError } = await import('../../services/decision-provider');
      throw new DecisionProviderError('DECISION_CANCELLED', 'cancelled');
    }
    options?.onAttempt?.();
    if (upstream.error) throw upstream.error;
    return { provider: 'typesafe', model: 'jev-1.13', calibrated: true, answers: upstream.answers, usage: { inputTokens: 10, outputTokens: 2 } };
  });
  const provider = { name: 'typesafe', model: 'jev-1.13', limits: DEFAULT_DECISION_LIMITS, provider: { decide } };
  const configured: DecisionHarness['configured'] = { value: provider };
  const quota = { value: DEFAULT_DECISION_QUOTA };

  const content: DecisionHarness['content'] = {
    items: { itm_1: { title: 'Summer sale', body: 'Buy now' } },
    async readItem(_collection, itemId, fields) {
      content.onRead?.();
      const item = content.items[itemId];
      if (!item) throw new ReviewServiceError('REVIEW_ITEM_NOT_FOUND', `Item "${itemId}" not found.`);
      const values: Record<string, unknown> = {};
      for (const field of fields) if (item[field] !== undefined) values[field] = item[field];
      return { values, omittedFields: [] };
    },
    async deniedSnapshotFields() {
      return [];
    },
    async latestRevisionId() {
      return null;
    },
  };

  const runtime: AiDecisionRuntime = {
    db: undefined,
    siteId,
    async resolveGrant(ref): Promise<GovernedCapabilityResolution> {
      const capabilities = ref.siteId === siteId ? grants.get(idOf(ref)) : undefined;
      if (!capabilities) {
        return { allowed: false, capabilities: [], controlPlaneAdmin: false, code: 'PRINCIPAL_NOT_FOUND', message: 'gone' };
      }
      return { allowed: true, capabilities, controlPlaneAdmin: false, permissionContext: permissionContext(ref) };
    },
    async readSettings() {
      return settings.value;
    },
    reviewService(_ctx, audit) {
      return new ReviewService({
        store,
        siteId,
        content,
        decide: (request, { signal }) =>
          runGovernedDecision(
            async () => ({ configured: configured.value, settings: settings.value, quota: quota.value, cache, siteId }),
            request,
            { signal, audit },
          ),
      });
    },
  };

  const admin = { type: 'user' as const, id: 'usr_admin', admin: true };
  const seed = new ReviewService({ store, siteId, content, decide: async () => { throw new Error('unused'); } });
  await seed.createProfile(profileInput, admin);

  return { runtime, store, settings, grants, upstream, provider, configured, content, quota };
}
