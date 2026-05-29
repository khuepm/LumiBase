import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';
import {
  ADMIN_PATH_PLACEHOLDER,
  getLogLevel,
  maskAdminPath,
  maskAdminPathInString,
  shouldRetainRawAdminPath,
} from '../path-mask';

/**
 * Feature: admin-setup-wizard, task 4.5 — `path-mask`.
 *
 * Covers the contract pinned in Req 5.5 ("THE Admin_Path_Guard SHALL
 * không ghi log chi tiết Admin_Path thực tế ở mức log mặc định … WHERE
 * log level là `debug`, raw path SHALL được ghi"):
 *
 *   1. substring replacement (single + multiple occurrences,
 *      case-insensitive);
 *   2. no-op when adminPath is null / undefined / empty / whitespace;
 *   3. info / warn / error → mask; debug → passthrough; unknown →
 *      mask (default-deny);
 *   4. nested-object metadata gets masked recursively without
 *      mutating the input;
 *   5. arrays + primitives (numbers, booleans, null) round-trip
 *      untouched;
 *   6. property-test idempotency: applying the masker twice yields
 *      the same output as applying it once.
 *
 * **Validates: Requirements 5.5**
 */

const ADMIN_PATH = '/lumi-7f3a9c';

/**
 * Snapshot + restore `process.env.LOG_LEVEL` between tests so changes
 * in one block can't poison another. We intentionally mutate the real
 * env in some tests (rather than always passing `opts.level`) to prove
 * that the helper picks up the runtime value — that path is the
 * production hot path.
 */
let originalLogLevel: string | undefined;
beforeEach(() => {
  originalLogLevel = process.env.LOG_LEVEL;
});
afterEach(() => {
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
  vi.restoreAllMocks();
});

describe('getLogLevel', () => {
  it('returns the lowercase trimmed env value when set', () => {
    process.env.LOG_LEVEL = '  DEBUG  ';
    expect(getLogLevel()).toBe('debug');
  });

  it('defaults to "info" when LOG_LEVEL is unset', () => {
    delete process.env.LOG_LEVEL;
    expect(getLogLevel()).toBe('info');
  });

  it('defaults to "info" when LOG_LEVEL is empty/whitespace', () => {
    process.env.LOG_LEVEL = '   ';
    expect(getLogLevel()).toBe('info');
  });

  it('does not throw when process.env access raises', () => {
    // Simulate a sandboxed runtime by trapping the descriptor with a
    // throwing getter. We restore via vi.restoreAllMocks() in afterEach.
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'process');
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      get() {
        throw new Error('no process in this runtime');
      },
    });
    try {
      expect(getLogLevel()).toBe('info');
    } finally {
      if (desc) Object.defineProperty(globalThis, 'process', desc);
    }
  });
});

describe('shouldRetainRawAdminPath', () => {
  it.each(['debug', 'DEBUG', 'Debug'])(
    'returns true for level=%s (case-insensitive)',
    (level) => {
      expect(shouldRetainRawAdminPath(level)).toBe(true);
    },
  );

  it.each(['info', 'warn', 'error', 'trace', 'silent', 'unknown', ''])(
    'returns false for level=%s (default-deny)',
    (level) => {
      expect(shouldRetainRawAdminPath(level)).toBe(false);
    },
  );

  it('falls through to getLogLevel() when no level is passed', () => {
    process.env.LOG_LEVEL = 'debug';
    expect(shouldRetainRawAdminPath()).toBe(true);
    process.env.LOG_LEVEL = 'info';
    expect(shouldRetainRawAdminPath()).toBe(false);
  });
});

describe('maskAdminPathInString — substring replacement', () => {
  it('replaces a single occurrence with the spec placeholder', () => {
    const out = maskAdminPathInString(
      `request to ${ADMIN_PATH} matched`,
      ADMIN_PATH,
    );
    expect(out).toBe(`request to ${ADMIN_PATH_PLACEHOLDER} matched`);
  });

  it('replaces every occurrence (global match)', () => {
    const input = `${ADMIN_PATH} a ${ADMIN_PATH} b ${ADMIN_PATH}`;
    const out = maskAdminPathInString(input, ADMIN_PATH);
    expect(out).toBe(
      `${ADMIN_PATH_PLACEHOLDER} a ${ADMIN_PATH_PLACEHOLDER} b ${ADMIN_PATH_PLACEHOLDER}`,
    );
  });

  it('matches case-insensitively (uppercased copy on the wire)', () => {
    const upper = ADMIN_PATH.toUpperCase();
    const out = maskAdminPathInString(`hit ${upper}/login`, ADMIN_PATH);
    expect(out).toBe(`hit ${ADMIN_PATH_PLACEHOLDER}/login`);
  });

  it('handles regex-significant characters in the admin path verbatim', () => {
    // Validators reject these in production but the helper must still
    // be safe — a literal '.' must not become a wildcard match.
    const tricky = '/lumi.7+f*[a]';
    const input = `safe-prefix ${tricky}/x and a fake /lumiaf+f*[a]/x`;
    const out = maskAdminPathInString(input, tricky);
    expect(out).toBe(
      `safe-prefix ${ADMIN_PATH_PLACEHOLDER}/x and a fake /lumiaf+f*[a]/x`,
    );
  });

  it('returns the original string when the path is not present', () => {
    const input = 'request to /elsewhere matched';
    const out = maskAdminPathInString(input, ADMIN_PATH);
    expect(out).toBe(input);
  });

  it('respects a custom placeholder', () => {
    const out = maskAdminPathInString(
      `path is ${ADMIN_PATH}`,
      ADMIN_PATH,
      '<REDACTED>',
    );
    expect(out).toBe('path is <REDACTED>');
  });
});

describe('maskAdminPathInString — no-op cases', () => {
  it.each([null, undefined, '', '   '])(
    'returns input unchanged when adminPath=%p',
    (path) => {
      const input = `say ${ADMIN_PATH}`;
      expect(maskAdminPathInString(input, path as never)).toBe(input);
    },
  );

  it('returns non-string input unchanged (defensive)', () => {
    const f = maskAdminPathInString as unknown as (a: unknown, b: unknown) => unknown;
    expect(f(null, ADMIN_PATH)).toBe(null);
    expect(f(undefined, ADMIN_PATH)).toBe(undefined);
    expect(f(42, ADMIN_PATH)).toBe(42);
  });
});

describe('maskAdminPath — log-level routing', () => {
  it('passes raw value through when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    const input = `request to ${ADMIN_PATH}`;
    expect(maskAdminPath(input, ADMIN_PATH)).toBe(input);
  });

  it.each(['info', 'warn', 'error'])(
    'masks raw value when LOG_LEVEL=%s',
    (level) => {
      process.env.LOG_LEVEL = level;
      expect(maskAdminPath(`hit ${ADMIN_PATH}`, ADMIN_PATH)).toBe(
        `hit ${ADMIN_PATH_PLACEHOLDER}`,
      );
    },
  );

  it('respects an explicit opts.level over the env', () => {
    process.env.LOG_LEVEL = 'info';
    expect(
      maskAdminPath(`hit ${ADMIN_PATH}`, ADMIN_PATH, { level: 'debug' }),
    ).toBe(`hit ${ADMIN_PATH}`);
    expect(
      maskAdminPath(`hit ${ADMIN_PATH}`, ADMIN_PATH, { level: 'info' }),
    ).toBe(`hit ${ADMIN_PATH_PLACEHOLDER}`);
  });

  it('returns input unchanged when adminPath is missing, even at info', () => {
    process.env.LOG_LEVEL = 'info';
    const input = `something with /maybe-not-the-path`;
    expect(maskAdminPath(input, null)).toBe(input);
    expect(maskAdminPath(input, undefined)).toBe(input);
    expect(maskAdminPath(input, '')).toBe(input);
  });
});

describe('maskAdminPath — JSON metadata shape', () => {
  beforeEach(() => {
    process.env.LOG_LEVEL = 'info';
  });

  it('walks plain objects and masks every string leaf', () => {
    const meta = {
      event: 'admin_path_set',
      message: `set to ${ADMIN_PATH}`,
      requestUrl: `https://lumibase.dev${ADMIN_PATH}/assets/main.js`,
      latencyMs: 42,
      flagged: false,
      target: null,
    };

    const out = maskAdminPath(meta, ADMIN_PATH);

    expect(out).toEqual({
      event: 'admin_path_set',
      message: `set to ${ADMIN_PATH_PLACEHOLDER}`,
      requestUrl: `https://lumibase.dev${ADMIN_PATH_PLACEHOLDER}/assets/main.js`,
      latencyMs: 42,
      flagged: false,
      target: null,
    });
  });

  it('recurses into nested objects and arrays', () => {
    const meta = {
      audit: {
        event: 'login_success',
        details: {
          requestPath: ADMIN_PATH,
          history: [
            `prev: ${ADMIN_PATH}`,
            { tag: 'asset', url: `${ADMIN_PATH}/main.js` },
          ],
        },
      },
    };

    const out = maskAdminPath(meta, ADMIN_PATH);

    expect(out.audit.details.requestPath).toBe(ADMIN_PATH_PLACEHOLDER);
    expect(out.audit.details.history[0]).toBe(`prev: ${ADMIN_PATH_PLACEHOLDER}`);
    expect((out.audit.details.history[1] as { url: string }).url).toBe(
      `${ADMIN_PATH_PLACEHOLDER}/main.js`,
    );
  });

  it('does not mutate the input object', () => {
    const meta = { msg: `hit ${ADMIN_PATH}`, sub: { deep: ADMIN_PATH } };
    const snapshot = JSON.parse(JSON.stringify(meta));
    maskAdminPath(meta, ADMIN_PATH);
    expect(meta).toEqual(snapshot);
  });

  it('returns primitives untouched', () => {
    expect(maskAdminPath(42, ADMIN_PATH)).toBe(42);
    expect(maskAdminPath(true, ADMIN_PATH)).toBe(true);
    expect(maskAdminPath(null, ADMIN_PATH)).toBe(null);
    // `undefined` is preserved through the type parameter contract.
    expect(maskAdminPath(undefined as unknown as string, ADMIN_PATH)).toBe(undefined);
  });
});

describe('maskAdminPath — idempotency property', () => {
  it('mask(mask(x)) === mask(x) for arbitrary string inputs', () => {
    process.env.LOG_LEVEL = 'info';
    fc.assert(
      fc.property(fc.string(), (input) => {
        const once = maskAdminPath(input, ADMIN_PATH);
        const twice = maskAdminPath(once, ADMIN_PATH);
        expect(twice).toBe(once);
      }),
      { numRuns: 200 },
    );
  });

  it('mask(mask(x)) deep-equals mask(x) for arbitrary JSON inputs', () => {
    process.env.LOG_LEVEL = 'info';
    // Build a JSON-shaped arbitrary that occasionally splices the
    // admin path into string leaves so we exercise the masking branch.
    const leafArb = fc.oneof(
      fc.constantFrom(ADMIN_PATH, `prefix ${ADMIN_PATH} suffix`, ADMIN_PATH.toUpperCase()),
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
    );
    const jsonArb = fc.letrec((tie) => ({
      json: fc.oneof(
        leafArb,
        fc.array(tie('json'), { maxLength: 4 }),
        fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), tie('json'), {
          maxKeys: 4,
        }),
      ),
    })).json;

    fc.assert(
      fc.property(jsonArb, (input) => {
        const once = maskAdminPath(input, ADMIN_PATH);
        const twice = maskAdminPath(once, ADMIN_PATH);
        expect(twice).toEqual(once);
      }),
      { numRuns: 100 },
    );
  });
});
