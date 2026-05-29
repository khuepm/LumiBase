import { describe, expect, it } from 'vitest';
import { classifySetupCompleteError } from '../use-complete-setup';

/**
 * Unit tests for the pure error-classification helper extracted from
 * `useCompleteSetup`. The helper is the only piece of the hook that
 * has interesting branching logic without React/router dependencies,
 * so we exercise the full status × envelope matrix here.
 *
 * Spec refs: design.md §4.3 (`/setup/complete` error contract).
 */

describe('classifySetupCompleteError', () => {
  it('400 → VALIDATION_ERROR', () => {
    const result = classifySetupCompleteError(400, {
      errors: [{ code: 'VALIDATION_ERROR', message: 'bad input' }],
    });
    expect(result.code).toBe('VALIDATION_ERROR');
    expect(result.message).toBe('bad input');
  });

  it('400 with no envelope falls back to default copy', () => {
    const result = classifySetupCompleteError(400, null);
    expect(result.code).toBe('VALIDATION_ERROR');
    expect(result.message).toMatch(/invalid/i);
  });

  it('404 → ALREADY_INITIALIZED', () => {
    const result = classifySetupCompleteError(404, {
      errors: [{ code: 'ALREADY_INITIALIZED' }],
    });
    expect(result.code).toBe('ALREADY_INITIALIZED');
  });

  it('409 → SETUP_IN_PROGRESS', () => {
    const result = classifySetupCompleteError(409, {
      errors: [{ code: 'SETUP_IN_PROGRESS' }],
    });
    expect(result.code).toBe('SETUP_IN_PROGRESS');
  });

  it('422 + envelope code PATH_PREDICTABLE → PATH_PREDICTABLE', () => {
    const result = classifySetupCompleteError(422, {
      errors: [
        {
          code: 'PATH_PREDICTABLE',
          message: 'choose another',
        },
      ],
    });
    expect(result.code).toBe('PATH_PREDICTABLE');
    expect(result.message).toBe('choose another');
  });

  it('422 + envelope code PATH_RESERVED → PATH_RESERVED', () => {
    const result = classifySetupCompleteError(422, {
      errors: [{ code: 'PATH_RESERVED' }],
    });
    expect(result.code).toBe('PATH_RESERVED');
  });

  it('422 with unknown envelope code falls back to VALIDATION_ERROR', () => {
    const result = classifySetupCompleteError(422, {
      errors: [{ code: 'WHATEVER' }],
    });
    expect(result.code).toBe('VALIDATION_ERROR');
  });

  it('500 → UNKNOWN', () => {
    const result = classifySetupCompleteError(500, {
      errors: [{ code: 'INTERNAL' }],
    });
    expect(result.code).toBe('UNKNOWN');
  });

  it('malformed body (string) → UNKNOWN preserves status', () => {
    const result = classifySetupCompleteError(500, 'not json');
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toMatch(/HTTP 500/);
  });

  it('malformed body (number) → UNKNOWN', () => {
    const result = classifySetupCompleteError(503, 42);
    expect(result.code).toBe('UNKNOWN');
  });

  it('null body on a 422 → VALIDATION_ERROR (default copy)', () => {
    const result = classifySetupCompleteError(422, null);
    expect(result.code).toBe('VALIDATION_ERROR');
    expect(result.message).toMatch(/validation/i);
  });

  it('envelope without errors array on 404 still classifies', () => {
    const result = classifySetupCompleteError(404, {});
    expect(result.code).toBe('ALREADY_INITIALIZED');
  });

  it('418 (unexpected status) → UNKNOWN', () => {
    const result = classifySetupCompleteError(418, null);
    expect(result.code).toBe('UNKNOWN');
  });
});
