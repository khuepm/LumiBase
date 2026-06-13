import { describe, it, expect } from 'vitest';
import { parseArgs } from './args.js';

describe('parseArgs', () => {
  it('collects positional args', () => {
    expect(parseArgs(['my-blog'])._).toEqual(['my-blog']);
  });

  it('parses --flag value pairs', () => {
    const r = parseArgs(['my-blog', '--template', 'cloudflare']);
    expect(r._).toEqual(['my-blog']);
    expect(r.template).toBe('cloudflare');
  });

  it('parses --flag=value form', () => {
    expect(parseArgs(['--pm=pnpm']).pm).toBe('pnpm');
  });

  it('treats --no-* as a boolean true', () => {
    const r = parseArgs(['--no-install', '--no-git']);
    expect(r['no-install']).toBe(true);
    expect(r['no-git']).toBe(true);
  });

  it('treats a trailing --flag with no value as boolean true', () => {
    expect(parseArgs(['--install']).install).toBe(true);
  });

  it('does not consume the next flag as a value', () => {
    const r = parseArgs(['--install', '--template', 'default']);
    expect(r.install).toBe(true);
    expect(r.template).toBe('default');
  });

  it('handles a realistic full invocation', () => {
    const r = parseArgs([
      'my-blog',
      '--template',
      'default',
      '--pm',
      'pnpm',
      '--no-install',
    ]);
    expect(r._).toEqual(['my-blog']);
    expect(r.template).toBe('default');
    expect(r.pm).toBe('pnpm');
    expect(r['no-install']).toBe(true);
  });
});
