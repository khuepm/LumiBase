/**
 * Environment variable validator for the AI Flow Engine (ClickHouse CDC —
 * task 11.2; design "AI Flow Engine", Requirements 7.4 & 7.5).
 *
 * When an operator submits environment variables for a CDC deployment, the
 * AI Flow Engine MUST validate those values against the schema for the
 * selected approach *before* applying any change (Req 7.4) and, on failure,
 * reject the update and return the list of invalid fields together with the
 * specific violated constraint for each (Req 7.5).
 *
 * This module owns that validation logic. It is intentionally **pure and
 * decoupled**:
 *
 *   - It performs no I/O and holds no state.
 *   - It does NOT import the config generator (task 11.1). Instead, the core
 *     {@link validateEnvVars} function accepts the approach-specific set of
 *     {@link EnvVarDefinition}s directly as a parameter. The Deployment
 *     Orchestrator / API route layer is responsible for obtaining those
 *     definitions (e.g. from `generateConfig(approach, target).variables`)
 *     and passing them in. Keeping the dependency direction this way lets the
 *     validator be unit/property tested in isolation (task 11.5, Property 18)
 *     and avoids a merge race with the concurrently-developed config
 *     generator.
 *
 * The validator reuses the shared `EnvVarSchema` key constraint
 * (`/^[A-Z_][A-Z0-9_]*$/`, see `packages/contracts/src/schemas/cdc.ts`) so the
 * notion of a "well-formed environment variable name" stays in one place.
 *
 * Validates: Requirements 7.4, 7.5
 */

import { EnvVarSchema } from '@lumibase/contracts';

// ── validation rule descriptors ────────────────────────────────────────────

/**
 * Declarative description of the constraint a single environment variable's
 * *value* must satisfy. This mirrors the "validation rule" carried by each
 * variable definition produced by the config generator (task 11.1) but is
 * defined locally here so the validator stays decoupled. The shape is
 * structural, so a richer definition exported later by the config generator
 * remains assignable as long as it provides these fields.
 *
 * The `type` field is the discriminant:
 *
 *   - `'string'` — free-form text, optionally bounded by length and/or a
 *     regular-expression `pattern`.
 *   - `'number'` — numeric value (optionally `integer`-only) within an
 *     optional `[min, max]` range.
 *   - `'boolean'` — must be exactly `'true'` or `'false'`.
 *   - `'enum'`   — must be one of the provided `values`.
 *   - `'url'`    — must parse as a URL, optionally restricted to a set of
 *     `protocols` (e.g. `['postgresql:', 'postgres:']`).
 */
export type EnvVarValidationRule =
  | {
      readonly type: 'string';
      readonly minLength?: number;
      readonly maxLength?: number;
      /** Regular-expression source the value must match in full. */
      readonly pattern?: string;
      /** Optional regex flags applied to {@link pattern}. */
      readonly patternFlags?: string;
      /** Human-readable description of {@link pattern} for error messages. */
      readonly patternDescription?: string;
    }
  | {
      readonly type: 'number';
      /** When `true`, the value must be an integer (no fractional part). */
      readonly integer?: boolean;
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly type: 'boolean' }
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | {
      readonly type: 'url';
      /** Allowed URL protocols, each including the trailing colon. */
      readonly protocols?: readonly string[];
    };

/**
 * Definition of a single environment variable expected by a CDC approach.
 *
 * This is the minimal, decoupled shape the validator needs. It is a subset of
 * the definition emitted by the config generator (task 11.1) — `key`,
 * `description`, `default`, `required`, and a `validation` rule — so the two
 * can be reconciled by structural typing once the generator exports its type.
 */
export interface EnvVarDefinition {
  /**
   * The environment variable name. Expected to match the shared
   * `EnvVarSchema` key constraint (`/^[A-Z_][A-Z0-9_]*$/`); a definition with
   * a malformed key is itself reported as a `key_format` violation.
   */
  readonly key: string;

  /** Human-readable description of the variable's purpose. */
  readonly description?: string;

  /** Default value applied when the variable is omitted, if any. */
  readonly default?: string;

  /** Whether the variable must be supplied (and non-empty). */
  readonly required: boolean;

  /** Constraint the supplied value must satisfy. Omit for "any string". */
  readonly validation?: EnvVarValidationRule;
}

// ── result types ────────────────────────────────────────────────────────────

/**
 * A single environment variable that failed validation, paired with the
 * specific constraint it violated (Req 7.5).
 */
export interface InvalidField {
  /** The offending environment variable name. */
  readonly key: string;

  /**
   * Stable identifier of the violated constraint. One of:
   * {@link ENV_VALIDATION_RULES}. Suitable for programmatic handling.
   */
  readonly rule: string;

  /** Human-readable explanation of why the value/key was rejected. */
  readonly reason: string;
}

/**
 * Outcome of {@link validateEnvVars}. `valid` is `true` iff
 * `invalidFields` is empty.
 */
export interface ValidationResult {
  /** Whether every supplied variable satisfied the approach schema. */
  readonly valid: boolean;

  /** Every detected violation, in a deterministic order. */
  readonly invalidFields: readonly InvalidField[];
}

// ── violated-rule identifiers ────────────────────────────────────────────────

/**
 * Stable identifiers for the constraints the validator can report. Exposed so
 * callers (and tests, e.g. Property 18) can assert on the violated rule
 * without hard-coding string literals.
 */
export const ENV_VALIDATION_RULES = {
  /** A required variable was missing or supplied as an empty string. */
  REQUIRED: 'required',
  /** The variable name does not match `/^[A-Z_][A-Z0-9_]*$/`. */
  KEY_FORMAT: 'key_format',
  /** A supplied variable is not part of the approach schema. */
  UNKNOWN_KEY: 'unknown_key',
  /** The value is not of the expected primitive type. */
  TYPE: 'type',
  /** The value is shorter than the minimum allowed length. */
  MIN_LENGTH: 'min_length',
  /** The value is longer than the maximum allowed length. */
  MAX_LENGTH: 'max_length',
  /** The value does not match the required pattern. */
  PATTERN: 'pattern',
  /** The numeric value is below the allowed minimum. */
  MIN: 'min',
  /** The numeric value is above the allowed maximum. */
  MAX: 'max',
  /** The value is not one of the allowed enum members. */
  ENUM: 'enum',
  /** The value is not a parseable URL. */
  URL: 'url',
  /** The URL protocol is not in the allowed set. */
  PROTOCOL: 'protocol',
} as const;

// ── key-format helper (reuses shared EnvVarSchema) ──────────────────────────

/**
 * Returns `true` if `key` is a well-formed environment variable name per the
 * shared `EnvVarSchema` key constraint. Reusing the shared schema keeps the
 * accepted key syntax in a single source of truth.
 */
function isValidKeyFormat(key: string): boolean {
  return EnvVarSchema.shape.key.safeParse(key).success;
}

// ── value validation ─────────────────────────────────────────────────────────

/**
 * Validate a single supplied `value` against a definition's `validation`
 * rule. Returns the first violated constraint, or `null` if the value
 * satisfies the rule. A definition with no `validation` accepts any string.
 */
function validateValue(
  rule: EnvVarValidationRule | undefined,
  value: string,
): { rule: string; reason: string } | null {
  if (!rule) return null;

  switch (rule.type) {
    case 'string': {
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        return {
          rule: ENV_VALIDATION_RULES.MIN_LENGTH,
          reason: `value must be at least ${rule.minLength} character(s) long`,
        };
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        return {
          rule: ENV_VALIDATION_RULES.MAX_LENGTH,
          reason: `value must be at most ${rule.maxLength} character(s) long`,
        };
      }
      if (rule.pattern !== undefined) {
        // Anchor the pattern so the whole value must match, mirroring how
        // env-var format constraints are typically expressed.
        const re = new RegExp(rule.pattern, rule.patternFlags);
        if (!re.test(value)) {
          const desc = rule.patternDescription ?? `pattern /${rule.pattern}/`;
          return {
            rule: ENV_VALIDATION_RULES.PATTERN,
            reason: `value must match ${desc}`,
          };
        }
      }
      return null;
    }

    case 'number': {
      // Reject empty/whitespace explicitly: Number('') === 0 would otherwise
      // be treated as a valid number.
      const trimmed = value.trim();
      const num = trimmed === '' ? Number.NaN : Number(trimmed);
      if (!Number.isFinite(num)) {
        return {
          rule: ENV_VALIDATION_RULES.TYPE,
          reason: 'value must be a number',
        };
      }
      if (rule.integer && !Number.isInteger(num)) {
        return {
          rule: ENV_VALIDATION_RULES.TYPE,
          reason: 'value must be an integer',
        };
      }
      if (rule.min !== undefined && num < rule.min) {
        return {
          rule: ENV_VALIDATION_RULES.MIN,
          reason: `value must be >= ${rule.min}`,
        };
      }
      if (rule.max !== undefined && num > rule.max) {
        return {
          rule: ENV_VALIDATION_RULES.MAX,
          reason: `value must be <= ${rule.max}`,
        };
      }
      return null;
    }

    case 'boolean': {
      if (value !== 'true' && value !== 'false') {
        return {
          rule: ENV_VALIDATION_RULES.TYPE,
          reason: "value must be 'true' or 'false'",
        };
      }
      return null;
    }

    case 'enum': {
      if (!rule.values.includes(value)) {
        return {
          rule: ENV_VALIDATION_RULES.ENUM,
          reason: `value must be one of: ${rule.values.join(', ')}`,
        };
      }
      return null;
    }

    case 'url': {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return {
          rule: ENV_VALIDATION_RULES.URL,
          reason: 'value must be a valid URL',
        };
      }
      if (rule.protocols !== undefined && !rule.protocols.includes(parsed.protocol)) {
        return {
          rule: ENV_VALIDATION_RULES.PROTOCOL,
          reason: `URL protocol must be one of: ${rule.protocols.join(', ')}`,
        };
      }
      return null;
    }

    /* c8 ignore next 3 -- exhaustive switch guard */
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Validate a set of supplied environment variables against the
 * approach-specific schema expressed as a list of {@link EnvVarDefinition}s.
 *
 * Every violation is reported in {@link ValidationResult.invalidFields} with
 * the specific {@link InvalidField.rule} it broke, satisfying Requirement 7.5.
 * The result is **deterministic**: schema-defined variables are checked in the
 * order they appear in `definitions`, and any unknown supplied keys are
 * reported afterwards in alphabetical order.
 *
 * Detected violations:
 *
 *   1. `required`    — a definition with `required: true` whose key is absent
 *      from `vars` or supplied as an empty string.
 *   2. `key_format`  — a definition key (and therefore the corresponding
 *      supplied key) that does not match `/^[A-Z_][A-Z0-9_]*$/`.
 *   3. value rules   — a supplied value that breaks its definition's
 *      `validation` rule (`type`, `min_length`, `max_length`, `pattern`,
 *      `min`, `max`, `enum`, `url`, `protocol`).
 *   4. `unknown_key` — a supplied key that is not part of `definitions`
 *      (reported as `key_format` instead if the key itself is malformed).
 *
 * Note on resolution order: a missing required variable is reported as
 * `required` and its (absent) value is not further validated; a malformed
 * definition key is reported as `key_format` and its value is not further
 * validated.
 *
 * @param definitions - The approach-specific variable definitions (e.g.
 *   `generateConfig(approach, target).variables`).
 * @param vars - The environment variables submitted by the operator.
 * @returns A {@link ValidationResult} listing every invalid field.
 */
export function validateEnvVars(
  definitions: readonly EnvVarDefinition[],
  vars: Record<string, string>,
): ValidationResult {
  const invalidFields: InvalidField[] = [];
  const definedKeys = new Set<string>();

  // Pass 1 — check each schema-defined variable in declaration order.
  for (const def of definitions) {
    definedKeys.add(def.key);

    // A malformed definition key is itself a violation; skip value checks
    // since the key is unusable.
    if (!isValidKeyFormat(def.key)) {
      invalidFields.push({
        key: def.key,
        rule: ENV_VALIDATION_RULES.KEY_FORMAT,
        reason: 'environment variable name must match /^[A-Z_][A-Z0-9_]*$/',
      });
      continue;
    }

    const present = Object.prototype.hasOwnProperty.call(vars, def.key);
    const value = present ? vars[def.key] : undefined;
    const isEmpty = value === undefined || value === '';

    if (isEmpty) {
      if (def.required) {
        invalidFields.push({
          key: def.key,
          rule: ENV_VALIDATION_RULES.REQUIRED,
          reason: 'required environment variable is missing or empty',
        });
      }
      // Optional + absent → nothing to validate (default would be applied
      // elsewhere by the config generator).
      continue;
    }

    const violation = validateValue(def.validation, value);
    if (violation) {
      invalidFields.push({
        key: def.key,
        rule: violation.rule,
        reason: violation.reason,
      });
    }
  }

  // Pass 2 — report supplied keys that are not part of the schema, in a
  // deterministic (alphabetical) order.
  const unknownKeys = Object.keys(vars)
    .filter((key) => !definedKeys.has(key))
    .sort();

  for (const key of unknownKeys) {
    if (!isValidKeyFormat(key)) {
      invalidFields.push({
        key,
        rule: ENV_VALIDATION_RULES.KEY_FORMAT,
        reason: 'environment variable name must match /^[A-Z_][A-Z0-9_]*$/',
      });
    } else {
      invalidFields.push({
        key,
        rule: ENV_VALIDATION_RULES.UNKNOWN_KEY,
        reason: 'environment variable is not defined for the selected approach',
      });
    }
  }

  return {
    valid: invalidFields.length === 0,
    invalidFields,
  };
}
