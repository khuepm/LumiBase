import { spawnSync } from "node:child_process";
import process from "node:process";
import { CliError } from "../errors.js";
import { readVersion } from "../version.js";

export interface ScaffoldCommand {
  command: string;
  args: string[];
}

/**
 * Builds the command that runs `create-lumibase` on demand.
 *
 * `lumibase init` deliberately delegates instead of re-implementing the
 * scaffold: `npm create lumibase` and `lumibase init` must never drift. The
 * scaffolder is *not* a dependency of this package, though — `lumibase` is
 * meant to sit in a project's `dependencies` (it re-exports the SDK), and
 * pulling handlebars/prompts/execa into every install for a command that runs
 * once per project is the wrong trade. The scaffolder is fetched through the
 * invoking package manager's one-off runner instead, pinned to the CLI's own
 * version so both binaries always come from the same release.
 */
export function resolveScaffoldCommand(
  version: string,
  userAgent: string = process.env["npm_config_user_agent"] ?? "",
): ScaffoldCommand {
  const pkg = `create-lumibase@${version}`;
  const [name = "", ver = ""] = userAgent.split(" ")[0]?.split("/") ?? [];
  const major = Number(ver.split(".")[0]);

  switch (name) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx", pkg] };
    case "yarn":
      // Yarn 1 (classic) has no `dlx`; fall through to npx for it.
      if (major >= 2) return { command: "yarn", args: ["dlx", pkg] };
      return { command: "npx", args: ["--yes", pkg] };
    case "bun":
      return { command: "bunx", args: [pkg] };
    default:
      return { command: "npx", args: ["--yes", pkg] };
  }
}

export interface InitCommandOptions {
  /** Injected in tests; defaults to this package's own version. */
  version?: string;
  /** Injected in tests; defaults to `npm_config_user_agent`. */
  userAgent?: string;
  /** Injected in tests; defaults to spawning a real child process. */
  run?: (command: string, args: string[]) => number;
}

export function initCommand(
  argv: string[],
  options: InitCommandOptions = {},
): number {
  const scaffold = resolveScaffoldCommand(
    options.version ?? readVersion(),
    options.userAgent,
  );

  const run =
    options.run ??
    ((command: string, args: string[]): number => {
      const result = spawnSync(command, args, {
        stdio: "inherit",
        // npx/pnpm/yarn/bunx are `.cmd` shims on Windows; a shell resolves them.
        shell: process.platform === "win32",
      });
      if (result.error) {
        throw new CliError(
          `Failed to run the scaffolder: ${result.error.message}`,
          "Run `npm create lumibase@latest` directly.",
        );
      }
      return result.status ?? 1;
    });

  return run(scaffold.command, [...scaffold.args, ...argv]);
}
