/**
 * Initial template limits (#901, spec execution-and-acceptance.md). A value AT
 * the limit is accepted when everything else is valid; limit + 1 is refused
 * with `LIMIT_EXCEEDED`, never truncated. Limits apply to the artifact itself,
 * not to transport bytes around it.
 */
export const TEMPLATE_LIMITS = {
  /** UTF-8 bytes of the JSON document. */
  maxDocumentBytes: 2 * 1024 * 1024,
  /** Container nesting depth; the top-level object is depth 1. */
  maxDepth: 32,
  maxCollections: 100,
  maxFields: 2000,
  maxRelations: 500,
  /** Seed records across all packs of the artifact. */
  maxSeedRecords: 1000,
  /** UTF-8 bytes of canonical seed `values` + `references` across the artifact. */
  maxSeedValueBytes: 1024 * 1024,
} as const;

/** Storage modes template v1 can install (R1: JSONB is the portable default). */
export const TEMPLATE_SUPPORTED_STORAGE_MODES = ['jsonb'] as const;
