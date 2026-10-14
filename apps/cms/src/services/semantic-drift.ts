/**
 * Semantic drift (Jev J12, #519): pure pieces shared by the drift scan and the
 * benchmark harness. No database or runtime imports, so `eval/` can load it.
 *
 * A semantic intent rule points at one `noul` question of a pinned review
 * profile version. The question asks whether the item drifts from the
 * criterion (off-brief, off-brand…):
 *
 *   noul ≥ threshold       → drift
 *   1 − noul ≥ threshold   → clean
 *   in between             → unevaluated (`between_thresholds`)
 *
 * Anything the scan cannot answer with evidence (provider outage, quota,
 * disabled site, missing profile, missing context) is `unevaluated` too. An
 * unevaluated outcome never resolves an existing drift and never reads as
 * clean: the scan keeps the previous drift row and records the new state.
 */

/** The rule as stored on the intent (validated by `ruleSchema` in intent-service.ts). */
export interface SemanticRule {
  type: 'semantic';
  /** Stable rule key, unique within the intent. */
  key: string;
  /** Bumped by the author whenever the rule's meaning changes. */
  version: number;
  profileKey: string;
  profileVersion: number;
  /** A `noul` question of that profile version. */
  questionKey: string;
  /** 0.5–1. See the module comment. */
  threshold: number;
  /** Fields judged for drift. Defaults to the profile's fields. */
  fields?: string[];
  /**
   * Where the reference for the judgement comes from: `intent` means the
   * pinned profile's criteria are the whole context; `field:<name>` also
   * sends that item field (a brief, an outline) as the reference.
   */
  contextSource: string;
}

export type SemanticUnevaluatedReason =
  /** The answer sits between the two thresholds. */
  | 'between_thresholds'
  /** The run abstained or reported no answer for the question. */
  | 'no_answer'
  /** The profile question is not a noul question. */
  | 'question_not_noul'
  /** `contextSource: field:<name>` and that field is empty or unreadable. */
  | 'context_missing'
  /** Any decision or review error code (`DECISION_UNAVAILABLE`, `REVIEW_PROFILE_NOT_FOUND`…). */
  | (string & {});

export type SemanticOutcome =
  | { kind: 'drift'; noul: number }
  | { kind: 'clean'; noul: number }
  | { kind: 'unevaluated'; reason: SemanticUnevaluatedReason; noul: number | null };

/** The context field of `field:<name>`, or null for `intent`. */
export function semanticContextField(contextSource: string): string | null {
  return contextSource.startsWith('field:') ? contextSource.slice('field:'.length) : null;
}

/**
 * Maps one noul probability to an outcome. `1 - noul >= t`, not
 * `noul <= 1 - t`, for the same float reason as `decisionBranch` (J10).
 */
export function semanticOutcome(noul: number | null | undefined, threshold: number): SemanticOutcome {
  if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    return { kind: 'unevaluated', reason: 'no_answer', noul: null };
  }
  if (noul >= threshold) return { kind: 'drift', noul };
  if (1 - noul >= threshold) return { kind: 'clean', noul };
  return { kind: 'unevaluated', reason: 'between_thresholds', noul };
}

/**
 * The `rule_key` of a semantic drift row: `<key>@v<version>:<profileVersion>:<contentHash>`.
 * The rule version, the profile version and the reviewed content all take
 * part, so changing any of them is a new fingerprint (the old row resolves
 * once the new state is evaluated) and a retry on the same state is the same
 * fingerprint (no duplicate drift, so no duplicate goal).
 */
export function semanticRuleKey(rule: Pick<SemanticRule, 'key' | 'version' | 'profileVersion'>, contentHash: string): string {
  return `${rule.key}@v${rule.version}:${rule.profileVersion}:${contentHash}`;
}

/** True when `ruleKey` belongs to the rule `key` (any version, any content). */
export function semanticRuleKeyMatches(ruleKey: string, key: string): boolean {
  return ruleKey.startsWith(`${key}@`);
}
