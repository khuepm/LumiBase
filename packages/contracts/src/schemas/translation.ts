/**
 * Translation Memory shared constants.
 *
 * Single source of truth for the fuzzy-match threshold so the backend
 * service (`bestMatch`) and the Studio UI lookup default never drift.
 * See `.kiro/specs/translation-memory-ui`.
 */

/** Default Levenshtein similarity threshold (0–100) for a TM match to surface. */
export const TM_DEFAULT_THRESHOLD = 75;
