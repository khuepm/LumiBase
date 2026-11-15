export interface ParsedArgs {
  _: string[];
  template?: string;
  pm?: string;
  install?: boolean;
  'no-install'?: boolean;
  git?: boolean;
  'no-git'?: boolean;
  help?: boolean;
  [key: string]: unknown;
}

/**
 * Minimal arg parser — avoids pulling in minimist/yargs for a tiny CLI.
 * Supports: positional args, --flag, --flag=value, --no-flag, -h
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { _: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    // `-h` is the only short flag. Without this it would be taken for a
    // project name and scaffold a directory called `-h`.
    // `--help` never takes a value: `--help my-site` must not eat the name.
    if (arg === '-h' || arg === '--help') {
      result.help = true;
      continue;
    }

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
