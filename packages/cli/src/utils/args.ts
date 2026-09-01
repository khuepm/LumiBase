export interface ParsedArgs {
  /** Positional arguments, command name included. */
  _: string[];
  [key: string]: string | boolean | string[] | undefined;
}

/**
 * Minimal arg parser — avoids pulling in minimist/yargs for a small CLI.
 * Supports: positionals, `--flag`, `--flag=value`, `--flag value`, `--no-flag`,
 * and `-h` / `-v` short forms. Everything after a bare `--` is passed through
 * as positionals so subcommands can forward their own flags.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { _: [] };
  const passthrough: string[] = [];
  let afterDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (afterDoubleDash) {
      passthrough.push(arg);
      continue;
    }

    if (arg === '--') {
      afterDoubleDash = true;
      continue;
    }

    if (arg === '-h') {
      result['help'] = true;
      continue;
    }

    if (arg === '-v') {
      result['version'] = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const raw = arg.slice(2);

      // `--no-install` is a flag named `no-install`, not a negation of `install`.
      // Callers read both names explicitly; keeping the raw key avoids guessing.
      if (raw.startsWith('no-')) {
        result[raw] = true;
        continue;
      }

      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        result[raw.slice(0, eqIdx)] = raw.slice(eqIdx + 1);
        continue;
      }

      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        result[raw] = next;
        i++;
      } else {
        result[raw] = true;
      }
      continue;
    }

    result._.push(arg);
  }

  if (passthrough.length > 0) {
    result._.push(...passthrough);
  }

  return result;
}

/**
 * Everything after the first positional argument, verbatim. Subcommands that
 * delegate to another executable forward this so their flags reach the child
 * untouched instead of being reinterpreted by {@link parseArgs}.
 */
export function argvAfterCommand(argv: string[]): string[] {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg.startsWith('-')) {
      // Mirror parseArgs: a `--flag value` pair consumes the next token too.
      if (arg.startsWith('--') && !arg.includes('=') && !arg.startsWith('--no-')) {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) i++;
      }
      continue;
    }

    return argv.slice(i + 1);
  }

  return [];
}

/** Reads a flag that must carry a string value; `--flag` with no value is an error. */
export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Flag --${name} needs a value (e.g. --${name}=<value>).`);
  }
  return value;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args[name] === true || args[name] === 'true';
}
