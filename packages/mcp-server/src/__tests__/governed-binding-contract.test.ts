import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { GOVERNED_TOOLS, toSkillArgs } from '../governed.js';
import { registerAllTools } from '../tools/index.js';

/**
 * Every governed binding must be able to carry what its tool advertises.
 *
 * Why this exists. The 27-tool governed set was originally selected by running a
 * one-off script that compared each tool's advertised properties against the
 * canonical contract, and then **hand-editing** the result. `delete_field` came
 * back flagged (`extra=[fieldName, force]`); the `field_name → name` half was
 * handled by an explicit rename and the `force` half was simply missed, so the
 * tool shipped in the governed set while `force: true` — a flag it still
 * advertises — was rejected with `VALIDATION` the moment MCP was enabled.
 *
 * A one-off measurement cannot catch that, because nothing re-runs it. This does:
 * the comparison is recomputed from the registry on every test run, so a binding
 * whose tool advertises something the contract cannot accept fails here instead
 * of failing a user.
 *
 * `packages/mcp-server` does not depend on `@lumibase/contracts` (it is published
 * with only the MCP SDK and zod), so the contract arrives as a committed
 * fixture. The other half of the loop —proving the fixture still matches the live
 * Zod— lives in `apps/cms/src/services/__tests__/g2-agent-tool-schemas.test.ts`,
 * which can import both. Neither half is sufficient alone.
 */

interface CanonicalEntry {
  properties: string[];
  required: string[];
}

const canonical = JSON.parse(
  readFileSync(join(import.meta.dirname, 'canonical-agent-tool-schemas.json'), 'utf8'),
) as Record<string, CanonicalEntry>;

/** Advertised input shape of every registered tool. */
function advertisedShapes(): Map<string, Record<string, z.ZodType>> {
  const shapes = new Map<string, Record<string, z.ZodType>>();
  registerAllTools(
    {
      registerTool: (name: string, config: { inputSchema?: Record<string, z.ZodType> }) =>
        shapes.set(name, config.inputSchema ?? {}),
    } as never,
    {} as never,
    { dispatcher: null },
  );
  return shapes;
}

const SHAPES = advertisedShapes();

describe('governed binding contract', () => {
  it('every governed tool exists in the registry', () => {
    const missing = Object.keys(GOVERNED_TOOLS).filter((name) => !SHAPES.has(name));
    expect(missing).toEqual([]);
  });

  it('every advertised argument survives translation into the canonical contract', () => {
    const offences: string[] = [];

    for (const [tool, binding] of Object.entries(GOVERNED_TOOLS)) {
      const shape = SHAPES.get(tool);
      if (!shape) continue;
      const contract = canonical[binding.skill];
      if (!contract) {
        offences.push(`${tool} → ${binding.skill}: no canonical contract`);
        continue;
      }

      // Feed a value for every advertised key through the real translation, so
      // renames and prompt-only drops are applied exactly as at runtime.
      const probe: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) probe[key] = 'probe';
      const translated = Object.keys(toSkillArgs(probe, binding));

      const extra = translated.filter((key) => !contract.properties.includes(key));
      if (extra.length > 0) {
        offences.push(`${tool} → ${binding.skill}: advertises ${extra.join(', ')} — not in contract`);
      }

      const unreachable = contract.required.filter((key) => !translated.includes(key));
      if (unreachable.length > 0) {
        offences.push(
          `${tool} → ${binding.skill}: required ${unreachable.join(', ')} unreachable from advertised args`,
        );
      }
    }

    expect(offences).toEqual([]);
  });

  it('`delete_field` can still pass `force`, in both truthy and falsy form', () => {
    // The specific regression. `force` is advertised by the tool and honoured by
    // `SchemaService.deleteField`, so the governed path must carry it rather than
    // reject the call or silently drop a destructive-behaviour flag.
    const binding = GOVERNED_TOOLS['delete_field']!;
    expect(canonical[binding.skill]!.properties).toContain('force');

    expect(toSkillArgs({ collection: 'posts', field_name: 'title', confirm: true, force: true }, binding)).toEqual({
      collection: 'posts',
      name: 'title',
      force: true,
    });
    expect(toSkillArgs({ collection: 'posts', field_name: 'title', confirm: true, force: false }, binding)).toEqual({
      collection: 'posts',
      name: 'title',
      force: false,
    });
    // `confirm` is an operator prompt, never a skill argument.
    expect(toSkillArgs({ collection: 'posts', field_name: 'title', confirm: true }, binding)).toEqual({
      collection: 'posts',
      name: 'title',
    });
  });
});
