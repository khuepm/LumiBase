import {
  CdcReplaySchema,
  CdcSubscriptionCreateSchema,
  CdcSubscriptionPatchSchema,
} from '@lumibase/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { attachPolicy as apiKeyAttachPolicy, attachRole as apiKeyAttachRole } from '../../routes/api-keys';
import {
  collectionInputSchema,
  collectionPatchSchema,
  fieldInputSchema,
  schemaInputSchema,
} from '../../routes/collections';
import { decideSchema, submitSchema } from '../../routes/editorial';
import { flowPatchSchema } from '../../routes/flows';
import { intentPatchSchema } from '../../routes/intents';
import { publishSchema } from '../../routes/marketplace';
import { registerSchema } from '../../routes/materialize';
import { attachUser, permissionPatch, permissionUpsert, policyCreate, policyPatch } from '../../routes/policies';
import { presetPatchSchema, presetSchema } from '../../routes/presets';
import { createSchema as releaseCreate, patchSchema as releasePatch } from '../../routes/releases';
import { assignUser, attachPolicy as roleAttachPolicy, roleCreate, rolePatch } from '../../routes/roles';
import { createShareSchema } from '../../routes/shares';
import { teamPatchSchema } from '../../routes/teams';
import {
  patchSchema as tmPatch,
  translateSchema,
  upsertSchema as tmUpsert,
} from '../../routes/translation-memory';
import { patchBodyOf } from '../../utils/patch-schema';

/**
 * Golden REST request-body schemas for the MCP tool-schema fidelity suite (#716).
 *
 * The stdio MCP server (`packages/mcp-server`) forwards most mutation tools
 * straight to these routes, but it cannot import `apps/cms`, so it could not
 * compare what a tool advertises with what the route accepts — which is how
 * `apply_schema` advertised 12 fewer field keys than REST and
 * `update_cdc_subscription` advertised keys the PATCH ignores while missing
 * `status`. This test publishes the body each route really validates, as JSON
 * Schema, to `packages/mcp-server/src/__tests__/fidelity/golden/rest-body-schemas.json`;
 * the mcp-server half (`tool-schema-fidelity.test.ts`) compares every
 * ungoverned mutation tool with its entry.
 *
 * Each entry is the exact Zod object the route's handler parses with (exported
 * from the route module, or `@lumibase/contracts` for the change feed), not a
 * copy. `patchSchema()` results are unwrapped with `patchBodyOf()` to the
 * `.partial()` object they validate with. Keys the handler takes from the URL
 * rather than the body (`PUT …/fields/:field` injects `name`) are listed in
 * `fromPath` and dropped from the published body.
 *
 * Conversion is `z.toJSONSchema(…, { io: 'input' })`: a key with a `.default()`
 * is optional for the caller, which is what an MCP client needs. Refinements,
 * transforms and coercions are not representable; the mcp-server half says so
 * where it relies on this file.
 *
 * An intended change: `pnpm -F @lumibase/cms exec vitest run
 * src/services/__tests__/mcp-rest-body-golden.test.ts -u`, then review the diff.
 * CI never writes it (`CI=true` makes a mismatch or a missing file fail).
 */

const GOLDEN = '../../../../../packages/mcp-server/src/__tests__/fidelity/golden/rest-body-schemas.json';

interface Body {
  schema: z.ZodType;
  /** Keys the handler fills from the URL, not the body. */
  fromPath?: string[];
}

/** Route (`METHOD /path` under `/api/v1`) → the body its handler parses. */
const BODIES: Record<string, Body> = {
  'POST /collections': { schema: collectionInputSchema },
  'PATCH /collections/:name': { schema: collectionPatchSchema },
  'PUT /collections/:name/fields/:field': { schema: fieldInputSchema, fromPath: ['name'] },
  'POST /collections/diff': { schema: schemaInputSchema },
  'PUT /collections/:name/schema': { schema: schemaInputSchema },

  'POST /roles': { schema: roleCreate },
  'PATCH /roles/:id': { schema: rolePatch },
  'POST /roles/:id/policies': { schema: roleAttachPolicy },
  'POST /roles/:id/users': { schema: assignUser },

  'POST /policies': { schema: policyCreate },
  'PATCH /policies/:id': { schema: policyPatch },
  'POST /policies/:id/permissions': { schema: permissionUpsert },
  'PATCH /policies/:id/permissions/:permId': { schema: permissionPatch },
  'POST /policies/:id/users': { schema: attachUser },

  'POST /api-keys/:id/roles': { schema: apiKeyAttachRole },
  'POST /api-keys/:id/policies': { schema: apiKeyAttachPolicy },

  'POST /cdc/subscriptions': { schema: CdcSubscriptionCreateSchema },
  'PATCH /cdc/subscriptions/:id': { schema: CdcSubscriptionPatchSchema },
  'POST /cdc/subscriptions/:id/replay': { schema: CdcReplaySchema },

  'POST /presets': { schema: presetSchema },
  'PATCH /presets/:id': { schema: presetPatchSchema },

  'POST /releases': { schema: releaseCreate },
  'PATCH /releases/:id': { schema: releasePatch },

  'POST /shares': { schema: createShareSchema },
  'POST /marketplace/publish': { schema: publishSchema },
  'POST /materialize': { schema: registerSchema },

  'POST /editorial/:collection/:id/submit-review': { schema: submitSchema },
  'POST /editorial/:collection/:id/approve': { schema: decideSchema },
  'POST /editorial/:collection/:id/reject': { schema: decideSchema },

  'POST /tm': { schema: tmUpsert },
  'PATCH /tm/:id': { schema: tmPatch },
  'POST /tm/translate': { schema: translateSchema },

  'PATCH /flows/:id': { schema: flowPatchSchema },
  'PATCH /agent/intents/:id': { schema: intentPatchSchema },
  'PATCH /teams/:id': { schema: teamPatchSchema },
};

type Json = Record<string, unknown>;

function bodySchema({ schema, fromPath = [] }: Body): Json {
  const json = z.toJSONSchema(patchBodyOf(schema) ?? schema, {
    io: 'input',
    unrepresentable: 'any',
    target: 'draft-2020-12',
  }) as Json;
  delete json['$schema'];
  const properties = { ...(json['properties'] as Json | undefined) };
  for (const key of fromPath) delete properties[key];
  const required = ((json['required'] as string[] | undefined) ?? []).filter((k) => !fromPath.includes(k));
  return { ...json, properties, ...(required.length > 0 ? { required } : { required: undefined }) };
}

describe('REST request-body golden for the MCP fidelity suite', () => {
  it('every route body the stdio tools post to matches the committed golden', async () => {
    const golden: Record<string, Json> = {};
    for (const [route, body] of Object.entries(BODIES)) {
      const schema = bodySchema(body);
      expect(schema['type'], `${route} is not an object body`).toBe('object');
      expect(Object.keys(schema['properties'] as Json).length, `${route} has no keys`).toBeGreaterThan(0);
      golden[route] = JSON.parse(JSON.stringify(schema)) as Json;
    }
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(GOLDEN);
  });

  it('patchBodyOf unwraps every PATCH body (a wrapped one would publish as `{}`)', () => {
    for (const schema of [collectionPatchSchema, schemaInputSchema, rolePatch, policyPatch, permissionPatch, presetPatchSchema, flowPatchSchema, intentPatchSchema, teamPatchSchema]) {
      expect(patchBodyOf(schema)).toBeDefined();
    }
  });
});
