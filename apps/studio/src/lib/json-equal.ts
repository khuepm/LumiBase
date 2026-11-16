/**
 * Structural equality for JSON values, ignoring object key order.
 *
 * Item data round-trips through Postgres JSONB, which stores object keys in its
 * own order (shorter keys first), not insertion order. Comparing
 * `JSON.stringify` output therefore reports a difference between a form draft
 * and the saved row whenever a field was filled in after the others — the item
 * editor then stayed "unsaved" after a successful save, and Submit for review /
 * Publish stayed disabled until a reload.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  // `undefined` members are dropped by JSON serialisation, so they never reach
  // the server and must not count as a difference.
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonEqual(ao[k], bo[k]));
}
