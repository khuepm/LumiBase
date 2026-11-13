import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSafeSkillFilename, skillsCommand } from './skills.js';
import { parseArgs } from '../utils/args.js';

const ENV = {
  LUMIBASE_URL: 'http://localhost:1989',
  LUMIBASE_SITE_ID: 'site_abc',
  LUMIBASE_TOKEN: 'tok_abc',
};

const HOUSE_STYLE = `---
slug: house-style
name: House style
riskClass: low
surfaces: [copilot, generation]
---

# House style
Write in active voice.
`;

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumibase-skills-'));
  created.push(dir);
  return dir;
}

function write(root: string, file: string, content: string): void {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: ImportBody | undefined;
}

interface ImportBody {
  documents: { path?: string; content: string }[];
  activate?: boolean;
  dryRun?: boolean;
  updateActive?: boolean;
  source?: string;
  sourceRef?: string;
}

type Reply = { status?: number; body: unknown };

/** A fetch stand-in: records every call and answers from `respond`. */
function fakeFetch(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as ImportBody) : undefined,
    };
    calls.push(call);
    const reply = respond(call);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetcher, calls };
}

/** Answers the import endpoint with one action per document, keyed by file name. */
function importServer(actions: Record<string, string> = {}) {
  return fakeFetch((call) => ({
    body: {
      data: (call.body?.documents ?? []).map((doc) => {
        const action = actions[doc.path ?? ''] ?? 'created';
        return action === 'error'
          ? { path: doc.path, action, code: 'INVALID_DOCUMENT', message: 'Front matter is missing.' }
          : { path: doc.path, slug: doc.path?.replace(/\.skill\.md$|\.md$/, ''), action, version: 1, status: 'draft' };
      }),
      meta: {},
    },
  }));
}

function run(argv: string[], cwd: string, fetcher: typeof fetch): Promise<number> {
  return skillsCommand(parseArgs(['skills', ...argv]), { cwd, env: ENV, request: { fetcher } });
}

let out: string[];

beforeEach(() => {
  out = [];
  const capture = (...parts: unknown[]) => void out.push(parts.join(' '));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Captured output with ANSI colour codes removed. Assertions are about the
 * text, and whether picocolors emits codes depends on the environment (CI sets
 * FORCE_COLOR; a local pipe does not) — matching raw output passed locally and
 * failed in CI.
 */
// eslint-disable-next-line no-control-regex
const output = (): string => out.join('\n').replace(/\u001b\[[0-9;]*m/g, '');

describe('skills (dispatch)', () => {
  it('rejects a missing or unknown subcommand', async () => {
    const { fetcher } = fakeFetch(() => ({ body: { data: [] } }));
    await expect(run([], tempDir(), fetcher)).rejects.toThrow(/Missing skills command/);
    await expect(run(['nope'], tempDir(), fetcher)).rejects.toThrow(/Unknown skills command: nope/);
  });

  it('needs a configured connection', async () => {
    await expect(
      skillsCommand(parseArgs(['skills', 'list']), { cwd: tempDir(), env: {} }),
    ).rejects.toThrow(/Missing connection settings/);
  });
});

describe('skills list', () => {
  const SKILLS = [
    { slug: 'house-style', name: 'House style', status: 'active', riskClass: 'low', version: 3, hash: 'h1' },
    { slug: 'seo', name: 'SEO checklist', status: 'draft', riskClass: 'medium', version: 1, hash: 'h2' },
  ];

  it('prints a table and sends auth, site and the status filter', async () => {
    const { fetcher, calls } = fakeFetch(() => ({ body: { data: SKILLS } }));

    expect(await run(['list', '--status', 'active'], tempDir(), fetcher)).toBe(0);

    expect(calls[0]?.url.pathname).toBe('/api/v1/agent/skills');
    expect(calls[0]?.url.searchParams.get('status')).toBe('active');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer tok_abc');
    expect(calls[0]?.headers['X-Lumi-Site']).toBe('site_abc');
    expect(output()).toMatch(/SLUG\s+STATUS\s+VERSION\s+RISK\s+NAME/);
    expect(output()).toMatch(/house-style\s+active\s+v3\s+low\s+House style/);
    expect(output()).toMatch(/seo\s+draft\s+v1\s+medium\s+SEO checklist/);
  });

  it('--json prints the rows untouched', async () => {
    const { fetcher } = fakeFetch(() => ({ body: { data: SKILLS } }));

    expect(await run(['list', '--json'], tempDir(), fetcher)).toBe(0);
    expect(JSON.parse(output())).toEqual(SKILLS);
  });

  it('surfaces the server message and a skills-specific hint on 403', async () => {
    const { fetcher } = fakeFetch(() => ({
      status: 403,
      body: { errors: [{ code: 'FORBIDDEN', message: 'Control-plane access is required.' }] },
    }));

    const error = await run(['list'], tempDir(), fetcher).catch((err: unknown) => err);
    expect(error).toMatchObject({
      message: expect.stringMatching(/Forbidden \(403\).*Control-plane access is required\./),
      hint: expect.stringMatching(/control-plane admin/),
    });
  });
});

describe('skills pull', () => {
  const exported = (filename: string, content = HOUSE_STYLE) => ({
    slug: 'house-style',
    filename,
    status: 'active',
    version: 1,
    hash: 'h',
    content,
  });

  it('writes each skill into the default directory, then reports it unchanged', async () => {
    const cwd = tempDir();
    const { fetcher, calls } = fakeFetch(() => ({
      body: { data: [exported('house-style.skill.md'), { ...exported('seo.skill.md', '# seo\n'), slug: 'seo' }] },
    }));

    expect(await run(['pull'], cwd, fetcher)).toBe(0);
    expect(calls[0]?.url.pathname).toBe('/api/v1/agent/skills/export');
    expect(readFileSync(join(cwd, 'skills/house-style.skill.md'), 'utf8')).toBe(HOUSE_STYLE);
    expect(readFileSync(join(cwd, 'skills/seo.skill.md'), 'utf8')).toBe('# seo\n');
    expect(output()).toMatch(/2 written, 0 unchanged/);

    out.length = 0;
    expect(await run(['pull'], cwd, fetcher)).toBe(0);
    expect(output()).toMatch(/0 written, 2 unchanged/);
  });

  it('honours --dir and --status', async () => {
    const cwd = tempDir();
    const { fetcher, calls } = fakeFetch(() => ({ body: { data: [exported('house-style.skill.md')] } }));

    await run(['pull', '--dir', 'content/playbooks', '--status', 'active'], cwd, fetcher);

    expect(calls[0]?.url.searchParams.get('status')).toBe('active');
    expect(existsSync(join(cwd, 'content/playbooks/house-style.skill.md'))).toBe(true);
  });

  it.each(['../evil.md', '..', 'sub/evil.md', 'sub\\evil.md', '/etc/evil.md', '.hidden.md', 'evil.sh', ''])(
    'refuses the server-provided filename %j and writes nothing',
    async (filename) => {
      const root = tempDir();
      const cwd = join(root, 'project');
      mkdirSync(cwd);
      const { fetcher } = fakeFetch(() => ({
        body: { data: [exported('good.skill.md'), exported(filename, 'pwned')] },
      }));

      await expect(run(['pull'], cwd, fetcher)).rejects.toThrow(/Refusing to write/);

      expect(existsSync(join(cwd, 'evil.md'))).toBe(false);
      expect(existsSync(join(root, 'evil.md'))).toBe(false);
      // Validation happens before the first write — the good file is not written either.
      expect(existsSync(join(cwd, 'skills'))).toBe(false);
    },
  );

  it('isSafeSkillFilename accepts only plain .md basenames', () => {
    expect(isSafeSkillFilename('house-style.skill.md')).toBe(true);
    expect(isSafeSkillFilename('../evil.md')).toBe(false);
    expect(isSafeSkillFilename('C:evil.md')).toBe(false);
  });
});

describe('skills push', () => {
  function project(): string {
    const cwd = tempDir();
    write(cwd, 'skills/seo.skill.md', '# seo\n');
    write(cwd, 'skills/house-style.skill.md', HOUSE_STYLE);
    write(cwd, 'skills/README.md', '# not a skill\n');
    write(cwd, 'skills/notes.txt', 'not markdown');
    write(cwd, 'skills/nested/deep.skill.md', '# nested\n');
    return cwd;
  }

  it('posts the sorted *.md files with source "cli" and exits 0', async () => {
    const cwd = project();
    const { fetcher, calls } = importServer({ 'seo.skill.md': 'unchanged' });

    expect(await run(['push'], cwd, fetcher)).toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/v1/agent/skills/import');
    expect(calls[0]?.headers['Content-Type']).toBe('application/json');
    // push is the deploy path, so it may change skills that are already active.
    expect(calls[0]?.body).toEqual({
      documents: [
        { path: 'house-style.skill.md', content: HOUSE_STYLE },
        { path: 'seo.skill.md', content: '# seo\n' },
      ],
      source: 'cli',
      updateActive: true,
    });
    expect(output()).toMatch(/created\s+house-style\.skill\.md/);
    expect(output()).toMatch(/unchanged\s+seo\.skill\.md/);
    expect(output()).toMatch(/1 created, 0 updated, 1 unchanged/);
    expect(output()).toMatch(/drafts.*Mission Control → Skills/);
  });

  it('forwards --activate, --dry-run and --dir', async () => {
    const cwd = tempDir();
    write(cwd, 'playbooks/a.md', '# a\n');
    const { fetcher, calls } = importServer();

    expect(await run(['push', '--dir', 'playbooks', '--activate', '--dry-run'], cwd, fetcher)).toBe(0);

    expect(calls[0]?.body).toMatchObject({ activate: true, dryRun: true, source: 'cli' });
    expect(output()).toMatch(/would create\s+a\.md/);
    expect(output()).toMatch(/nothing was written/);
  });

  it('exits 1 when any document is rejected, and still reports the others', async () => {
    const cwd = project();
    const { fetcher } = importServer({ 'seo.skill.md': 'error' });

    expect(await run(['push'], cwd, fetcher)).toBe(1);
    expect(output()).toMatch(/created\s+house-style\.skill\.md/);
    expect(output()).toMatch(/error\s+seo\.skill\.md — INVALID_DOCUMENT: Front matter is missing\./);
    expect(output()).toMatch(/1 of 2 documents failed/);
  });

  it('--check is a dry run that exits 1 when something would change', async () => {
    const cwd = project();
    const { fetcher, calls } = importServer({ 'house-style.skill.md': 'updated', 'seo.skill.md': 'unchanged' });

    expect(await run(['push', '--check'], cwd, fetcher)).toBe(1);
    expect(calls[0]?.body?.dryRun).toBe(true);
    expect(output()).toMatch(/out of sync/);
  });

  it('--check exits 0 when everything is unchanged', async () => {
    const cwd = project();
    const { fetcher, calls } = importServer({ 'house-style.skill.md': 'unchanged', 'seo.skill.md': 'unchanged' });

    expect(await run(['push', '--check'], cwd, fetcher)).toBe(0);
    expect(calls[0]?.body?.dryRun).toBe(true);
    expect(output()).toMatch(/in sync/);
  });

  it('keeps a positional swallowed by a boolean flag from disabling the flag', async () => {
    const cwd = project();
    const { fetcher, calls } = importServer();

    // parseArgs reads this as `dry-run = "push"`.
    expect(await run(['--dry-run', 'push'], cwd, fetcher)).toBe(0);
    expect(calls[0]?.body?.dryRun).toBe(true);
  });

  it('reports an empty file as that document\'s error without failing the batch', async () => {
    const cwd = project();
    write(cwd, 'skills/blank.md', '  \n');
    const { fetcher, calls } = importServer();

    expect(await run(['push'], cwd, fetcher)).toBe(1);
    expect(calls[0]?.body?.documents.map((doc) => doc.path)).toEqual(['house-style.skill.md', 'seo.skill.md']);
    expect(output()).toMatch(/error\s+blank\.md — EMPTY_FILE/);
  });

  it('batches in chunks of at most 100 documents', async () => {
    const cwd = tempDir();
    for (let i = 0; i < 205; i++) write(cwd, `skills/s${String(i).padStart(3, '0')}.md`, `# ${i}\n`);
    const { fetcher, calls } = importServer();

    expect(await run(['push'], cwd, fetcher)).toBe(0);
    expect(calls.map((call) => call.body?.documents.length)).toEqual([100, 100, 5]);
    expect(calls[2]?.body?.documents[4]?.path).toBe('s204.md');
    expect(output()).toMatch(/205 created/);
  });

  it('fails clearly when the directory is missing or has no skill files', async () => {
    const { fetcher, calls } = importServer();
    const cwd = tempDir();

    await expect(run(['push'], cwd, fetcher)).rejects.toThrow(/Skills directory not found: skills/);

    write(cwd, 'skills/README.md', '# only a readme\n');
    await expect(run(['push'], cwd, fetcher)).rejects.toThrow(/No skill files/);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a 403 with the server message', async () => {
    const { fetcher } = fakeFetch(() => ({
      status: 403,
      body: { errors: [{ code: 'FORBIDDEN', message: 'Writing Site Skills requires a control-plane admin.' }] },
    }));

    await expect(run(['push'], project(), fetcher)).rejects.toThrow(
      /Forbidden \(403\).*Writing Site Skills requires a control-plane admin\./,
    );
  });
});

describe('skills install', () => {
  it('installs from a directory with source "cli" and the path as sourceRef', async () => {
    const cwd = tempDir();
    write(cwd, 'vendor/pack/house-style.skill.md', HOUSE_STYLE);
    const { fetcher, calls } = importServer();

    expect(await run(['install', './vendor/pack'], cwd, fetcher)).toBe(0);

    expect(calls[0]?.body).toEqual({
      documents: [{ path: 'house-style.skill.md', content: HOUSE_STYLE }],
      source: 'cli',
      sourceRef: './vendor/pack',
    });
    expect(output()).toMatch(/drafts/);
    expect(output()).toMatch(/Studio \(Mission Control → Skills\)/);
  });

  it('installs a single .md file', async () => {
    const cwd = tempDir();
    write(cwd, 'docs/README.md', HOUSE_STYLE);
    const { fetcher, calls } = importServer();

    expect(await run(['install', 'docs/README.md', '--dry-run'], cwd, fetcher)).toBe(0);
    expect(calls[0]?.body).toEqual({
      documents: [{ path: 'README.md', content: HOUSE_STYLE }],
      dryRun: true,
      source: 'cli',
      sourceRef: 'docs/README.md',
    });
  });

  it('installs from node_modules, honouring lumibase.skills and walking up from cwd', async () => {
    const root = tempDir();
    const pkg = 'node_modules/@acme/lumibase-skills';
    write(root, `${pkg}/package.json`, JSON.stringify({
      name: '@acme/lumibase-skills',
      version: '1.4.0',
      lumibase: { skills: 'playbooks' },
    }));
    write(root, `${pkg}/playbooks/house-style.skill.md`, HOUSE_STYLE);
    write(root, `${pkg}/skills/ignored.skill.md`, '# wrong dir\n');
    const cwd = join(root, 'apps/web');
    mkdirSync(cwd, { recursive: true });
    const { fetcher, calls } = importServer();

    expect(await run(['install', '@acme/lumibase-skills', '--activate'], cwd, fetcher)).toBe(0);

    expect(calls[0]?.body).toEqual({
      documents: [{ path: 'house-style.skill.md', content: HOUSE_STYLE }],
      activate: true,
      source: 'package',
      sourceRef: '@acme/lumibase-skills@1.4.0',
    });
    // Activated on install — no "arrive as drafts" note.
    expect(output()).not.toMatch(/drafts/);
  });

  it('defaults to the package\'s skills/ directory', async () => {
    const cwd = tempDir();
    write(cwd, 'node_modules/acme-skills/package.json', JSON.stringify({ name: 'acme-skills', version: '0.2.1' }));
    write(cwd, 'node_modules/acme-skills/skills/seo.skill.md', '# seo\n');
    const { fetcher, calls } = importServer();

    // A boolean flag directly before the positional must not swallow it.
    expect(await run(['install', '--dry-run', 'acme-skills'], cwd, fetcher)).toBe(0);
    expect(calls[0]?.body).toMatchObject({
      documents: [{ path: 'seo.skill.md' }],
      dryRun: true,
      source: 'package',
      sourceRef: 'acme-skills@0.2.1',
    });
  });

  it('refuses a lumibase.skills path that escapes the package', async () => {
    const cwd = tempDir();
    write(cwd, 'secrets/key.md', 'secret');
    write(cwd, 'node_modules/evil/package.json', JSON.stringify({
      name: 'evil',
      version: '1.0.0',
      lumibase: { skills: '../../secrets' },
    }));
    const { fetcher, calls } = importServer();

    await expect(run(['install', 'evil'], cwd, fetcher)).rejects.toThrow(/outside the package/);
    expect(calls).toHaveLength(0);
  });

  it('fails with an install hint when the package is not installed', async () => {
    const { fetcher, calls } = importServer();

    const error = await run(['install', '@acme/missing'], tempDir(), fetcher).catch((err: unknown) => err);
    expect(error).toMatchObject({
      message: expect.stringMatching(/Package @acme\/missing is not installed/),
      hint: expect.stringMatching(/npm install --save-dev @acme\/missing/),
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a missing path and a missing <source>', async () => {
    const { fetcher } = importServer();
    await expect(run(['install', './nope'], tempDir(), fetcher)).rejects.toThrow(/Nothing to install/);
    await expect(run(['install'], tempDir(), fetcher)).rejects.toThrow(/Missing <source>/);
  });

  it('exits 1 when the server rejects a document', async () => {
    const cwd = tempDir();
    write(cwd, 'pack/bad.md', 'no front matter');
    const { fetcher } = importServer({ 'bad.md': 'error' });

    expect(await run(['install', 'pack'], cwd, fetcher)).toBe(1);
  });

  it('never asks to change active skills, and explains the refusal when the server sends one', async () => {
    const cwd = tempDir();
    write(cwd, 'pack/house-style.skill.md', HOUSE_STYLE);
    const { fetcher, calls } = fakeFetch((call) => ({
      body: {
        data: (call.body?.documents ?? []).map((doc) => ({
          path: doc.path,
          slug: 'house-style',
          action: 'error',
          code: 'ACTIVE_SKILL_CHANGE',
          message: 'Skill "house-style" is active; this import would change live agent behaviour.',
        })),
        meta: {},
      },
    }));

    expect(await run(['install', 'pack', '--activate'], cwd, fetcher)).toBe(1);
    expect(calls[0]?.body).not.toHaveProperty('updateActive');
    expect(output()).toMatch(/error\s+house-style\.skill\.md — ACTIVE_SKILL_CHANGE/);
    expect(output()).toMatch(/never changed by install.*lumibase skills push/);
  });
});
