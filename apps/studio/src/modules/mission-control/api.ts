import { getActiveSite, getActiveToken } from '@/lib/api';

/**
 * Mission Control API access (content-os tasks 17-18).
 * Thin typed fetchers over the Agent API; same auth header convention as
 * the AI approvals settings page.
 */

async function agentFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'X-Lumi-Site': site } : {}),
      ...(init?.headers ?? {}),
      // Mission Control is the primary Studio control-plane UI for the Agent
      // Harness; assert the Studio client signal so withStudioAccess enforces
      // appAccess/TFA (mirrors agent-harness-page.tsx).
      'X-Lumi-Client': 'studio',
    },
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{ code: string; message: string }>;
  };
  if (!res.ok) {
    throw new Error(body.errors?.[0]?.message ?? `Request failed: ${res.status}`);
  }
  return body.data as T;
}

export interface AgentApproval {
  id: string;
  runId: string;
  subjectType: string;
  subjectId: string;
  status: string;
  kind: string;
  autoCommitAt: string | null;
  requestedByAgent: string;
  approverType: string;
  createdAt: string;
}

export interface StagedVeto {
  approvalId?: string;
  id?: string;
  revisionId?: string;
  autoCommitAt: string;
  collection?: string;
  itemId?: string;
  agentRole?: string;
  patch?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentIncident {
  id: string;
  agentRole: string;
  capability: string | null;
  source: string;
  severity: string;
  runId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface AutonomyGrant {
  id: string;
  agentRole: string;
  capability: string;
  level: number;
  evidence: Record<string, unknown>;
  grantedAt: string;
}

export interface ContentIntent {
  id: string;
  name: string;
  collection: string;
  rules: unknown[];
  schedule: string;
  autonomyCap: number;
  status: string;
  statusReason: string | null;
}

export interface ContentDrift {
  id: string;
  intentId: string;
  itemId: string;
  ruleType: string;
  ruleKey: string;
  status: string;
}

export interface ConstitutionVersion {
  id: string;
  version: number;
  evaluators: Array<Record<string, unknown>>;
  hash: string;
  status: string;
  createdAt: string;
}

export interface FreezeRecord {
  id: string;
  scope: string;
  targetRole: string | null;
  reason: string | null;
  liftedAt: string | null;
  createdAt: string;
}

export interface AgentRunRow {
  id: string;
  goalId: string;
  agentName: string;
  model: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
}

export interface AgentGoalRow {
  id: string;
  title: string;
  status: string;
  origin: string;
  parentGoalId: string | null;
  intentId: string | null;
  agentRole: string | null;
  assigneeAgent: string;
  createdAt: string;
}

export interface PromotionProposal {
  id: string;
  subjectType?: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

/** Agent role row (content-os-ui Req 16). */
export interface AgentRoleRow {
  id: string;
  name: string;
  description: string | null;
  systemPromptRef: string | null;
  model: string | null;
  capabilities: string[];
  enabled: boolean;
}

export interface AgentRoleInput {
  name: string;
  description?: string;
  systemPromptRef?: string;
  model?: string;
  capabilities: string[];
  enabled?: boolean;
}

/** Sub-goal input for planner decomposition (content-os-ui Req 18). */
export interface SubGoalInput {
  title: string;
  description?: string;
  agentRole: string;
}

/** Result of a manual reconciliation cycle (content-os-ui Req 17.1). */
export interface IntentScanResult {
  scan: Record<string, unknown>;
  reconcile: Record<string, unknown>;
}

/** Promotion eligibility check result (content-os-ui Req 20). */
export interface PromotionCheckResult {
  proposed: boolean;
  [key: string]: unknown;
}

/** Mirrors ContentOsFlags in apps/cms/src/services/feature-flags.ts. */
export interface ContentOsFlags {
  reconciler: boolean;
  vetoWindow: boolean;
  agentReview: boolean;
  mcp: boolean;
}

export interface ContentOsFlagsSnapshot {
  flags: ContentOsFlags;
  /**
   * Full value of the `contentOs` settings row. The row carries non-flag
   * keys too (e.g. `agentReviewMinConfidence`) — saves must merge the four
   * flags over this object so those keys survive a toggle.
   */
  raw: Record<string, unknown>;
}

export const missionControlApi = {
  approvals: () => agentFetch<AgentApproval[]>('/api/v1/agent/approvals'),
  decideApproval: (id: string, decision: 'approved' | 'rejected', reason?: string) =>
    agentFetch(`/api/v1/agent/approvals/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason }),
    }),
  staged: () => agentFetch<StagedVeto[]>('/api/v1/agent/staged'),
  veto: (approvalId: string, reason?: string) =>
    agentFetch(`/api/v1/agent/staged/${approvalId}/veto`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  autonomy: () =>
    agentFetch<{ grants: AutonomyGrant[]; openIncidents: AgentIncident[] }>('/api/v1/agent/autonomy'),
  promotions: () => agentFetch<PromotionProposal[]>('/api/v1/agent/autonomy/promotions'),
  decidePromotion: (id: string, decision: 'approved' | 'rejected', reason?: string) =>
    agentFetch(`/api/v1/agent/autonomy/promotions/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason }),
    }),
  runs: () => agentFetch<AgentRunRow[]>('/api/v1/agent/runs'),
  goals: () => agentFetch<AgentGoalRow[]>('/api/v1/agent/goals'),
  intents: () => agentFetch<ContentIntent[]>('/api/v1/agent/intents'),
  drifts: (intentId: string) =>
    agentFetch<ContentDrift[]>(`/api/v1/agent/intents/${intentId}/drifts`),
  /** Contract: the compile route validates `{description, collection}` (Req 11.1). */
  compileIntent: (description: string, collection: string) =>
    agentFetch<{ rules: Array<Record<string, unknown>>; schedule: string; warnings: string[] }>(
      '/api/v1/agent/intents/compile',
      { method: 'POST', body: JSON.stringify({ description, collection }) },
    ),
  createIntent: (input: Record<string, unknown>) =>
    agentFetch<ContentIntent>('/api/v1/agent/intents', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  resumeIntent: (id: string) =>
    agentFetch(`/api/v1/agent/intents/${id}/resume`, { method: 'POST', body: '{}' }),
  constitution: () =>
    agentFetch<{ versions: ConstitutionVersion[]; active: ConstitutionVersion | null }>(
      '/api/v1/agent/constitution',
    ),
  compileConstitution: (text: string) =>
    agentFetch<{ evaluators: Array<Record<string, unknown>> }>('/api/v1/agent/constitution/compile', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  createConstitutionDraft: (evaluators: unknown) =>
    agentFetch<ConstitutionVersion>('/api/v1/agent/constitution', {
      method: 'POST',
      body: JSON.stringify({ evaluators }),
    }),
  dryRunConstitution: (id: string, samples: Array<Record<string, unknown>>) =>
    agentFetch<Array<{ sample: number; results: Array<Record<string, unknown>> }>>(
      `/api/v1/agent/constitution/${id}/dry-run`,
      { method: 'POST', body: JSON.stringify({ samples }) },
    ),
  activateConstitution: (id: string) =>
    agentFetch<ConstitutionVersion>(`/api/v1/agent/constitution/${id}/activate`, {
      method: 'POST',
      body: '{}',
    }),
  killSwitch: () =>
    agentFetch<{ active: FreezeRecord[]; history: FreezeRecord[] }>('/api/v1/agent/kill-switch'),
  activateKillSwitch: (scope: string, targetId?: string, reason?: string) =>
    agentFetch('/api/v1/agent/kill-switch', {
      method: 'POST',
      body: JSON.stringify({ scope, targetId, reason }),
    }),
  liftKillSwitch: (scope: 'role' | 'site', targetId?: string) =>
    agentFetch('/api/v1/agent/kill-switch/lift', {
      method: 'POST',
      body: JSON.stringify({ scope, targetId }),
    }),
  // ── Agent roles (content-os-ui Req 16) ──────────────────────────────────
  roles: () => agentFetch<AgentRoleRow[]>('/api/v1/agent/roles'),
  createRole: (input: AgentRoleInput) =>
    agentFetch<AgentRoleRow>('/api/v1/agent/roles', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateRole: (name: string, patch: Partial<Omit<AgentRoleInput, 'name'>>) =>
    agentFetch<AgentRoleRow>(`/api/v1/agent/roles/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteRole: (name: string) =>
    agentFetch(`/api/v1/agent/roles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // ── Intent lifecycle (content-os-ui Req 17) ─────────────────────────────
  updateIntent: (id: string, patch: Record<string, unknown>) =>
    agentFetch<ContentIntent>(`/api/v1/agent/intents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteIntent: (id: string) =>
    agentFetch(`/api/v1/agent/intents/${id}`, { method: 'DELETE' }),
  scanIntent: (id: string) =>
    agentFetch<IntentScanResult>(`/api/v1/agent/intents/${id}/scan`, {
      method: 'POST',
      body: '{}',
    }),
  // ── Planner (content-os-ui Req 18) ──────────────────────────────────────
  decomposeGoal: (id: string, subGoals: SubGoalInput[]) =>
    agentFetch<AgentGoalRow[]>(`/api/v1/agent/goals/${id}/decompose`, {
      method: 'POST',
      body: JSON.stringify({ subGoals }),
    }),
  settleGoal: (id: string) =>
    agentFetch<AgentGoalRow>(`/api/v1/agent/goals/${id}/settle`, {
      method: 'POST',
      body: '{}',
    }),
  // ── Promotion eligibility (content-os-ui Req 20) ────────────────────────
  checkPromotion: (agentRole: string, capability: string) =>
    agentFetch<PromotionCheckResult>('/api/v1/agent/autonomy/promotions/check', {
      method: 'POST',
      body: JSON.stringify({ agentRole, capability }),
    }),
  /**
   * Rollout flags switchboard (content-os-ui Req 15). Reads the per-site
   * `contentOs` settings row; a 404 means the row was never materialised
   * (pre-seeding instance) and every flag reads OFF — the same semantics
   * as `getContentOsFlags` on the CMS side.
   */
  contentOsFlags: async (): Promise<ContentOsFlagsSnapshot> => {
    const token = getActiveToken();
    const site = getActiveSite();
    const res = await fetch('/api/v1/settings/contentOs', {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(site ? { 'x-site-id': site } : {}),
      },
    });
    if (res.status === 404) {
      return {
        flags: { reconciler: false, vetoWindow: false, agentReview: false, mcp: false },
        raw: {},
      };
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { value?: unknown };
      errors?: Array<{ code: string; message: string }>;
    };
    if (!res.ok) {
      throw new Error(body.errors?.[0]?.message ?? `Request failed: ${res.status}`);
    }
    const value =
      body.data?.value && typeof body.data.value === 'object' && !Array.isArray(body.data.value)
        ? (body.data.value as Record<string, unknown>)
        : {};
    return {
      flags: {
        reconciler: value.reconciler === true,
        vetoWindow: value.vetoWindow === true,
        agentReview: value.agentReview === true,
        mcp: value.mcp === true,
      },
      raw: value,
    };
  },
  /** Upserts the whole row value — callers pass `{...raw, ...flags}`. */
  saveContentOsFlags: (value: Record<string, unknown>) =>
    agentFetch('/api/v1/settings', {
      method: 'POST',
      body: JSON.stringify({ key: 'contentOs', value }),
    }),
};
