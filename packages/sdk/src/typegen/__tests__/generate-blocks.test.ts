import { describe, expect, it } from "vitest";
import ts from "typescript";

import { generateTypes } from "../index";
import type { TypegenField, TypegenManifest } from "../types";

/** Dynamic zones (#748): `blocks` fields generate a discriminated union on `type`. */

const sys = (name: string, extra: Partial<TypegenField> = {}): TypegenField => ({
  name,
  type: name === "id" ? "uuid" : "datetime",
  required: true,
  nullable: false,
  system: true,
  readonly: true,
  generated: true,
  primaryKey: name === "id",
  ...extra,
});

const manifest: TypegenManifest = {
  version: 2,
  site: "site_1",
  collections: [
    {
      name: "cta",
      primaryKey: "id",
      primaryKeyType: "nanoid",
      fields: [
        sys("id"),
        sys("created_at"),
        { name: "label", type: "string", required: true, nullable: false },
        { name: "url", type: "string", required: false, nullable: true },
      ],
    },
    {
      name: "hero",
      primaryKey: "id",
      primaryKeyType: "nanoid",
      fields: [
        sys("id"),
        { name: "title", type: "string", required: true, nullable: false },
        { name: "height", type: "integer", required: false, nullable: true },
        { name: "items", type: "blocks", required: false, nullable: true, allowedBlocks: ["cta"] },
      ],
    },
    {
      name: "pages",
      primaryKey: "id",
      primaryKeyType: "nanoid",
      fields: [
        sys("id"),
        { name: "title", type: "string", required: true, nullable: false },
        {
          name: "sections",
          type: "blocks",
          required: true,
          nullable: false,
          // `ghost` is not in the manifest (excluded / deleted) → loose member.
          allowedBlocks: ["hero", "cta", "ghost"],
        },
        { name: "aside", type: "blocks", required: false, nullable: true, allowedBlocks: [] },
      ],
    },
  ],
};

const STUB = `type ID = string;
type Locale = string;
type Brand<TBrand extends string, TValue> = TValue & { readonly __brand: TBrand };
`;

/**
 * Type-check generated code + a usage snippet as ONE in-memory module (the
 * helper-type import is replaced by the stub), so no filesystem or module
 * resolution is involved. Returns diagnostics as strings.
 */
function typecheck(generated: string, usage: string): string[] {
  const fileName = "/virtual/check.ts";
  const text = [STUB, generated.replace(/^import type .*$/gm, ""), usage].join("\n");
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    noLib: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, lang) =>
    name === fileName ? ts.createSourceFile(name, text, lang) : name === "/virtual/lib.d.ts" ? ts.createSourceFile(name, LIB, lang) : undefined;
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? text : undefined);
  host.getDefaultLibFileName = () => "/virtual/lib.d.ts";
  const program = ts.createProgram({ rootNames: [fileName, "/virtual/lib.d.ts"], options, host });
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

/** Just enough of lib.d.ts for the generated types and the usage snippet. */
const LIB = `interface Array<T> { length: number; [n: number]: T; map<U>(cb: (v: T) => U): U[]; join(sep?: string): string; }
interface ReadonlyArray<T> { length: number; readonly [n: number]: T; }
interface String { length: number; } interface Number {} interface Boolean {} interface Object {}
interface Function {} interface CallableFunction {} interface NewableFunction {} interface IArguments {} interface RegExp {}
interface SymbolConstructor { readonly iterator: unique symbol } declare var Symbol: SymbolConstructor;
interface IterableIterator<T> {}
declare function String(v?: unknown): string;
type Record<K extends keyof any, T> = { [P in K]: T };
`;

describe("generateTypes — blocks", () => {
  const out = generateTypes(manifest, { importSource: "./stub" });

  it("emits <Template>BlockData (user fields only) and <Template>Block per referenced template", () => {
    expect(out).toContain(`export interface CtaBlockData {
  label: string;
  url?: string | null;
}`);
    expect(out).toContain(`export interface CtaBlock {
  id: string;
  type: "cta";
  data: CtaBlockData;
}`);
    expect(out).toContain(`export interface HeroBlockData {
  title: string;
  height?: number | null;
  items?: Array<CtaBlock> | null;
}`);
    // Templates are emitted once, sorted, and only when referenced.
    expect(out.match(/export interface HeroBlock \{/g)).toHaveLength(1);
    expect(out).not.toContain("PagesBlock");
  });

  it("types the field as an array of the discriminated union", () => {
    expect(out).toContain(
      `  sections: Array<HeroBlock | CtaBlock | { id: string; type: "ghost"; data: Record<string, unknown> }>;`,
    );
    expect(out).toContain(`  aside?: Array<{ id: string; type: string; data: Record<string, unknown> }> | null;`);
  });

  it("matches the output snapshot", () => {
    expect(out).toMatchSnapshot();
  });

  it("compiles, and narrowing on `type` reaches the template's data", () => {
    const use = `
export function titles(p: Pages): string[] {
  return p.sections.map((b) => {
    switch (b.type) {
      case "hero": return b.data.title + String(b.data.height ?? "") + (b.data.items ?? []).map((i) => i.data.label).join();
      case "cta": return b.data.label;
      default: return b.type;
    }
  });
}
`;
    const bad = `
export function wrong(p: Pages): string {
  const b = p.sections[0]!;
  if (b.type === "cta") return b.data.title;
  return "";
}
`;
    expect(typecheck(out, use)).toEqual([]);
    const errors = typecheck(out, bad);
    expect(errors.join("\n")).toMatch(/Property 'title' does not exist on type 'CtaBlockData'/);
  });
});
