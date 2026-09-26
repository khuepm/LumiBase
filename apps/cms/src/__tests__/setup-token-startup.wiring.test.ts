import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The setup token is minted by startup, not merely mintable (#470).
 *
 * ## The defect
 *
 * `printSetupTokenIfRequired` generated a token, stored its hash and printed it
 * — and had no caller. The read side (`/setup/state` reporting
 * `requiresSetupToken`, `/setup/complete` demanding the token) was fully wired,
 * so `LUMIBASE_REQUIRE_SETUP_TOKEN=true` locked every instance out: the system
 * checked a token that nothing produced. The helper's behaviour was never the
 * failure mode; not being called was. Same class as #455 (`goal-dispatch-
 * wiring.test.ts`): correct in isolation, unreachable in production.
 *
 * ## What is pinned here
 *
 * `setup-token-startup.test.ts` proves `runSetupTokenStartup` prints the token
 * and stores its hash. This file proves the Node/Docker entrypoint actually
 * awaits it — in the HTTP branch, before the server listens — and that the
 * flag has exactly one parser, so the checking side and the minting side cannot
 * drift apart on a value like `1`.
 *
 * Evidence class: source scan of the real files. No process is started.
 *
 * **Validates: admin-setup-wizard Req 2.6 — the token is generated at startup**
 */

const SRC = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('serve.ts mints the setup token at startup', () => {
  const serve = read('serve.ts');

  it('imports the startup step', () => {
    expect(serve).toMatch(
      /import \{ runSetupTokenStartup \} from '\.\/modules\/setup\/startup';/,
    );
  });

  it('awaits it inside the HTTP branch, before the server starts listening', () => {
    const call = serve.indexOf('await runSetupTokenStartup(');
    const httpBranch = serve.indexOf('if (runHttp) {');
    const listen = serve.indexOf('server = serve({');

    expect(call, 'serve.ts must await runSetupTokenStartup(...)').toBeGreaterThan(-1);
    expect(httpBranch).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    // Inside the branch that serves `/setup`, and before `serve()` — a setup
    // request must not be able to reach a process that has not minted yet.
    expect(call).toBeGreaterThan(httpBranch);
    expect(call).toBeLessThan(listen);
    // Exactly once: a second call site would be a second place to keep right.
    expect(serve.split('runSetupTokenStartup(').length - 1).toBe(1);
  });

  it('hands it the process environment, where the flag is set', () => {
    const call = serve.slice(serve.indexOf('await runSetupTokenStartup('));
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toContain('env: process.env');
  });
});

describe('LUMIBASE_REQUIRE_SETUP_TOKEN has one parser', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('only setup-token.ts reads the variable by name', () => {
    // A string literal or a property access is a read; a mention in a comment
    // (usually in markdown backticks) is not, so comments are stripped first.
    const readsFlag = /['"`]LUMIBASE_REQUIRE_SETUP_TOKEN['"`]|\.LUMIBASE_REQUIRE_SETUP_TOKEN\b/;
    const withoutComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const readers = walk(SRC)
      .filter((file) => readsFlag.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC, file).split(sep).join('/'));
    expect(readers).toEqual(['modules/setup/setup-token.ts']);
  });

  it('the request path and the startup step both use isSetupTokenRequired', () => {
    expect(read('modules/setup/routes.ts')).toMatch(/isSetupTokenRequired\(/);
    expect(read('modules/setup/startup.ts')).toMatch(/isSetupTokenRequired\(deps\.env\)/);
  });
});
