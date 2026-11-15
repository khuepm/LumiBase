/**
 * The save lost a race: the item changed after the draft was loaded, and the
 * server refused the write with 412 PRECONDITION_FAILED (`If-Match`).
 */
export function isPreconditionFailed(err: unknown): boolean {
  const e = err as { status?: number; body?: { errors?: Array<{ code?: string }> } } | null;
  return e?.status === 412 && e.body?.errors?.[0]?.code === 'PRECONDITION_FAILED';
}
