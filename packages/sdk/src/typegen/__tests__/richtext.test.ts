import { describe, expect, it } from "vitest";
import ts from "typescript";
import { generateTypes, generateZod, generateOpenApi, generateGraphQLSdl, type TypegenManifest } from "../index";
import { RICHTEXT_TS_DECLARATIONS } from "../richtext";

const manifest: TypegenManifest = {
  version: 2,
  site: "s",
  collections: [
    {
      name: "posts",
      primaryKey: "id",
      fields: [
        { name: "body", type: "richtext", required: true, nullable: false, system: false, readonly: false, generated: false, encrypted: false },
        { name: "summary", type: "richtext", required: false, nullable: true, system: false, readonly: false, generated: false, encrypted: false },
      ],
    },
  ],
} as TypegenManifest;

describe("typegen — richtext (#695)", () => {
  it("emits the document type once and types the fields with it", () => {
    const out = generateTypes(manifest);
    expect(out.match(/export interface RichTextDocument/g)).toHaveLength(1);
    expect(out).toContain("body: RichTextDocument;");
    expect(out).toContain("summary?: RichTextDocument | null;");
  });

  it("does not emit the document type when no field needs it", () => {
    expect(generateTypes({ ...manifest, collections: [] })).not.toContain("RichTextDocument");
  });

  it("covers the zod, OpenAPI and GraphQL targets", () => {
    expect(generateZod(manifest)).toContain("z.literal('doc')");
    expect(JSON.stringify(generateOpenApi(manifest))).toContain('"enum":["doc"]');
    const sdl = generateGraphQLSdl(manifest);
    expect(sdl).toContain("body: RichText");
    expect(sdl).toContain("type RichText {");
  });

  it("emitted declarations match the contracts model in both directions", () => {
    // Virtual file next to the package, so `@lumibase/contracts` resolves from its node_modules.
    const file = `${ts.sys.getCurrentDirectory()}/__richtext_parity__.ts`;
    const source = `${RICHTEXT_TS_DECLARATIONS}
import type { RichTextDocument as Contract } from "@lumibase/contracts/richtext";
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const parity: Same<RichTextDocument, Contract> = true;
`;
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang, ...rest) =>
      name === file ? ts.createSourceFile(name, source, lang) : getSourceFile(name, lang, ...rest);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (name) => name === file || fileExists(name);
    const program = ts.createProgram([file], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  }, 30_000);
});
