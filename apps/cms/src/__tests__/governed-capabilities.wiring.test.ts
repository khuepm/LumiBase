import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-scan tripwire for #472.
 *
 * The defect was not "one route passed the wrong array" — it was that every
 * transport reached for `auth.roles` as if it were a capability set. Fixing the
 * call sites one by one leaves the next route free to make the same mistake, and
 * the mistake is invisible in review because `auth.roles` *looks* like a list of
 * permissions. So the rule is mechanised: nothing that feeds the harness (or a
 * queue payload the harness will read) may source capabilities from `auth.roles`.
 *
 * Same shape as `security-guards.wiring.test.ts`: a grep the compiler cannot do,
 * kept narrow enough that a legitimate use of `auth.roles` (audit metadata,
 * logging) is not caught.
 */

const SRC = join(import.meta.dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules' || entry === 'test-utils') continue;
      walk(full, out);
      continue;
    }
    if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Comments are stripped before scanning. Without that, prose describing the old
 * behaviour — which the fix deliberately documents — trips the scan, and the
 * obvious "fix" would be to delete the explanation. Code is what is being
 * constrained, so code is what is scanned.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = walk(SRC).map((path) => {
  const source = readFileSync(path, 'utf8');
  return { path, source, code: stripComments(source) };
});

/**
 * Patterns that hand `auth.roles` to something that treats it as capabilities.
 *
 * `auth.roles` is still legitimately read for audit metadata, which is why the
 * scan targets the specific shapes that flow into authorization rather than every
 * mention of the field.
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  // Bounded gaps, not `[^)]*` / greedy `/s`: a call spans lines, but an unbounded
  // scan happily matches an `auth.roles` read hundreds of lines away and reports
  // a file that is perfectly correct.
  {
    pattern: /\.execute\((?:[^;]{0,200}?)auth\??\.roles/s,
    why: 'harness.execute() must receive resolved capabilities, not auth.roles',
  },
  {
    pattern: /executeApproved\((?:[^;]{0,200}?)auth\??\.roles/s,
    why: 'executeApproved() must receive resolved capabilities, not auth.roles',
  },
  {
    pattern: /checkCapabilities\((?:[^;]{0,200}?)auth\??\.roles/s,
    why: 'checkCapabilities() must receive resolved capabilities, not auth.roles',
  },
  {
    pattern: /capabilities:\s*(?:c\.get\('auth'\)|auth)[?.]*\.roles/,
    why: 'a capabilities field must carry resolved capabilities, not auth.roles',
  },
  {
    pattern: /userCapabilities:\s*(?:c\.get\('auth'\)|auth)[?.]*\.roles/,
    why: 'a userCapabilities field must carry resolved capabilities, not auth.roles',
  },
];

describe('governed capability resolution wiring (#472)', () => {
  it('no source file derives harness capabilities from auth.roles', () => {
    const offences: string[] = [];
    for (const { path, code } of FILES) {
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(code)) {
          offences.push(`${path.slice(SRC.length + 1)} → ${why}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('the transport files read auth.roles only for audit metadata', () => {
    /**
     * The call-shape patterns above are necessary but not sufficient, and the
     * gap is easy to demonstrate: the MCP route hands capabilities to
     * `McpService.handle(body, …)`, not to `execute(…)`, so reverting that one
     * line slipped past the first scan entirely. Rather than chase every call
     * name, the five files that own a transport are held to a stricter rule —
     * `auth.roles` may appear only as the value of a `roles:` field, which is
     * what the security audit log records.
     */
    const TRANSPORTS = [
      'routes/mcp.ts',
      'routes/ai.ts',
      'routes/agent.ts',
      'services/agent-run-worker.ts',
      'services/ai-chat-run-worker.ts',
    ];
    const offences: string[] = [];
    for (const rel of TRANSPORTS) {
      const file = FILES.find((f) => f.path.endsWith(rel));
      expect(file, `${rel} exists`).toBeDefined();
      const lines = file!.code.split('\n');
      lines.forEach((line, index) => {
        if (!/auth\)?\??\.roles/.test(line)) return;
        // Audit metadata: `roles: auth?.roles ?? []`.
        if (/\broles:\s*(?:c\.get\('auth'\)|auth)\??\.roles/.test(line)) return;
        offences.push(`${rel}:${index + 1} → ${line.trim()}`);
      });
    }
    expect(offences).toEqual([]);
  });

  it('every transport that executes skills imports the shared resolver', () => {
    // Positive half of the same rule: absence of the bad pattern could also mean
    // a route stopped checking capabilities altogether.
    const required = [
      'routes/mcp.ts',
      'routes/ai.ts',
      'routes/agent.ts',
      'services/agent-run-worker.ts',
      'services/ai-chat-run-worker.ts',
    ];
    const missing = required.filter((rel) => {
      const file = FILES.find((f) => f.path.endsWith(rel));
      if (!file) return true;
      return !/governed-capabilities/.test(file.source);
    });
    expect(missing).toEqual([]);
  });

  it('queue payloads carry a principal reference, not a capability snapshot', () => {
    // A snapshot stays valid while the job waits, so a revoked grant would still
    // execute. Both payload types must offer `principal`.
    const worker = FILES.find((f) => f.path.endsWith('services/agent-run-worker.ts'))!;
    expect(worker.source).toMatch(/principal\?: AuthenticatedPrincipalRef \| null/);
    const flowRuns = FILES.find((f) => f.path.endsWith('services/flow-run-service.ts'))!;
    expect(flowRuns.source).toMatch(/principal\?: AuthenticatedPrincipalRef \| null/);

    // And the enqueuing routes must actually populate it.
    const agent = FILES.find((f) => f.path.endsWith('routes/agent.ts'))!;
    expect(agent.source).toMatch(/principal: principalRefFromAuth\(auth, siteId\)/);
    const ai = FILES.find((f) => f.path.endsWith('routes/ai.ts'))!;
    expect(ai.source).toMatch(/principal: principalRefFromAuth\(auth, siteId\)/);
  });
});
