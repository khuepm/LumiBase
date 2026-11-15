import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  ExternalActionToolError,
  ExternalActionToolRegistry,
  governanceFor,
  redactedSecretMarker,
  scrubSecrets,
  validateExternalActionInput,
  validateExternalActionTool,
  type ExternalActionToolDefinition,
} from '../external-action-tools';
import { externalActionInputHash } from '../external-action-audit';
import { createHttpEchoTool } from '../external-action-reference-tool';
import { approvalDeciderFromAuth } from '../governed-capabilities';
import { AISecureHarness, CORE_SKILLS, skillCatalog } from '../ai-harness';
import { ToolRegistryService } from '../tool-registry-service';
import { toolAnnotations } from '../mcp-service';
import { resolveAutonomy } from '../autonomy-service';
import type { AuthPrincipal } from '../../env';
import type { Database } from '@lumibase/database';

const noFetch = async () => ({ ok: true, status: 200, text: async () => '' });

function tool(overrides: Partial<ExternalActionToolDefinition> = {}): ExternalActionToolDefinition {
  return { ...createHttpEchoTool({ endpoint: 'https://echo.invalid', fetch: noFetch }), ...overrides };
}

describe('external-action tool declaration', () => {
  it('accepts the reference tool', () => {
    expect(() => validateExternalActionTool(tool())).not.toThrow();
  });

  it.each([
    ['a name that is not an identifier', { name: 'http echo' }],
    ['a capability without a namespace', { capability: 'send' }],
    ['the wildcard capability', { capability: '*' }],
    ['an unknown risk', { risk: 'critical' as never }],
    ['an unknown reversibility', { reversibility: 'maybe' as never }],
    ['a bounded radius without a bound', { blastRadius: { scope: 'bounded', maxAffected: 0 } }],
    ['a read_only tool that claims an audience', { reversibility: 'read_only', blastRadius: { scope: 'single' } }],
    ['an effect that claims to reach nobody', { blastRadius: { scope: 'none' } }],
    ['a broad radius declared below high risk', { risk: 'medium', blastRadius: { scope: 'broad' } }],
    ['a secret name that is not a reference', { secrets: ['sk_live_value'] }],
    ['a repeated secret name', { secrets: ['A_TOKEN', 'A_TOKEN'] }],
    ['a schema that is not an object schema', { inputSchema: { type: 'string' } }],
    ['a missing handler', { handler: undefined as never }],
  ] as Array<[string, Partial<ExternalActionToolDefinition>]>)('refuses %s', (_label, overrides) => {
    expect(() => validateExternalActionTool(tool(overrides))).toThrow(ExternalActionToolError);
  });

  it('a registry refuses duplicates and keeps a frozen copy', () => {
    const registry = new ExternalActionToolRegistry();
    const definition = tool();
    registry.register(definition);
    expect(() => registry.register(tool())).toThrow(/already registered/);
    definition.risk = 'low';
    (definition.secrets as string[]).push('LATER_ADDED');
    expect(registry.get('httpEcho')!.secrets).toEqual(['HTTP_ECHO_TOKEN']);
    expect(Object.isFrozen(registry.get('httpEcho'))).toBe(true);
    expect(registry.unregister('httpEcho')).toBe(true);
    expect(registry.size).toBe(0);
  });
});

describe('governanceFor', () => {
  it('follows the declared table', () => {
    expect(governanceFor({ risk: 'high', reversibility: 'read_only' })).toEqual({
      effectful: false, alwaysRequiresApproval: false, minAutonomousLevel: null,
    });
    for (const risk of ['low', 'medium', 'high'] as const) {
      expect(governanceFor({ risk, reversibility: 'irreversible' }).alwaysRequiresApproval).toBe(true);
    }
    expect(governanceFor({ risk: 'high', reversibility: 'reversible' }).alwaysRequiresApproval).toBe(true);
    expect(governanceFor({ risk: 'medium', reversibility: 'reversible' }).minAutonomousLevel).toBe(4);
    expect(governanceFor({ risk: 'low', reversibility: 'reversible' }).minAutonomousLevel).toBe(2);
  });

  it('a tool that always requires approval names no autonomous level', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('low', 'medium', 'high'),
        fc.constantFrom('read_only', 'reversible', 'irreversible'),
        (risk, reversibility) => {
          const governance = governanceFor({ risk, reversibility } as never);
          if (governance.alwaysRequiresApproval) expect(governance.minAutonomousLevel).toBeNull();
          if (risk === 'high' && reversibility !== 'read_only') expect(governance.alwaysRequiresApproval).toBe(true);
          if (reversibility === 'irreversible') expect(governance.alwaysRequiresApproval).toBe(true);
        },
      ),
    );
  });
});

describe('validateExternalActionInput', () => {
  const schema = {
    type: 'object',
    properties: {
      message: { type: 'string', maxLength: 5 },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['message'],
  };

  it('accepts declared arguments', () => {
    expect(validateExternalActionInput(schema, { message: 'hi', count: 2, mode: 'a' })).toBeNull();
  });

  it.each([
    [{}, 'message: is required'],
    [{ message: 1 }, 'message: must be of type string'],
    [{ message: 'too long' }, 'message: must be at most 5 characters'],
    [{ message: 'hi', count: 1.5 }, 'count: must be of type integer'],
    [{ message: 'hi', count: 9 }, 'count: must be <= 3'],
    [{ message: 'hi', mode: 'c' }, 'mode: must be one of a, b'],
    [{ message: 'hi', other: true }, 'other: is not a declared argument'],
    [{ message: 'hi', constructor: 1 }, 'constructor: is not a declared argument'],
  ] as Array<[Record<string, unknown>, string]>)('refuses %j', (args, message) => {
    expect(validateExternalActionInput(schema, args)).toBe(message);
  });

  it('is open only when the schema says so', () => {
    expect(validateExternalActionInput({ ...schema, additionalProperties: true }, { message: 'hi', other: 1 })).toBeNull();
  });
});

describe('scrubSecrets', () => {
  const secretArb = fc
    .string({ minLength: 8, maxLength: 40 })
    // Printable, and not a fragment of the marker the test then looks for.
    .filter((value) => /^[\x21-\x7e]+$/.test(value) && !redactedSecretMarker('A_TOKEN').includes(value));

  it('removes a secret from any position of any structure, raw or encoded', () => {
    fc.assert(
      fc.property(secretArb, fc.string(), fc.string(), (secret, before, after) => {
        const secrets = new Map([['A_TOKEN', secret]]);
        const base64 = Buffer.from(secret).toString('base64');
        const scrubbed = JSON.stringify(
          scrubSecrets(
            {
              text: `${before}${secret}${after}`,
              list: [secret, { deep: `x${base64}y` }],
              url: `https://h/?t=${encodeURIComponent(secret)}`,
              [`k${secret}`]: 1,
            },
            secrets,
          ),
        );
        expect(scrubbed).not.toContain(JSON.stringify(secret).slice(1, -1));
        expect(scrubbed).not.toContain(base64);
        expect(scrubbed).toContain(redactedSecretMarker('A_TOKEN'));
      }),
      { numRuns: 200 },
    );
  });

  it('leaves values without a secret untouched and keeps non-strings', () => {
    const value = { a: 1, b: [true, null, 'plain'], c: { d: 'text' } };
    expect(scrubSecrets(value, new Map([['A_TOKEN', 'not-present-anywhere']]))).toEqual(value);
    expect(scrubSecrets(value, new Map())).toBe(value);
  });

  it('replaces the longer of two overlapping secrets whole', () => {
    const secrets = new Map([['SHORT', 'abcdefgh'], ['LONG', 'abcdefgh-and-more']]);
    expect(scrubSecrets('x abcdefgh-and-more y', secrets)).toBe('x [secret:LONG] y');
  });
});

describe('externalActionInputHash', () => {
  it('ignores key order and distinguishes values', async () => {
    const a = await externalActionInputHash({ x: 1, y: { b: 2, a: [1, 2] } });
    const b = await externalActionInputHash({ y: { a: [1, 2], b: 2 }, x: 1 });
    const c = await externalActionInputHash({ x: 2, y: { b: 2, a: [1, 2] } });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('approvalDeciderFromAuth', () => {
  const base: AuthPrincipal = { userId: 'usr_1', raw: {} };

  it('recognises a signed-in user', () => {
    expect(approvalDeciderFromAuth(base)).toEqual({ kind: 'human', userId: 'usr_1' });
  });

  it.each([
    ['no principal', undefined],
    ['an API key', { type: 'api_key', apiKeyId: 'key_1', raw: {} }],
    ['an API key that also names a user', { ...base, apiKeyId: 'key_1' }],
    ['API key metadata without an id', { ...base, apiKey: { scope: 'site' } }],
    ['an organization key', { ...base, apiKey: { scope: 'organization' } }],
    ['an OAuth connector token', { ...base, oauth: { issuer: 'i', resource: 'r', scopes: [] } }],
    ['a frontend end-user', { ...base, isFrontendUser: true }],
    ['a frontend-audience token', { ...base, raw: { aud: 'frontend' } }],
    ['an anonymous principal', { type: 'anonymous', roleId: 'public', raw: {} }],
    ['a dev principal without a user', { roles: ['admin'], raw: { dev: true } }],
  ] as Array<[string, AuthPrincipal | undefined]>)('does not treat %s as human', (_label, auth) => {
    expect(approvalDeciderFromAuth(auth).kind).not.toBe('human');
  });
});

describe('registry projection', () => {
  const registry = () => {
    const instance = new ExternalActionToolRegistry();
    instance.register(tool({ risk: 'high' }));
    instance.register(tool({ name: 'echoRead', reversibility: 'read_only', blastRadius: { scope: 'none' }, capability: 'echo:read' }));
    return instance;
  };

  it('the listing catalog is the core object itself when nothing is registered', () => {
    expect(skillCatalog(new ExternalActionToolRegistry())).toBe(CORE_SKILLS);
  });

  it('lists external tools with their declaration, and catalog handlers refuse to run', async () => {
    const catalog = skillCatalog(registry());
    expect(catalog['httpEcho']).toMatchObject({
      requiredCapabilities: ['echo:send'],
      service: 'external',
      dangerous: true,
      external: { risk: 'high', reversibility: 'reversible', secrets: ['HTTP_ECHO_TOKEN'] },
    });
    await expect(catalog['httpEcho']!.handler({ message: 'x' })).rejects.toThrow(/EXTERNAL_TOOL_UNGOVERNED/);

    const service = new ToolRegistryService({} as Database, 'site_a', catalog);
    const effectful = service.coreTool('httpEcho', catalog['httpEcho']!);
    const readOnly = service.coreTool('echoRead', catalog['echoRead']!);
    expect(effectful.riskPolicy).toEqual({ level: 'dangerous', approvalPolicy: 'before_execute' });
    expect(toolAnnotations(effectful)).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(toolAnnotations(readOnly)).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it('a registration cannot replace a core skill', () => {
    const shadowing = new ExternalActionToolRegistry();
    shadowing.register(tool({ name: 'deleteCollection' }));
    const catalog = skillCatalog(shadowing);
    expect(catalog['deleteCollection']).toBe(CORE_SKILLS['deleteCollection']);
    const harness = new AISecureHarness({ db: {} as Database, siteId: 'site_a', externalTools: shadowing });
    expect(harness.validateSkill('deleteCollection')!.external).toBeUndefined();
  });

  it('an external effect is never autonomous without a grant', () => {
    // The harness resolves every effectful external tool as `dangerous`, whose
    // no-grant default is L1 (propose).
    expect(resolveAutonomy({ grantLevel: null, dangerous: true })).toBe(1);
  });
});
