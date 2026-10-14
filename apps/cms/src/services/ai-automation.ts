/**
 * Jev metadata automation (J11, #518): settings and the shadow/live decision.
 *
 * Automation is shadow-first. A Flows node (`ai:apply-tags`,
 * `editorial:route`) always records what it would change. It proposes a real
 * write only when every one of these holds, re-read when the node executes:
 *
 *   - `aiDecisions.automation.mode` is `live`;
 *   - a gate record names who approved going live, when, and the evidence
 *     (`gate.approvedBy`, `gate.approvedAt`, `gate.evidenceRef`);
 *   - a threshold exists for the item's locale and the action, and its
 *     provider, model and profile version match the decision that was made;
 *   - the decision's confidence is at or above that threshold (the
 *     auto-action zone).
 *
 * Anything else — a malformed block, a missing gate, a missing threshold, a
 * model or profile version the threshold was not measured for — forces
 * shadow. A live proposal still goes through the governed harness capped at
 * L1, so it becomes an approval a human decides on; automation never writes
 * on its own authority (see `ai-automation-ops.ts`).
 */

import { z } from 'zod';
import type { DecisionSiteSettings } from './decision-governance';

/** Agent identity the harness keys the kill switch and autonomy grant on. */
export const AUTOMATION_AGENT = 'jev-automation';

/**
 * Autonomy ceiling for automation writes: L1 (propose). The harness resolves
 * min(grant, cap), so a grant of L2–L4 still yields L1 → an approval, and L0
 * yields shadow (no write). Automation can never reach direct execution.
 */
export const AUTOMATION_AUTONOMY_CAP = 1;

export const AUTOMATION_ACTIONS = ['tag', 'route'] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export type AutomationMode = 'shadow' | 'live';

const thresholdSchema = z
  .object({
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    profileVersion: z.number().int().positive(),
    minConfidence: z.number().min(0).max(1),
  })
  .strict();

const gateSchema = z
  .object({
    approvedBy: z.string().trim().min(1).max(256),
    approvedAt: z.string().datetime({ offset: true }),
    evidenceRef: z.string().trim().min(1).max(2048),
  })
  .strict();

const localeKey = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'locale must be a BCP 47 tag');

export const automationSettingsSchema = z
  .object({
    mode: z.enum(['shadow', 'live']).default('shadow'),
    thresholds: z.record(localeKey, z.partialRecord(z.enum(AUTOMATION_ACTIONS), thresholdSchema)).default({}),
    gate: gateSchema.optional(),
  })
  .strict();

export type AutomationThreshold = z.infer<typeof thresholdSchema>;
export type AutomationGate = z.infer<typeof gateSchema>;

export interface AutomationSettings {
  mode: AutomationMode;
  thresholds: Record<string, Partial<Record<AutomationAction, AutomationThreshold>>>;
  gate: AutomationGate | null;
  /** True when a stored block was present but did not parse (it then reads as shadow). */
  malformed: boolean;
}

export const AUTOMATION_SHADOW: AutomationSettings = { mode: 'shadow', thresholds: {}, gate: null, malformed: false };

/** Parses `aiDecisions.automation`. Absent or malformed → shadow, never live. */
export function parseAutomationSettings(settings: Pick<DecisionSiteSettings, 'automation'>): AutomationSettings {
  if (settings.automation === undefined || settings.automation === null) return AUTOMATION_SHADOW;
  const parsed = automationSettingsSchema.safeParse(settings.automation);
  if (!parsed.success) return { ...AUTOMATION_SHADOW, malformed: true };
  return {
    mode: parsed.data.mode,
    thresholds: parsed.data.thresholds,
    gate: parsed.data.gate ?? null,
    malformed: false,
  };
}

/** Why a proposal is shadow (or `live`). Stored on the action row as `reason`. */
export type AutomationModeReason =
  | 'live'
  | 'settings_malformed'
  | 'mode_shadow'
  | 'gate_missing'
  | 'locale_unknown'
  | 'threshold_missing'
  | 'provider_mismatch'
  | 'model_mismatch'
  | 'profile_version_mismatch';

export interface AutomationDecisionFacts {
  action: AutomationAction;
  locale: string | null;
  provider: string | null;
  model: string | null;
  profileVersion: number;
}

export interface AutomationModeResolution {
  mode: AutomationMode;
  reason: AutomationModeReason;
  /** The threshold that applies to this locale/action, when one is configured. */
  threshold: AutomationThreshold | null;
}

/**
 * The threshold configured for `facts`, ignoring whether it matches the
 * decision's provider/model/profile. Used to place a shadow proposal in or
 * out of the auto-action zone, so shadow metrics measure exactly the zone a
 * live switch would act in.
 */
export function automationThreshold(
  settings: AutomationSettings,
  facts: Pick<AutomationDecisionFacts, 'action' | 'locale'>,
): AutomationThreshold | null {
  if (!facts.locale) return null;
  return settings.thresholds[facts.locale]?.[facts.action] ?? null;
}

/** Pure: shadow unless every live condition holds. */
export function resolveAutomationMode(settings: AutomationSettings, facts: AutomationDecisionFacts): AutomationModeResolution {
  const threshold = automationThreshold(settings, facts);
  const shadow = (reason: AutomationModeReason): AutomationModeResolution => ({ mode: 'shadow', reason, threshold });
  if (settings.malformed) return shadow('settings_malformed');
  if (settings.mode !== 'live') return shadow('mode_shadow');
  if (!settings.gate) return shadow('gate_missing');
  if (!facts.locale) return shadow('locale_unknown');
  if (!threshold) return shadow('threshold_missing');
  if (threshold.provider !== facts.provider) return shadow('provider_mismatch');
  if (threshold.model !== facts.model) return shadow('model_mismatch');
  if (threshold.profileVersion !== facts.profileVersion) return shadow('profile_version_mismatch');
  return { mode: 'live', reason: 'live', threshold };
}

/**
 * Whether `confidence` is in the auto-action zone. Without a configured
 * threshold nothing is in the zone: the zone is defined by the thresholds
 * chosen on the J06 tune split, not by the decision node's own cut.
 */
export function inAutoActionZone(confidence: number | null, threshold: AutomationThreshold | null): boolean {
  return threshold !== null && confidence !== null && confidence >= threshold.minConfidence;
}
