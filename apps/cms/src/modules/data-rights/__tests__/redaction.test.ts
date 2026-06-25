import { describe, it, expect } from 'vitest';

import { REDACTED, redactByClassification } from '../redaction';

const fields = [
  { name: 'title', classification: 'none' as const },
  { name: 'email', classification: 'pii' as const },
  { name: 'ssn', classification: 'sensitive' as const },
];

describe('redactByClassification', () => {
  it('masks pii and sensitive fields, leaves others', () => {
    const out = redactByClassification(fields, {
      title: 'Hello',
      email: 'a@b.co',
      ssn: '123-45',
    });
    expect(out.title).toBe('Hello');
    expect(out.email).toBe(REDACTED);
    expect(out.ssn).toBe(REDACTED);
  });

  it('can narrow to a single level', () => {
    const out = redactByClassification(fields, { email: 'a@b.co', ssn: '123' }, ['sensitive']);
    expect(out.email).toBe('a@b.co');
    expect(out.ssn).toBe(REDACTED);
  });

  it('leaves null/undefined values untouched and copies the record', () => {
    const input = { email: null, title: 'x' };
    const out = redactByClassification(fields, input);
    expect(out.email).toBeNull();
    expect(out).not.toBe(input);
  });

  it('is a no-op when no fields are classified', () => {
    const out = redactByClassification(
      [{ name: 'title', classification: 'none' as const }],
      { title: 'x' },
    );
    expect(out).toEqual({ title: 'x' });
  });
});
