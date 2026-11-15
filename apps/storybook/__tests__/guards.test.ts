import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { MIN_JUSTIFICATION, a11yException } from '../src/support/a11y';

const here = path.dirname(fileURLToPath(import.meta.url));
const storiesRoot = path.resolve(here, '../src');
const uiEntry = path.resolve(here, '../../../packages/ui/src/index.ts');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const storyFiles = walk(storiesRoot).filter((file) => /\.stories\.tsx?$/.test(file));

/** Value (non-type) exports of `@lumibase/ui`, resolved through re-exports. */
export function uiValueExports(entry: string): string[] {
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`cannot read ${entry}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return [];
  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return (target.flags & ts.SymbolFlags.Value) !== 0;
    })
    .map((symbol) => symbol.getName())
    .sort();
}

/** Names a story file imports from `@lumibase/ui` (value imports only). */
export function importedFromUi(sourceText: string): string[] {
  const source = ts.createSourceFile('story.tsx', sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@lumibase/ui') continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
      }
    }
  }
  return names;
}

/** Ways to switch the a11y gate off that bypass `a11yException()`. */
const BYPASS_PATTERNS: Array<[RegExp, string]> = [
  [/enabled\s*:\s*false/, 'axe rule disabled with `enabled: false`'],
  [/test\s*:\s*['"](?:off|todo)['"]/, "a11y `test: 'off' | 'todo'`"],
  [/disable\s*:\s*true/, 'a11y `disable: true`'],
  [/manual\s*:\s*true/, 'a11y `manual: true`'],
];

// Building a TypeScript program over the ui package (React + Radix types) takes
// several seconds on a cold CI runner, so do it once with its own budget.
const PROGRAM_BUILD_TIMEOUT_MS = 60_000;

describe('@lumibase/ui story coverage (#755 acceptance: every primitive has a story)', () => {
  let exportsOfUi: string[] = [];
  beforeAll(() => {
    exportsOfUi = uiValueExports(uiEntry);
  }, PROGRAM_BUILD_TIMEOUT_MS);

  it('finds the ui package exports', () => {
    expect(exportsOfUi).toContain('cn');
  });

  it('every value export of @lumibase/ui is imported by a story under src/ui', () => {
    const uiStories = storyFiles.filter((file) => file.startsWith(path.join(storiesRoot, 'ui') + path.sep));
    const covered = new Set(uiStories.flatMap((file) => importedFromUi(readFileSync(file, 'utf8'))));
    const missing = exportsOfUi.filter((name) => !covered.has(name));
    expect(missing, `write a story in apps/storybook/src/ui/ for: ${missing.join(', ')}`).toEqual([]);
  });

  it('detects named, aliased and type-only imports correctly', () => {
    expect(
      importedFromUi(
        "import { cn, Button as B, type ButtonProps } from '@lumibase/ui';\nimport type { X } from '@lumibase/ui';",
      ),
    ).toEqual(['cn', 'Button']);
  });
});

describe('a11y gate cannot be bypassed silently', () => {
  it.each(storyFiles.map((file) => [path.relative(storiesRoot, file), file] as const))(
    '%s relaxes a11y only through a11yException()',
    (_name, file) => {
      const text = readFileSync(file, 'utf8');
      const hits = BYPASS_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
      expect(hits).toEqual([]);
    },
  );

  it('a11yException() rejects a missing or token justification', () => {
    expect(() => a11yException([{ rule: 'color-contrast', justification: 'n/a' }])).toThrow(/at least/);
  });

  it('a11yException() turns exactly the named rules off and records why', () => {
    const justification = 'x'.repeat(MIN_JUSTIFICATION);
    expect(a11yException([{ rule: 'region', justification }])).toEqual({
      a11y: {
        config: { rules: [{ id: 'region', enabled: false }] },
        exceptions: [{ rule: 'region', justification }],
      },
    });
  });

  it('the preview makes violations fail the run', () => {
    const preview = readFileSync(path.resolve(here, '../.storybook/preview.tsx'), 'utf8');
    expect(preview).toMatch(/a11y:\s*\{[^}]*test:\s*'error'/s);
  });
});
