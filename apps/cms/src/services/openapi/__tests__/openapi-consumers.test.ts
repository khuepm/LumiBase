/**
 * #745 acceptance: "typegen and SDK consumers can use it".
 *
 * 1. `openapi-typescript` (the de-facto OpenAPI → TS generator) turns the
 *    live document into types, and a consumer snippet type-checks against
 *    them — including a deliberate mistake that must NOT type-check.
 * 2. For every scalar field type, the OpenAPI-derived TS type equals the type
 *    `lumibase typegen` (`@lumibase/sdk` `generateTypes`) emits, so the two
 *    generators never disagree about the same field.
 */
import { describe, expect, it } from 'vitest';
import openapiTS, { astToString } from 'openapi-typescript';
import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { generateTypes } from '@lumibase/sdk';
import { resolveAccessView } from '../openapi-access';
import { generateOpenApiDocument } from '../openapi-generator';
import { FIELD_TYPE_JSON_SCHEMA } from '../field-schema';
import type { TypegenManifest } from '../../typegen-service';
import { ADMIN_BUNDLE, collection, field, matrixManifest, validateOpenApi } from './fixtures';

type OpenApiTsInput = Parameters<typeof openapiTS>[0];

async function toTypescript(manifest: TypegenManifest): Promise<string> {
  const document = generateOpenApiDocument({
    manifest,
    access: resolveAccessView(ADMIN_BUNDLE, manifest, 'studio'),
    realm: 'studio',
    siteId: 'site-a',
    schemaVersion: 1,
  });
  return astToString(await openapiTS(document as unknown as OpenApiTsInput));
}

/** Type-check `files` (written to a scratch dir); returns `file:line message` diagnostics. */
function typecheck(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'lumibase-openapi-'));
  try {
    const paths = Object.entries(files).map(([name, text]) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    });
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    };
    const program = ts.createProgram(paths, options);
    return ts.getPreEmitDiagnostics(program).map((d) => {
      const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
      return `${d.file ? basename(d.file.fileName) : '?'}:${line} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('openapi-typescript consumes the live document', () => {
  it('generates types a client can program against', async () => {
    const generated = await toTypescript(matrixManifest());
    expect(generated).toContain('"posts.Fields"');
    expect(generated).toContain('"/items/posts/{id}"');

    const consumer = `
      import type { components, paths } from './api';
      type Post = components['schemas']['posts.Fields'];
      type ListPosts = paths['/items/posts']['get']['responses'][200]['content']['application/json'];

      const ok: Post = { title: 'Hello', views: 3, featured: true, headline: { en: 'Hi', vi: 'Chào' }, meta: { any: 1 } };
      const list: ListPosts = { data: [], meta: { limit: 25, offset: 0 } };
      // @ts-expect-error — \`views\` is an integer field
      const wrongType: Post = { title: 'x', views: 'three' };
      // @ts-expect-error — \`title\` is required
      const missing: Post = { views: 1 };
      export { ok, list, wrongType, missing };
    `;
    const diagnostics = typecheck({ 'api.ts': generated, 'consumer.ts': consumer });
    expect(diagnostics).toEqual([]);
  });

  it('agrees with `lumibase typegen` on every scalar field type', async () => {
    const scalarTypes = Object.keys(FIELD_TYPE_JSON_SCHEMA);
    const manifest: TypegenManifest = {
      version: 2,
      site: 'site-a',
      collections: [
        collection(
          'probe',
          scalarTypes.map((type) => field(`f_${type}`, type, { required: true, nullable: false })),
        ),
      ],
    };
    const probeDocument = generateOpenApiDocument({
      manifest,
      access: resolveAccessView(ADMIN_BUNDLE, manifest, 'studio'),
      realm: 'studio',
      siteId: 'site-a',
      schemaVersion: 1,
    });
    expect((await validateOpenApi(probeDocument)).valid).toBe(true);

    const fromOpenApi = await toTypescript(manifest);
    const fromTypegen = generateTypes(manifest, { branded: false });

    // The SDK output imports `ID` and references the ambient `GeoJSON` namespace;
    // declare both (ID = string, as in the SDK; Geometry as an open object) so the
    // file compiles standalone.
    const prelude = `type ID = string; declare namespace GeoJSON { type Geometry = { [key: string]: unknown } }`;
    const checks = scalarTypes
      .map(
        (type) => `
        type A_${type} = components['schemas']['probe.Fields']['f_${type}'];
        type B_${type} = Probe['f_${type}'];
        const _${type}: [Equal<A_${type}, B_${type}>] = [true];`,
      )
      .join('\n');
    const source = `
      ${prelude}
      import type { components } from './openapi';
      type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
      ${fromTypegen.replace(/^import .*$/gm, '')}
      ${checks}
      export {};
    `;
    const diagnostics = typecheck({ 'openapi.ts': fromOpenApi, 'agree.ts': source });
    expect(diagnostics).toEqual([]);
  });
});
