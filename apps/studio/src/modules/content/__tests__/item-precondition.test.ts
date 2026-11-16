import { describe, expect, it } from 'vitest';
import { isPreconditionFailed } from '../save-conflict';

/** The item editor shows the "changed by someone else" banner only for 412 PRECONDITION_FAILED. */
describe('isPreconditionFailed', () => {
  it('matches a 412 with the PRECONDITION_FAILED code', () => {
    expect(
      isPreconditionFailed({ status: 412, body: { errors: [{ code: 'PRECONDITION_FAILED' }] } }),
    ).toBe(true);
  });

  it('ignores other failures', () => {
    expect(isPreconditionFailed({ status: 412, body: { errors: [{ code: 'OTHER' }] } })).toBe(false);
    expect(isPreconditionFailed({ status: 409, body: { errors: [{ code: 'PRECONDITION_FAILED' }] } })).toBe(false);
    expect(isPreconditionFailed(new Error('network'))).toBe(false);
    expect(isPreconditionFailed(null)).toBe(false);
  });
});
