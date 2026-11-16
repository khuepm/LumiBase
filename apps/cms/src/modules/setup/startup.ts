/**
 * Setup-token step of the Node/Docker startup sequence (Req 2.6, #470).
 *
 * `serve.ts` awaits {@link runSetupTokenStartup} in every process that
 * serves HTTP, before it starts listening. It is a separate module so the
 * step can be tested the way it actually runs — flag parsing, the DB write,
 * the printed line and the operator notices together — rather than only by
 * calling the mint helper directly, which is how #470 stayed green: the
 * helper was correct and nothing called it.
 *
 * Runtime split: Cloudflare Workers have no process startup, so nothing
 * there calls this. With the flag on and no token minted, `POST
 * /setup/complete` answers `SETUP_TOKEN_NOT_ISSUED` with an actionable
 * message instead of an unexplained `SETUP_TOKEN_REQUIRED`.
 */

import type { Database } from '@lumibase/database';
import {
  REQUIRE_SETUP_TOKEN_ENV,
  isSetupTokenRequired,
  printSetupTokenIfRequired,
} from './setup-token';

export type SetupTokenStartupOutcome = Awaited<ReturnType<typeof printSetupTokenIfRequired>>;

export interface SetupTokenStartupDeps {
  readonly db: Database;
  /** The process environment (`process.env` on Node). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** stdout sink for the token line and its hint. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
  /** Sink for operator warnings. Defaults to `console.warn`. */
  readonly warn?: (line: string) => void;
}

/**
 * SQL an operator runs to discard a token whose plaintext was lost. The next
 * start then mints and prints a fresh one. Exported so the docs and the test
 * quote the same statement the process prints.
 */
export const CLEAR_SETUP_TOKEN_SQL =
  "UPDATE lumibase_system_state SET setup_token_hash = NULL WHERE id = 'singleton';";

/**
 * Mint and print the setup token when the gate is on and setup is pending.
 *
 * Never throws for a normal outcome. A database failure is rethrown with
 * context: the operator asked for the gate, and an instance that cannot
 * issue its token cannot be set up at all, so failing the start is louder
 * and earlier than discovering it at `/setup/complete`.
 */
export async function runSetupTokenStartup(
  deps: SetupTokenStartupDeps,
): Promise<SetupTokenStartupOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));

  let outcome: SetupTokenStartupOutcome;
  try {
    outcome = await printSetupTokenIfRequired({
      db: deps.db,
      requireSetupToken: isSetupTokenRequired(deps.env),
      print: log,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[lumibase-cms] ${REQUIRE_SETUP_TOKEN_ENV} is on but the setup token could not be issued: ${reason}`,
      { cause: err },
    );
  }

  if (outcome === 'minted') {
    log(
      '[lumibase-cms] Setup is gated by the one-time token above. It is printed once and ' +
        'not stored in plaintext — keep it until setup is complete.',
    );
  } else if (outcome === 'already_minted') {
    // The hash from an earlier start is still there and its plaintext is not
    // recoverable. Without this line the log would be silent and the operator
    // would be back to #470: a gate demanding a token nobody can produce.
    warn(
      `[lumibase-cms] ${REQUIRE_SETUP_TOKEN_ENV} is on and a setup token was already issued by an ` +
        'earlier start; its plaintext is not stored, so it is not printed again. If you no longer ' +
        `have it, run \`${CLEAR_SETUP_TOKEN_SQL}\` against this database and restart the CMS.`,
    );
  }

  return outcome;
}
