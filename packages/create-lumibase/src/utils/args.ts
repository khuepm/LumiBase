export interface ParsedArgs {
  _: string[];
  template?: string;
  pm?: string;
  install?: boolean;
  'no-install'?: boolean;
  git?: boolean;
  'no-git'?: boolean;
  [key: string]: unknown;
}

/**
 * Minimal arg parser — avoids pulling in minimist/yargs for a tiny CLI.
 * Supports: positional args, --flag, --flag=value, --no-flag
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg.startsWith('--')) {
      const raw = arg.slice(2);

      if (raw.startsWith('no-')) {
        result[raw] = true;
        continue;
      }

      const eqIdx = raw.indexOf('=');
      if (eqIdx !== -1) {
        const key = raw.slice(0, eqIdx);
        const val = raw.slice(eqIdx + 1);
        result[key] = val;
        continue;
      }

      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        result[raw] = next;
        i++;
      } else {
        result[raw] = true;
      }
    } else {
      result._.push(arg);
    }
  }

  return result;
}
