import { describe, expect, it } from 'vitest';
import { argvAfterCommand, boolFlag, parseArgs, stringFlag } from './args.js';

describe('parseArgs', () => {
  it('collects positionals in order', () => {
    expect(parseArgs(['types', 'extra'])._).toEqual(['types', 'extra']);
  });

  it('supports --flag=value and --flag value', () => {
    const args = parseArgs(['types', '--out=a.d.ts', '--url', 'http://localhost:1989']);
    expect(args['out']).toBe('a.d.ts');
    expect(args['url']).toBe('http://localhost:1989');
    expect(args._).toEqual(['types']);
  });

  it('treats a trailing --flag as a boolean', () => {
    expect(parseArgs(['types', '--check'])['check']).toBe(true);
  });

  it('keeps --no-* as its own key rather than negating', () => {
    const args = parseArgs(['types', '--no-branded']);
    expect(args['no-branded']).toBe(true);
    expect(args['branded']).toBeUndefined();
  });

  it('maps -h and -v to help and version', () => {
    expect(parseArgs(['-h'])['help']).toBe(true);
    expect(parseArgs(['-v'])['version']).toBe(true);
  });

  it('passes everything after -- through as positionals', () => {
    expect(parseArgs(['init', '--', '--pm', 'bun'])._).toEqual(['init', '--pm', 'bun']);
  });
});

describe('argvAfterCommand', () => {
  it('returns the tokens after the first positional', () => {
    expect(argvAfterCommand(['init', 'my-site', '--pm', 'pnpm'])).toEqual([
      'my-site',
      '--pm',
      'pnpm',
    ]);
  });

  it('skips a leading flag and the value it consumes', () => {
    expect(argvAfterCommand(['--url', 'http://x', 'init', 'my-site'])).toEqual(['my-site']);
  });

  it('does not treat --flag=value as consuming the next token', () => {
    expect(argvAfterCommand(['--url=http://x', 'init', 'my-site'])).toEqual(['my-site']);
  });

  it('returns nothing when there is no positional', () => {
    expect(argvAfterCommand(['--help'])).toEqual([]);
  });
});

describe('stringFlag / boolFlag', () => {
  it('reads a string flag', () => {
    expect(stringFlag(parseArgs(['types', '--out', 'x.d.ts']), 'out')).toBe('x.d.ts');
  });

  it('rejects a value-less flag that needs a value', () => {
    expect(() => stringFlag(parseArgs(['types', '--out']), 'out')).toThrow(/needs a value/);
  });

  it('returns undefined for an absent flag', () => {
    expect(stringFlag(parseArgs(['types']), 'out')).toBeUndefined();
  });

  it('reads boolean flags', () => {
    expect(boolFlag(parseArgs(['types', '--check']), 'check')).toBe(true);
    expect(boolFlag(parseArgs(['types']), 'check')).toBe(false);
  });
});
