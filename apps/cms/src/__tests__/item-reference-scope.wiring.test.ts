import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Item-reference site-scope tripwire (#868, before Phase B of #853).
 *
 * Item ids are unique per site, not per instance: `lumibase_items` is keyed
 * `(site_id, id)` since migration 0035, and an environment fork keeps item
 * ids, so the same id exists in the origin site and in the environment. A
 * query that matches an item by id alone can then read or write another
 * site's item. The audit in #853 found every such match scoped (44 on
 * `items.id`, 23 on `<table>.itemId`); this scan keeps it that way.
 *
 * Rule: in non-test code under `apps/cms/src`, every `eq` / `inArray` / `ne`
 * / `notInArray` whose column is `items.id` or `<table>.itemId` must sit in a
 * statement that also names the site (`siteId`, `site_id` or `scopeSite`).
 * A fragment that is composed with a site scope elsewhere goes in
 * {@link ALLOWED} with the reason; the list may only shrink, and an entry that
 * no longer matches anything fails the scan.
 *
 * It is a source scan: a statement that names the site without filtering on
 * it passes. The runtime canary of the environments design (§2.2) complements
 * it with executed paths.
 */

const CMS_SRC = resolve(__dirname, '..');

const COMPARATORS = new Set(['eq', 'ne', 'inArray', 'notInArray']);
const SITE_TOKEN = /\bsiteId\b|\bsite_id\b|\bscopeSite\b/;

/**
 * `<file>::<function>::<call>` → why the call is scoped although its statement
 * does not name the site. `<function>` is the nearest named enclosing function
 * or method (`<top>` at module level); `<call>` is the call's source text with
 * whitespace collapsed.
 */
const ALLOWED: Record<string, string> = {
  'services/item-service.ts::treeListScope::ne(items.id, anchor.id)':
    'Returns a `where` fragment; the only caller (`list`) ANDs it with `scopeSite(items.siteId, …)`.',
  'services/item-service.ts::treeListScope::inArray(items.id, ancestorIds)':
    'Returns a `where` fragment; the only caller (`list`) ANDs it with `scopeSite(items.siteId, …)`.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** `items.id`, `schema.items.id`, `revisions.itemId`, `t.itemId` … */
function isItemReference(node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  const prop = node.name.text;
  if (prop === 'itemId') return true;
  if (prop !== 'id') return false;
  const target = node.expression;
  const name = ts.isIdentifier(target)
    ? target.text
    : ts.isPropertyAccessExpression(target)
      ? target.name.text
      : '';
  return name === 'items';
}

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

/** Nearest enclosing statement — the unit the site predicate must share. */
function enclosingStatement(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isExpressionStatement(parent) ||
      ts.isVariableStatement(parent) ||
      ts.isReturnStatement(parent) ||
      ts.isThrowStatement(parent)
    ) {
      return parent;
    }
    // A condition is its own unit; the branches of an `if` are not part of it.
    if ((ts.isIfStatement(parent) || ts.isWhileStatement(parent)) && parent.expression === current) return current;
    if (ts.isSourceFile(parent) || ts.isBlock(parent)) return current;
    current = parent;
  }
  return current;
}

function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isGetAccessor(current)) &&
      current.name
    ) {
      return current.name.getText();
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)) {
      return current.parent.name.getText();
    }
    current = current.parent;
  }
  return '<top>';
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current) && 'body' in current) return current as ts.FunctionLikeDeclaration;
    current = current.parent;
  }
  return undefined;
}

/**
 * Names whose definition carries a site predicate, visible from `node`: local
 * variables of every enclosing function (`const scope = and(scopeSite(…), …)`,
 * `const filters = [eq(t.siteId, siteId)]`) and methods of the enclosing class
 * (`this.scope(collectionId)`). A statement that uses one of them is composed
 * with the site even though it does not spell it out.
 */
function siteScopedNames(node: ts.Node): { locals: Set<string>; methods: Set<string> } {
  const locals = new Set<string>();
  const methods = new Set<string>();
  for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) {
    const visit = (child: ts.Node) => {
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.initializer) {
        if (SITE_TOKEN.test(child.initializer.getText())) locals.add(child.name.text);
      }
      ts.forEachChild(child, visit);
    };
    if (fn.body) visit(fn.body);
  }
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isClassLike(current)) current = current.parent;
  if (current) {
    for (const member of current.members) {
      if (ts.isMethodDeclaration(member) && member.body && member.name && SITE_TOKEN.test(member.body.getText())) {
        methods.add(member.name.getText());
      }
    }
  }
  return { locals, methods };
}

function usesSiteScopedName(statement: ts.Node, names: { locals: Set<string>; methods: Set<string> }): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(child) && names.locals.has(child.text)) {
      // Only a reference, not the property name in `x.scope`.
      const parent = child.parent;
      if (!(ts.isPropertyAccessExpression(parent) && parent.name === child)) found = true;
    }
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      names.methods.has(child.expression.name.text)
    ) {
      found = true;
    }
    ts.forEachChild(child, visit);
  };
  visit(statement);
  return found;
}

interface Match {
  key: string;
  location: string;
  scoped: boolean;
}

function scanSource(rel: string, text: string): Match[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches: Match[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && COMPARATORS.has(calleeName(node))) {
      const column = node.arguments[0];
      if (column && isItemReference(column)) {
        const statement = enclosingStatement(node);
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        matches.push({
          key: `${rel}::${enclosingFunctionName(node)}::${node.getText().replace(/\s+/g, ' ')}`,
          location: `${rel}:${line + 1}`,
          scoped: SITE_TOKEN.test(statement.getText()) || usesSiteScopedName(statement, siteScopedNames(node)),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches;
}

function scanTree(): Match[] {
  return walk(CMS_SRC).flatMap((path) =>
    scanSource(relative(CMS_SRC, path).split('\\').join('/'), readFileSync(path, 'utf8')),
  );
}

describe('item references carry a site predicate (#868)', () => {
  const matches = scanTree();

  it('finds the item-id filters it is meant to police', () => {
    // A rename (`items` → something else) would silently empty the scan.
    expect(matches.filter((m) => m.key.includes('items.id')).length).toBeGreaterThan(30);
    expect(matches.filter((m) => m.key.includes('.itemId')).length).toBeGreaterThan(15);
  });

  it('every item-id filter in apps/cms/src is site-scoped or allow-listed with a reason', () => {
    const unscoped = matches.filter((m) => !m.scoped && !(m.key in ALLOWED)).map((m) => `${m.location}  ${m.key}`);
    expect(unscoped, 'Add a site predicate in the same statement, or allow-list the fragment with a reason').toEqual(
      [],
    );
  });

  it('every allow-list entry still matches an unscoped filter (the list may only shrink)', () => {
    const live = new Set(matches.filter((m) => !m.scoped).map((m) => m.key));
    expect(Object.keys(ALLOWED).filter((key) => !live.has(key))).toEqual([]);
  });

  describe('the scan itself', () => {
    const scan = (code: string) => scanSource('fixture.ts', code);

    it('flags an unscoped items.id filter', () => {
      const [m] = scan(`async function f(db, id) { return db.select().from(items).where(eq(items.id, id)); }`);
      expect(m).toMatchObject({ scoped: false, key: 'fixture.ts::f::eq(items.id, id)' });
    });

    it('flags an unscoped <table>.itemId filter and inArray', () => {
      const found = scan(`
        const g = async (db, ids) => {
          await db.delete(shares).where(inArray(shares.itemId, ids));
        };`);
      expect(found).toEqual([expect.objectContaining({ scoped: false, key: 'fixture.ts::g::inArray(shares.itemId, ids)' })]);
    });

    it('accepts a filter whose statement names the site', () => {
      const found = scan(`
        async function h(db, siteId, id) {
          await db.select().from(items).where(and(eq(items.siteId, siteId), eq(items.id, id)));
          await db.select().from(items).where(and(scopeSite(items.siteId, s), eq(schema.items.id, id)));
        }`);
      expect(found.map((m) => m.scoped)).toEqual([true, true]);
    });

    it('does not count a site name in a neighbouring statement', () => {
      const found = scan(`
        async function k(db, siteId, id) {
          const site = siteId;
          return db.select().from(items).where(eq(items.id, id));
        }`);
      expect(found).toEqual([expect.objectContaining({ scoped: false })]);
    });

    it('accepts a filter composed with a site-scoped local or method', () => {
      const found = scan(`
        class S {
          private scope(c) { return and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, c)); }
          async a(tx, id) {
            const scope = and(scopeSite(items.siteId, s), eq(items.collectionId, c));
            await tx.update(items).set({}).where(and(scope, eq(items.id, id)));
          }
          async b(db, id) { return db.select().from(items).where(and(this.scope(c), ne(items.id, id))); }
          async c(siteId, f) {
            const filters = [eq(gitProvenance.siteId, siteId)];
            if (f.itemId) filters.push(eq(gitProvenance.itemId, f.itemId));
          }
        }`);
      expect(found.map((m) => m.scoped)).toEqual([true, true, true]);
    });

    it('does not accept a same-named local from an unrelated function', () => {
      const found = scan(`
        function one() { const scope = eq(items.siteId, s); return scope; }
        function two(db, id) { const scope = eq(items.collectionId, c); return db.select().from(items).where(and(scope, eq(items.id, id))); }`);
      expect(found).toEqual([expect.objectContaining({ scoped: false })]);
    });

    it('ignores comparisons on other columns and value-side item ids', () => {
      expect(scan(`f(eq(items.collectionId, c), eq(revisions.id, row.itemId), eq(users.id, x));`)).toEqual([]);
    });
  });
});
