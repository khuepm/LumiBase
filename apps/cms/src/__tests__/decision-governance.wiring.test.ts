import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isControlPlanePath } from '../middleware/control-plane-access-guard';
import { isStudioAccessPath } from '../middleware/studio-access';

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

const RULES: Array<{ label: string; patterns: RegExp[]; allowed: string[] }> = [
  {
    label: 'new SystemOneDecisionProvider(',
    patterns: construction('SystemOneDecisionProvider'),
    allowed: [PROVIDER_FILE],
  },
  {
    label: 'new LLMDecisionProvider(',
    patterns: construction('LLMDecisionProvider'),
    allowed: [PROVIDER_FILE],
  },
  {
    label: 'new DecisionGovernanceService(',
    patterns: construction('DecisionGovernanceService'),
    allowed: [GOVERNANCE_FILE],
  },
  {
    label: '.provider.decide(',
    patterns: [/\.\s*provider\s*\.\s*decide\s*\(/],
    allowed: [GOVERNANCE_FILE],
  },
];

const CREATE = /\bcreateDecisionProvider\s*\(/;
const AUTHORIZE = /\bauthorizeDecision\s*\(/;
const GOVERNED = /\brunGovernedDecision\s*\(/;

/** Files that resolve a provider without both governance calls. */
function ungovernedEntryPoints(files: Array<{ rel: string; source: string }>): string[] {
  return files
    .filter(({ rel }) => rel !== PROVIDER_FILE && rel !== GOVERNANCE_FILE)
    .filter(({ source }) => CREATE.test(source) && !(AUTHORIZE.test(source) && GOVERNED.test(source)))
    .map(({ rel }) => rel);
}

describe('decision governance wiring (source scan)', () => {
  it.each(RULES)('$label appears only in its allowed files', ({ patterns, allowed }) => {
    const offenders = sources
      .filter(({ rel, source }) => !allowed.includes(rel) && patterns.some((p) => p.test(source)))
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
  ])('%s catches %s', (label, sample) => {
    const rule = RULES.find((r) => r.label === label)!;
    expect(rule.patterns.some((p) => p.test(sample))).toBe(true);
  });

  it.each([
    '// SystemOneDecisionProvider handles Jev; see LLMDecisionProvider too',
    'import { DecisionGovernanceService } from "./decision-governance";',
    'const result = await runGovernedDecision(resolveDeps, request, options);',
  ])('does not fire on legitimate text: %s', (sample) => {
    for (const rule of RULES) expect(rule.patterns.some((p) => p.test(sample))).toBe(false);
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

  it('the prefix-match classification would fire if /api/v1/ai were guarded', () => {
    const fakeList = ['/api/v1/ai'];
    const path = '/api/v1/ai/decisions';
    expect(fakeList.some((p) => path === p || path.startsWith(`${p}/`))).toBe(true);
  });
});
