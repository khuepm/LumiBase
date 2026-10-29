import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../env';
import { hasSiteAdminAccess, isControlPlanePath } from '../middleware/control-plane-access-guard';
import { isStudioAccessPath } from '../middleware/studio-access';
import { authorizeDecision, DecisionGovernanceError, writeDecisionAudit } from '../services/decision-governance';
import type { PermissionBundle } from '../services/permission-service';

const audits = vi.hoisted(() => [] as unknown[]);
vi.mock('../modules/audit/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/audit/logger')>()),
  AuditLogger: class {
    async write(entry: unknown) {
      audits.push(entry);
    }
  },
}));
/**
 * Tripwire for #511 (J04): every path to a PAID decision provider is governed
 * — `authorizeDecision` (capability `ai:decide`) and `runGovernedDecision`
 * (site opt-in, allowlist, budgets, quota, audit), all before the upstream
 * call. A route, skill, flow op or worker that called `provider.decide`
 * directly, or resolved a provider without both governance calls, would spend
 * the operator's budget with none of those checks. This source scan locks
 * that class, in the shape of item-service-rbac-context.test.ts (B72: the
 * dynamic-import construction form must be caught too).
 *
 * Entry points may call `createDecisionProvider` themselves (routes/ai.ts
 * today, routes/ai-review.ts in #530) as long as the same file also calls
 * `authorizeDecision` and `runGovernedDecision`.
 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (/(?:\.test\.|\.spec\.)/.test(entry) || full.includes(`${sep}__tests__${sep}`)) continue;
    out.push(full);
  }
  return out;
}

const srcRoot = resolve(__dirname, '..');
const sources = listSourceFiles(srcRoot).map((file) => ({
  rel: relative(srcRoot, file).split(sep).join('/'),
  source: readFileSync(file, 'utf8'),
}));

function construction(name: string): RegExp[] {
  return [
    new RegExp(String.raw`\bnew\s+${name}\s*\(`),
    new RegExp(String.raw`\bnew\s*\([^;{}]{0,200}?\)\s*\.\s*${name}\s*\(`),
  ];
}

const PROVIDER_FILE = 'services/decision-provider.ts';
const GOVERNANCE_FILE = 'services/decision-governance.ts';

function anyOf(patterns: RegExp[]): (source: string) => boolean {
  return (source) => patterns.some((p) => p.test(source));
}

const IDENT = String.raw`[A-Za-z_$][\w$]*`;

/**
 * `provider.decide(` reached through a local alias, where the call site no
 * longer reads `.provider.decide(`:
 *   const { provider } = configured;        provider.decide(…)   (bare name)
 *   const { provider: p } = configured;     p.decide(…)          (renamed)
 *   const p = configured.provider;          p.decide(…)          (assigned)
 * Heuristic: the alias and its `.decide(` call must sit in the same file, and
 * a name aliased twice or passed through a helper is not followed.
 */
function aliasedProviderDecide(source: string): boolean {
  if (new RegExp(String.raw`(?<![\w$.])provider\s*\??\.\s*decide\s*\(`).test(source)) return true;
  const aliases = new Set<string>();
  for (const m of source.matchAll(new RegExp(String.raw`\bprovider\s*:\s*(${IDENT})\s*[,}=]`, 'g'))) {
    aliases.add(m[1]!);
  }
  for (const m of source.matchAll(new RegExp(String.raw`\b(${IDENT})\s*=\s*[^;=]*?\.\s*provider\s*[;\n]`, 'g'))) {
    aliases.add(m[1]!);
  }
  return [...aliases].some((alias) =>
    new RegExp(String.raw`(?<![\w$.])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*\??\.\s*decide\s*\(`).test(source),
  );
}

const RULES: Array<{ label: string; test: (source: string) => boolean; allowed: string[] }> = [
  {
    label: 'new SystemOneDecisionProvider(',
    test: anyOf(construction('SystemOneDecisionProvider')),
    allowed: [PROVIDER_FILE],
  },
  {
    label: 'new LLMDecisionProvider(',
    test: anyOf(construction('LLMDecisionProvider')),
    allowed: [PROVIDER_FILE],
  },
  {
    label: 'new DecisionGovernanceService(',
    test: anyOf(construction('DecisionGovernanceService')),
    allowed: [GOVERNANCE_FILE],
  },
  {
    label: '.provider.decide(',
    test: anyOf([/\.\s*provider\s*\??\.\s*decide\s*\(/]),
    allowed: [GOVERNANCE_FILE],
  },
  {
    label: 'aliased provider.decide(',
    test: aliasedProviderDecide,
    allowed: [GOVERNANCE_FILE],
  },
];

const CREATE = /\bcreateDecisionProvider\s*\(/;
const AUTHORIZE = /\bauthorizeDecision\s*\(/;
const GOVERNED = /\brunGovernedDecision\s*\(/;

/**
 * Principal-less system callers. No person is behind them, so there is no
 * grant for `authorizeDecision` to check; they are gated instead by a site
 * switch read at call time, and they still MUST go through
 * `runGovernedDecision` (opt-in, allowlist, budgets, quota, audit with
 * `principal: null`). Adding a file here needs that reason, not convenience.
 *
 * - services/semantic-drift-scan.ts — J12 #519 semantic drift pass, gated by
 *   `aiDecisions.enabled` + `aiDecisions.drift` (`driftDecisionsEnabled`).
 */
const SYSTEM_ENTRY_POINTS = ['services/semantic-drift-scan.ts'];

/**
 * Files that resolve a provider without the governance calls they need.
 *
 * Known limit: this is per FILE, not per call. A file with one governed path
 * and a second, ungoverned `createDecisionProvider(...)` passes. A per-call
 * rule (each call followed by `runGovernedDecision` in the same function) was
 * considered and rejected: the real entry points do not share a shape —
 * routes/ai.ts authorizes, then resolves, then governs; flow-ai-decision.ts
 * resolves inside a lazy deps closure and authorizes later in another
 * function — so any ordering or proximity rule either flags them or is loose
 * enough to prove nothing. The direct-call rules above still catch a second
 * path that calls `provider.decide` itself; what remains uncaught is a second
 * path that hands a provider to code outside this scan. Review covers that.
 */
function ungovernedEntryPoints(
  files: Array<{ rel: string; source: string }>,
  systemEntryPoints: string[] = SYSTEM_ENTRY_POINTS,
): string[] {
  return files
    .filter(({ rel }) => rel !== PROVIDER_FILE && rel !== GOVERNANCE_FILE)
    .filter(({ rel, source }) => {
      if (!CREATE.test(source)) return false;
      if (systemEntryPoints.includes(rel)) return !GOVERNED.test(source);
      return !(AUTHORIZE.test(source) && GOVERNED.test(source));
    })
    .map(({ rel }) => rel);
}

/**
 * #562 / B144: publishable API keys and `frontend` sessions are refused inside
 * `authorizeDecision`, from the grant's `callerClass`. That only holds while
 * (1) the class is set by the capability resolvers and nobody else, and
 * (2) every entry point gets its grant from one of them. A new entry point
 * that builds `{ allowed: true, capabilities: […], callerClass: 'standard' }`
 * itself, or spreads `{ ...grant, callerClass: 'standard' }`, would typecheck
 * and skip the block. These rules lock both halves.
 */
const CALLER_CLASS = /\bcallerClass\b/;
/** Files that may mention `callerClass` at all. */
const CALLER_CLASS_RESOLVERS = [
  'services/effective-capability-service.ts',
  'services/governed-capabilities.ts',
  GOVERNANCE_FILE,
];
/**
 * Agent-tool capability producers: they build a `GovernedCapabilityResolution`
 * for the AI harness (agent roles, legacy job snapshots), never for a decision.
 * They may set `callerClass: 'standard'` only because they never call
 * `authorizeDecision`; the last rule below fails if one starts to.
 */
const CALLER_CLASS_NON_DECISION = ['services/agent-run-worker.ts', 'services/ai-chat-run-worker.ts'];
const RESOLVER_CALL = /\bresolveRequestCapabilities\s*\(|\bresolvePrincipalCapabilities\s*\(|\.\s*resolveGrant\s*\(/;

function callerClassOffenders(
  files: Array<{ rel: string; source: string }>,
  allowed: string[] = [...CALLER_CLASS_RESOLVERS, ...CALLER_CLASS_NON_DECISION],
): string[] {
  return files
    .filter(({ rel, source }) => !allowed.includes(rel) && CALLER_CLASS.test(source))
    .map(({ rel }) => rel);
}

/** Non-system files that call `authorizeDecision` without a grant from a resolver. */
function grantsNotFromResolver(files: Array<{ rel: string; source: string }>): string[] {
  return files
    .filter(({ rel }) => rel !== GOVERNANCE_FILE && !SYSTEM_ENTRY_POINTS.includes(rel))
    .filter(({ source }) => AUTHORIZE.test(source) && !RESOLVER_CALL.test(source))
    .map(({ rel }) => rel);
}

describe('decision caller class wiring (#562)', () => {
  it('only the capability resolvers (and the documented non-decision producers) mention callerClass', () => {
    expect(callerClassOffenders(sources)).toEqual([]);
  });

  it('the non-decision producers never call authorizeDecision', () => {
    for (const rel of CALLER_CLASS_NON_DECISION) {
      const file = sources.find((s) => s.rel === rel);
      expect(file, rel).toBeDefined();
      expect(AUTHORIZE.test(file!.source), rel).toBe(false);
    }
  });

  it('every file that calls authorizeDecision gets its grant from a capability resolver', () => {
    expect(grantsNotFromResolver(sources)).toEqual([]);
    // The scan must see the three real entry points, or it proves nothing.
    const authorizing = sources.filter(({ source }) => AUTHORIZE.test(source)).map(({ rel }) => rel);
    expect(authorizing).toEqual(
      expect.arrayContaining(['routes/ai.ts', 'routes/ai-review.ts', 'services/flow-ai-decision.ts']),
    );
  });

  it('the refusal lives in the shared authorizeDecision, whatever capability the grant holds', () => {
    for (const callerClass of ['publishable_api_key', 'frontend_session', undefined] as const) {
      for (const capabilities of [['ai:decide'], ['admin'], ['*']]) {
        let error: unknown;
        try {
          authorizeDecision({ allowed: true, capabilities, callerClass: callerClass as never });
        } catch (err) {
          error = err;
        }
        expect(error, `${callerClass} ${capabilities}`).toBeInstanceOf(DecisionGovernanceError);
        expect((error as DecisionGovernanceError).code).toBe('FORBIDDEN');
      }
    }
  });

  // Flows `ai:decision` (services/flow-ai-decision.ts) resolves a persisted
  // principal ref, which carries no session audience: only the API key row is
  // re-read. That is enough only because a flow run is started from the
  // control plane, which refuses frontend sessions and API keys. If
  // /api/v1/flows ever leaves the control plane, flow principals must carry
  // the caller class.
  it('flow runs start on the control plane, which refuses frontend sessions and API keys', () => {
    expect(isControlPlanePath('/api/v1/flows/f1/run')).toBe(true);
    const admin = { admin: true } as PermissionBundle;
    const frontend: AuthPrincipal = { userId: 'u', roles: ['r'], isFrontendUser: true, raw: { aud: 'frontend' } };
    const apiKey: AuthPrincipal = { type: 'api_key', apiKeyId: 'k', roles: [], raw: {} };
    expect(hasSiteAdminAccess(frontend, admin)).toBe(false);
    expect(hasSiteAdminAccess(apiKey, admin)).toBe(false);
    // And the matcher can say yes, so the two `false` above mean something.
    expect(hasSiteAdminAccess({ userId: 'u', roles: ['r'], raw: { aud: 'studio' } }, admin)).toBe(true);
  });
});

describe('decision caller class wiring — the guards can fire (negative checks)', () => {
  it.each([
    ['routes/minted.ts', "authorizeDecision({ ...grant, callerClass: 'standard' });"],
    ['routes/literal.ts', "const g = { allowed: true, capabilities: ['ai:decide'], callerClass: 'standard' };"],
    ['routes/shorthand.ts', "const callerClass = 'standard'; authorizeDecision({ ...grant, callerClass });"],
  ])('flags %s', (rel, source) => {
    expect(callerClassOffenders([{ rel, source }])).toEqual([rel]);
  });

  it('does not fire on a file that never names the field', () => {
    expect(
      callerClassOffenders([{ rel: 'routes/ok.ts', source: 'const grant = await resolveRequestCapabilities(c); authorizeDecision(grant);' }]),
    ).toEqual([]);
  });

  it('flags an entry point that authorizes a grant it did not resolve', () => {
    const scratch = [
      {
        rel: 'routes/minted.ts',
        source:
          "authorizeDecision(grant); const p = createDecisionProvider(env); await runGovernedDecision(d, r, o);",
      },
      { rel: 'routes/http.ts', source: 'const grant = await resolveRequestCapabilities(c); authorizeDecision(grant);' },
      { rel: 'services/queued.ts', source: 'const grant = await resolvePrincipalCapabilities(s, ref); authorizeDecision(grant);' },
      { rel: 'services/flow.ts', source: 'const grant = await runtime.resolveGrant(principal); authorizeDecision(grant);' },
    ];
    expect(grantsNotFromResolver(scratch)).toEqual(['routes/minted.ts']);
  });
});

describe('decision governance wiring (source scan)', () => {
  it.each(RULES)('$label appears only in its allowed files', ({ test, allowed }) => {
    const offenders = sources
      .filter(({ rel, source }) => !allowed.includes(rel) && test(source))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });

  it('every file that calls createDecisionProvider also calls authorizeDecision and runGovernedDecision', () => {
    expect(ungovernedEntryPoints(sources)).toEqual([]);
    // The scan must see at least the HTTP entry point, or it proves nothing.
    expect(sources.some(({ rel, source }) => rel === 'routes/ai.ts' && CREATE.test(source))).toBe(true);
  });

  it('keeps exactly /api/v1/ai/decisions off the control-plane and Studio-access guards', () => {
    expect(isControlPlanePath('/api/v1/ai/decisions')).toBe(false);
    expect(isStudioAccessPath('/api/v1/ai/decisions')).toBe(false);
  });

  it('exposes Retry-After through CORS so cross-origin callers can read the 429 hint', () => {
    const index = sources.find(({ rel }) => rel === 'index.ts')!.source;
    const expose = index.match(/exposeHeaders\s*:\s*\[([^\]]*)\]/);
    expect(expose?.[1]).toContain("'Retry-After'");
  });
});

describe('decision governance wiring — the guards can fire (negative checks)', () => {
  it.each([
    ['new SystemOneDecisionProvider(', 'const p = new SystemOneDecisionProvider({});'],
    ['new SystemOneDecisionProvider(', "const p = new (await import('./decision-provider')).SystemOneDecisionProvider({});"],
    ['new LLMDecisionProvider(', 'const p = new LLMDecisionProvider(llm, m);'],
    ['new LLMDecisionProvider(', "const p = new (await import('./decision-provider')).LLMDecisionProvider(llm, m);"],
    ['new DecisionGovernanceService(', 'const g = new DecisionGovernanceService(deps);'],
    ['new DecisionGovernanceService(', "const g = new (await import('./decision-governance')).DecisionGovernanceService(deps);"],
    ['.provider.decide(', 'const r = await configured.provider.decide(request);'],
    ['.provider.decide(', 'const r = await createDecisionProvider(env)!.provider.decide(request);'],
    ['.provider.decide(', 'const r = await configured?.provider?.decide(request);'],
    ['aliased provider.decide(', 'const { provider } = configured;\nawait provider.decide(request);'],
    ['aliased provider.decide(', 'const { name, provider } = createDecisionProvider(env)!;\nprovider?.decide(r);'],
    ['aliased provider.decide(', 'const { provider: p } = configured;\nawait p.decide(request);'],
    ['aliased provider.decide(', 'const { provider: $p, model } = configured;\nawait $p.decide(request);'],
    ['aliased provider.decide(', 'const p = configured.provider;\nawait p.decide(request);'],
  ])('%s catches %s', (label, sample) => {
    const rule = RULES.find((r) => r.label === label)!;
    expect(rule.test(sample)).toBe(true);
  });

  it.each([
    '// SystemOneDecisionProvider handles Jev; see LLMDecisionProvider too',
    'import { DecisionGovernanceService } from "./decision-governance";',
    'const result = await runGovernedDecision(resolveDeps, request, options);',
    // Other services have their own decide(); an unrelated `provider` alias is not one.
    'const service = new EditorialService(db); await service.decide(input);',
    'const { provider } = createConfiguredLLMProvider(env)!; await provider.chat(messages);',
    'const { provider: llm } = configured; await llm.chat(messages); await reviewService.decide(x);',
  ])('does not fire on legitimate text: %s', (sample) => {
    for (const rule of RULES) expect(rule.test(sample), rule.label).toBe(false);
  });

  it('flags an entry point that resolves a provider without both governance calls', () => {
    const scratch = [
      { rel: 'routes/bad.ts', source: 'const configured = createDecisionProvider(c.env);' },
      { rel: 'routes/half.ts', source: 'authorizeDecision(grant); const p = createDecisionProvider(env);' },
      {
        rel: 'routes/good.ts',
        source: 'authorizeDecision(grant); const p = createDecisionProvider(env); await runGovernedDecision(d, r, o);',
      },
    ];
    expect(ungovernedEntryPoints(scratch)).toEqual(['routes/bad.ts', 'routes/half.ts']);
  });

  it('a system entry point is exempt from authorizeDecision only, never from runGovernedDecision', () => {
    const scratch = [
      { rel: 'services/sys-good.ts', source: 'const p = createDecisionProvider(env); await runGovernedDecision(d, r, o);' },
      { rel: 'services/sys-bad.ts', source: 'const p = createDecisionProvider(env);' },
    ];
    expect(ungovernedEntryPoints(scratch, ['services/sys-good.ts', 'services/sys-bad.ts'])).toEqual([
      'services/sys-bad.ts',
    ]);
    // Without the allowlist entry, the same principal-less file is flagged.
    expect(ungovernedEntryPoints(scratch, [])).toEqual(['services/sys-good.ts', 'services/sys-bad.ts']);
  });

  it('every system entry point on the allowlist still exists and still calls runGovernedDecision', () => {
    for (const rel of SYSTEM_ENTRY_POINTS) {
      const file = sources.find((s) => s.rel === rel);
      expect(file, rel).toBeDefined();
      expect(GOVERNED.test(file!.source), rel).toBe(true);
    }
  });

  // The `false` assertions above only mean something if the real matchers can
  // say `true` for this path. Run the same functions the middleware runs.
  it('the real guard matchers would classify /api/v1/ai/decisions if /api/v1/ai were listed', () => {
    const path = '/api/v1/ai/decisions';
    expect(isControlPlanePath(path, ['/api/v1/ai'])).toBe(true);
    expect(isStudioAccessPath(path, ['/api/v1/ai'])).toBe(true);
    // Prefix, not substring: a sibling with the same leading characters stays out.
    expect(isControlPlanePath('/api/v1/aix/decisions', ['/api/v1/ai'])).toBe(false);
    expect(isStudioAccessPath('/api/v1/aix/decisions', ['/api/v1/ai'])).toBe(false);
    // And with the real lists they fire on guarded paths, including a sibling under /api/v1/ai.
    expect(isControlPlanePath('/api/v1/ai/automation/templates')).toBe(true);
    expect(isStudioAccessPath('/api/v1/agent/goals')).toBe(true);
  });
});

/**
 * #564 / B147: authorization refusals are aggregated per window so a flood of
 * refused requests cannot flood the audit log. That holds only while
 * (1) `writeDecisionAudit` in decision-governance.ts stays the only writer of
 * the `ai_decision` event (it routes `FORBIDDEN` to `recordDecisionRefusal`),
 * and (2) every request-path entry point builds its audit context with
 * `decisionAuditContextForRequest(c)`, which carries the refusal store. A
 * hand-built `{ db, siteId, requestId, principal }` has no store, so its
 * refusals would write one row each again. These rules lock both halves.
 */
// A quoted literal, or a template literal as an event value (backticks in comments are prose).
const AI_DECISION_EVENT = /(['"])ai_decision\1|\bevent\s*:\s*`ai_decision`/;
const WRITE_AUDIT = /\bwriteDecisionAudit\s*\(/;
const REQUEST_CONTEXT = /\bdecisionAuditContextForRequest\s*\(/;
const AUDIT_CONTEXT_TYPE = /\bDecisionAuditContext\b/;

/**
 * Entry points that authorize a persisted principal off the request path.
 * They write no refusal row: they return `FORBIDDEN` to their caller and never
 * call `writeDecisionAudit` themselves (asserted below).
 *
 * - services/flow-ai-decision.ts — Flows `ai:decision` (J10), principal from the run.
 * - services/semantic-drift-scan.ts — J12 system scan, no principal at all.
 */
const NON_REQUEST_DECISION_ENTRY_POINTS = ['services/flow-ai-decision.ts', 'services/semantic-drift-scan.ts'];

function eventWriters(files: Array<{ rel: string; source: string }>): string[] {
  return files.filter(({ rel, source }) => rel !== GOVERNANCE_FILE && AI_DECISION_EVENT.test(source)).map(({ rel }) => rel);
}

/** Arguments of each `writeDecisionAudit(` call, first argument only. */
function auditContextArgs(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bwriteDecisionAudit\s*\(\s*/g)) {
    let depth = 0;
    let arg = '';
    for (const ch of source.slice(m.index! + m[0].length)) {
      if (depth === 0 && (ch === ',' || ch === ')')) break;
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth--;
      arg += ch;
    }
    out.push(arg.trim());
  }
  return out;
}

function unboundedRefusalWriters(
  files: Array<{ rel: string; source: string }>,
  exempt: string[] = NON_REQUEST_DECISION_ENTRY_POINTS,
): string[] {
  return files
    .filter(({ rel }) => rel !== GOVERNANCE_FILE && !exempt.includes(rel))
    .filter(({ source }) => AUTHORIZE.test(source) && (WRITE_AUDIT.test(source) || GOVERNED.test(source)))
    .filter(
      ({ source }) =>
        !REQUEST_CONTEXT.test(source) ||
        AUDIT_CONTEXT_TYPE.test(source) ||
        auditContextArgs(source).some((arg) => !/^decisionAuditContextForRequest\(\s*\w+\s*\)$/.test(arg)),
    )
    .map(({ rel }) => rel);
}

describe('decision refusal audit wiring (#564)', () => {
  it("only decision-governance.ts writes the 'ai_decision' event", () => {
    expect(eventWriters(sources)).toEqual([]);
    expect(AI_DECISION_EVENT.test(sources.find((s) => s.rel === GOVERNANCE_FILE)!.source)).toBe(true);
  });

  it('every request-path decision entry point builds its audit context with decisionAuditContextForRequest', () => {
    expect(unboundedRefusalWriters(sources)).toEqual([]);
    // The scan must see both HTTP entry points, or it proves nothing.
    const scanned = sources
      .filter(({ source }) => AUTHORIZE.test(source) && (WRITE_AUDIT.test(source) || GOVERNED.test(source)))
      .map(({ rel }) => rel);
    expect(scanned).toEqual(expect.arrayContaining(['routes/ai.ts', 'routes/ai-review.ts']));
  });

  it('the non-request entry points still exist and never write a decision audit themselves', () => {
    for (const rel of NON_REQUEST_DECISION_ENTRY_POINTS) {
      const file = sources.find((s) => s.rel === rel);
      expect(file, rel).toBeDefined();
      expect(WRITE_AUDIT.test(file!.source), rel).toBe(false);
    }
  });

  it('writeDecisionAudit still routes FORBIDDEN through the bounded path', async () => {
    audits.length = 0;
    const audit = {
      db: {} as never,
      siteId: 'site_1',
      requestId: null,
      principal: null,
      refusal: { cache: new MemoryCacheProvider(), clientIp: '203.0.113.7', hashSecret: 's', windowSeconds: 300 },
    };
    const record = { outcome: 'FORBIDDEN' as const, status: 403, startedAt: Date.now(), refusalReason: 'capability_missing' as const };
    await writeDecisionAudit(audit, record);
    await writeDecisionAudit(audit, record);
    expect(audits).toHaveLength(1);
  });
});

describe('decision refusal audit wiring — the guards can fire (negative checks)', () => {
  it("flags a second writer of the 'ai_decision' event", () => {
    expect(
      eventWriters([
        { rel: 'routes/other.ts', source: "await new AuditLogger({ db, siteId }).write({ event: 'ai_decision' });" },
        { rel: 'routes/template.ts', source: 'await logger.write({ event: `ai_decision` });' },
        { rel: 'routes/ok.ts', source: '// writes `ai_decision` rows through writeDecisionAudit' },
      ]),
    ).toEqual(['routes/other.ts', 'routes/template.ts']);
  });

  it('flags hand-built audit contexts and passes the compliant shape', () => {
    const scratch = [
      {
        rel: 'routes/builder.ts',
        source:
          'function ctx(c): DecisionAuditContext { return { db, siteId, requestId, principal }; }\n' +
          "authorizeDecision(grant); await writeDecisionAudit(ctx(c), { outcome: 'FORBIDDEN' });",
      },
      {
        rel: 'routes/inline.ts',
        source:
          'const a = decisionAuditContextForRequest(c);\n' +
          "authorizeDecision(grant); await writeDecisionAudit({ db, siteId, requestId, principal: principalRefFromAuth(x, s) }, { outcome: 'FORBIDDEN' });",
      },
      {
        rel: 'routes/none.ts',
        source: 'authorizeDecision(grant); await runGovernedDecision(d, r, { audit: { db, siteId, requestId, principal } });',
      },
      {
        rel: 'routes/good.ts',
        source:
          "authorizeDecision(grant); await writeDecisionAudit(decisionAuditContextForRequest(c), { outcome: 'FORBIDDEN' });\n" +
          'await runGovernedDecision(d, r, { audit: decisionAuditContextForRequest(c) });',
      },
    ];
    expect(unboundedRefusalWriters(scratch)).toEqual(['routes/builder.ts', 'routes/inline.ts', 'routes/none.ts']);
    // Without the exemption, a flow-style entry point that builds its own context is flagged too.
    const flow = [{ rel: 'services/flow-ai-decision.ts', source: 'authorizeDecision(g); runGovernedDecision(d, r, { audit });' }];
    expect(unboundedRefusalWriters(flow)).toEqual([]);
    expect(unboundedRefusalWriters(flow, [])).toEqual(['services/flow-ai-decision.ts']);
  });
});
