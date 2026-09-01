import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, findConfigFile, requireConnection, resolveConfig } from './config.js';
import { parseArgs } from './utils/args.js';

const created: string[] = [];

function tempProject(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumibase-cli-'));
  created.push(dir);
  if (config) {
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify(config), 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('findConfigFile', () => {
  it('finds the config in a parent directory', () => {
    const root = tempProject({ url: 'http://localhost:1989' });
    const nested = join(root, 'apps', 'web');
    mkdirSync(nested, { recursive: true });

    expect(findConfigFile(nested)).toBe(join(root, CONFIG_FILENAME));
  });

  it('returns undefined when there is no config anywhere above', () => {
    expect(findConfigFile(tempProject())).toBeUndefined();
  });
});

describe('resolveConfig', () => {
  it('prefers flags over environment over file', () => {
    const dir = tempProject({ url: 'http://from-file', siteId: 'site_file' });

    const config = resolveConfig(parseArgs(['types', '--url', 'http://from-flag']), {
      cwd: dir,
      env: { LUMIBASE_URL: 'http://from-env', LUMIBASE_SITE_ID: 'site_env' },
    });

    expect(config.url).toBe('http://from-flag');
    expect(config.sources.url).toBe('flag');
    expect(config.siteId).toBe('site_env');
    expect(config.sources.siteId).toBe('env');
  });

  it('falls back to the file when nothing else is set', () => {
    const dir = tempProject({ url: 'http://from-file/', siteId: 'site_file' });

    const config = resolveConfig(parseArgs(['types']), { cwd: dir, env: {} });

    expect(config.url).toBe('http://from-file');
    expect(config.sources.url).toBe('file');
    expect(config.siteId).toBe('site_file');
  });

  it('reads the token from the environment only', () => {
    const dir = tempProject({ url: 'http://from-file' });

    const config = resolveConfig(parseArgs(['types']), {
      cwd: dir,
      env: { LUMIBASE_TOKEN: 'tok_abc' },
    });

    expect(config.token).toBe('tok_abc');
    expect(config.sources.token).toBe('env');
  });

  it('refuses a token stored in the config file', () => {
    const dir = tempProject({ url: 'http://from-file', token: 'tok_leaked' });

    expect(() => resolveConfig(parseArgs(['types']), { cwd: dir, env: {} })).toThrow(
      /must not contain a "token"/,
    );
  });

  it('reads the typegen section', () => {
    const dir = tempProject({
      url: 'http://from-file',
      typegen: { out: 'src/types.d.ts', exclude: ['drafts'], branded: false },
    });

    const config = resolveConfig(parseArgs(['types']), { cwd: dir, env: {} });

    expect(config.typegen.out).toBe('src/types.d.ts');
    expect(config.typegen.exclude).toEqual(['drafts']);
    expect(config.typegen.branded).toBe(false);
  });

  it('rejects a config file that is not valid JSON', () => {
    const dir = tempProject();
    writeFileSync(join(dir, CONFIG_FILENAME), '{ not json', 'utf8');

    expect(() => resolveConfig(parseArgs(['types']), { cwd: dir, env: {} })).toThrow(
      /not valid JSON/,
    );
  });
});

describe('requireConnection', () => {
  it('names every missing setting at once', () => {
    const config = resolveConfig(parseArgs(['types']), { cwd: tempProject(), env: {} });

    expect(() => requireConnection(config)).toThrow(/url.*siteId.*token/s);
  });

  it('passes when all three are present', () => {
    const config = resolveConfig(parseArgs(['types']), {
      cwd: tempProject(),
      env: {
        LUMIBASE_URL: 'http://localhost:1989',
        LUMIBASE_SITE_ID: 'site_1',
        LUMIBASE_TOKEN: 'tok_1',
      },
    });

    expect(() => requireConnection(config)).not.toThrow();
  });
});
