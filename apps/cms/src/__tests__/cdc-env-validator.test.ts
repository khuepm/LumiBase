import { describe, it, expect } from 'vitest';

import {
  validateEnvVars,
  ENV_VALIDATION_RULES,
  type EnvVarDefinition,
} from '../modules/cdc/ai-flow/env-validator';

// ── helpers ──────────────────────────────────────────────────────────────

/** A representative approach schema covering every rule type. */
function makeDefinitions(): EnvVarDefinition[] {
  return [
    { key: 'POSTGRES_URL', required: true, validation: { type: 'url', protocols: ['postgresql:', 'postgres:'] } },
    { key: 'KAFKA_BROKER', required: true, validation: { type: 'string', minLength: 1 } },
    { key: 'SYNC_INTERVAL', required: true, validation: { type: 'number', integer: true, min: 300, max: 86_400 } },
    { key: 'SYNC_MODE', required: true, validation: { type: 'enum', values: ['full_refresh', 'incremental_cdc'] } },
    { key: 'TLS_ENABLED', required: false, validation: { type: 'boolean' } },
    { key: 'TOPIC_PREFIX', required: false, validation: { type: 'string', maxLength: 8 } },
  ];
}

/** A fully-valid set of values for {@link makeDefinitions}. */
function validVars(): Record<string, string> {
  return {
    POSTGRES_URL: 'postgresql://u:p@pg:5432/app',
    KAFKA_BROKER: 'kafka:9092',
    SYNC_INTERVAL: '3600',
    SYNC_MODE: 'incremental_cdc',
    TLS_ENABLED: 'true',
    TOPIC_PREFIX: 'cdc',
  };
}

describe('validateEnvVars', () => {
  it('accepts a fully-valid set of variables', () => {
    const result = validateEnvVars(makeDefinitions(), validVars());
    expect(result.valid).toBe(true);
    expect(result.invalidFields).toEqual([]);
  });

  it('allows omitting optional variables', () => {
    const vars = validVars();
    delete vars.TLS_ENABLED;
    delete vars.TOPIC_PREFIX;
    const result = validateEnvVars(makeDefinitions(), vars);
    expect(result.valid).toBe(true);
  });

  it('reports a missing required variable as `required`', () => {
    const vars = validVars();
    delete vars.KAFKA_BROKER;
    const result = validateEnvVars(makeDefinitions(), vars);
    expect(result.valid).toBe(false);
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'KAFKA_BROKER', rule: ENV_VALIDATION_RULES.REQUIRED }),
    );
  });

  it('treats an empty string for a required variable as missing', () => {
    const result = validateEnvVars(makeDefinitions(), { ...validVars(), KAFKA_BROKER: '' });
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'KAFKA_BROKER', rule: ENV_VALIDATION_RULES.REQUIRED }),
    );
  });

  it('reports an unknown supplied key as `unknown_key`', () => {
    const result = validateEnvVars(makeDefinitions(), { ...validVars(), EXTRA_VAR: 'x' });
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'EXTRA_VAR', rule: ENV_VALIDATION_RULES.UNKNOWN_KEY }),
    );
  });

  it('reports a malformed supplied key as `key_format`', () => {
    const result = validateEnvVars(makeDefinitions(), { ...validVars(), 'bad-key': 'x' });
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'bad-key', rule: ENV_VALIDATION_RULES.KEY_FORMAT }),
    );
  });

  it('reports a malformed definition key as `key_format`', () => {
    const defs: EnvVarDefinition[] = [{ key: 'lower_case', required: true }];
    const result = validateEnvVars(defs, { lower_case: 'value' });
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'lower_case', rule: ENV_VALIDATION_RULES.KEY_FORMAT }),
    );
  });

  it('reports a bad URL value as `url` and a bad protocol as `protocol`', () => {
    const notUrl = validateEnvVars(makeDefinitions(), { ...validVars(), POSTGRES_URL: 'not a url' });
    expect(notUrl.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'POSTGRES_URL', rule: ENV_VALIDATION_RULES.URL }),
    );

    const wrongProto = validateEnvVars(makeDefinitions(), {
      ...validVars(),
      POSTGRES_URL: 'mysql://u:p@h:3306/app',
    });
    expect(wrongProto.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'POSTGRES_URL', rule: ENV_VALIDATION_RULES.PROTOCOL }),
    );
  });

  it('reports numeric `type`, `min`, and `max` violations', () => {
    const notNumber = validateEnvVars(makeDefinitions(), { ...validVars(), SYNC_INTERVAL: 'abc' });
    expect(notNumber.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'SYNC_INTERVAL', rule: ENV_VALIDATION_RULES.TYPE }),
    );

    const tooSmall = validateEnvVars(makeDefinitions(), { ...validVars(), SYNC_INTERVAL: '60' });
    expect(tooSmall.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'SYNC_INTERVAL', rule: ENV_VALIDATION_RULES.MIN }),
    );

    const tooLarge = validateEnvVars(makeDefinitions(), { ...validVars(), SYNC_INTERVAL: '999999' });
    expect(tooLarge.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'SYNC_INTERVAL', rule: ENV_VALIDATION_RULES.MAX }),
    );
  });

  it('reports a non-integer numeric value as `type`', () => {
    const result = validateEnvVars(makeDefinitions(), { ...validVars(), SYNC_INTERVAL: '300.5' });
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'SYNC_INTERVAL', rule: ENV_VALIDATION_RULES.TYPE }),
    );
  });

  it('reports an out-of-set enum value as `enum`', () => {
    const result = validateEnvVars(makeDefinitions(), { ...validVars(), SYNC_MODE: 'snapshot' });
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'SYNC_MODE', rule: ENV_VALIDATION_RULES.ENUM }),
    );
  });

  it('reports a non-boolean value as `type`', () => {
    const result = validateEnvVars(makeDefinitions(), { ...validVars(), TLS_ENABLED: 'yes' });
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'TLS_ENABLED', rule: ENV_VALIDATION_RULES.TYPE }),
    );
  });

  it('reports a too-long string as `max_length`', () => {
    const result = validateEnvVars(makeDefinitions(), { ...validVars(), TOPIC_PREFIX: 'way_too_long' });
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'TOPIC_PREFIX', rule: ENV_VALIDATION_RULES.MAX_LENGTH }),
    );
  });

  it('reports a pattern violation as `pattern`', () => {
    const defs: EnvVarDefinition[] = [
      { key: 'SLOT_NAME', required: true, validation: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' } },
    ];
    const result = validateEnvVars(defs, { SLOT_NAME: 'Bad Slot' });
    expect(result.invalidFields).toContainEqual(
      expect.objectContaining({ key: 'SLOT_NAME', rule: ENV_VALIDATION_RULES.PATTERN }),
    );
  });

  it('collects multiple violations across distinct fields', () => {
    const result = validateEnvVars(makeDefinitions(), {
      POSTGRES_URL: 'not-a-url',
      // KAFKA_BROKER missing
      SYNC_INTERVAL: '10',
      SYNC_MODE: 'nope',
      EXTRA: 'unknown',
    });
    expect(result.valid).toBe(false);
    const byKey = Object.fromEntries(result.invalidFields.map((f) => [f.key, f.rule]));
    expect(byKey.POSTGRES_URL).toBe(ENV_VALIDATION_RULES.URL);
    expect(byKey.KAFKA_BROKER).toBe(ENV_VALIDATION_RULES.REQUIRED);
    expect(byKey.SYNC_INTERVAL).toBe(ENV_VALIDATION_RULES.MIN);
    expect(byKey.SYNC_MODE).toBe(ENV_VALIDATION_RULES.ENUM);
    expect(byKey.EXTRA).toBe(ENV_VALIDATION_RULES.UNKNOWN_KEY);
  });

  it('is deterministic: schema order first, then unknown keys alphabetically', () => {
    const result = validateEnvVars(makeDefinitions(), {
      ZEBRA: 'z',
      APPLE: 'a',
      // also break a required one to anchor schema-order section
    });
    const keys = result.invalidFields.map((f) => f.key);
    // unknown keys reported in alphabetical order, after schema-defined ones
    expect(keys.indexOf('APPLE')).toBeLessThan(keys.indexOf('ZEBRA'));
  });

  it('accepts any string when a definition has no validation rule', () => {
    const defs: EnvVarDefinition[] = [{ key: 'FREEFORM', required: true }];
    const result = validateEnvVars(defs, { FREEFORM: 'anything goes !@#' });
    expect(result.valid).toBe(true);
  });
});
