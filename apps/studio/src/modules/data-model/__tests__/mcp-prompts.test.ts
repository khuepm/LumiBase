import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPromptLanguage, localizePrompt, MCP_PROMPT_CATEGORIES, MCP_PROMPTS } from '../mcp-prompts';

const TOOLS_DIR = path.resolve(__dirname, '../../../../../../packages/mcp-server/src/tools');

function registeredTools(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(TOOLS_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(path.join(TOOLS_DIR, file), 'utf8');
    for (const match of source.matchAll(/registerTool\(\s*['"]([a-z_]+)['"]/g)) names.add(match[1]!);
  }
  return names;
}

describe('MCP starter prompts', () => {
  const tools = registeredTools();

  it('finds the stdio server tool registry', () => {
    expect(tools.size).toBeGreaterThan(20);
  });

  it.each(MCP_PROMPTS.map((p) => [p.id, p] as const))('%s only references registered tools', (_id, prompt) => {
    expect(prompt.tools.length).toBeGreaterThan(0);
    for (const tool of prompt.tools) expect(tools, `unknown tool "${tool}"`).toContain(tool);
  });

  it('has unique ids and every category is populated', () => {
    expect(new Set(MCP_PROMPTS.map((p) => p.id)).size).toBe(MCP_PROMPTS.length);
    for (const category of MCP_PROMPT_CATEGORIES) {
      expect(MCP_PROMPTS.some((p) => p.category === category.id)).toBe(true);
    }
  });

  it('labels prompts that use mutating schema tools as admin', () => {
    for (const prompt of MCP_PROMPTS) {
      if (prompt.tools.includes('apply_schema')) expect(prompt.access).toBe('admin');
    }
  });

  describe('Vietnamese versions', () => {
    const quoted = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    const placeholders = (text: string) => text.match(/<[^>]+>/g)?.length ?? 0;

    it.each(MCP_PROMPTS.map((p) => [p.id, p] as const))('%s is translated without losing identifiers', (_id, prompt) => {
      expect(prompt.vi.title.trim()).not.toBe('');
      expect(prompt.vi.prompt.trim()).not.toBe('');
      expect(prompt.vi.prompt).not.toBe(prompt.prompt);
      // Collection names and values in quotes are identifiers the tools match on — never translate them.
      expect(quoted(prompt.vi.prompt)).toEqual(quoted(prompt.prompt));
      expect(placeholders(prompt.vi.prompt)).toBe(placeholders(prompt.prompt));
    });

    it('localizes title and prompt together', () => {
      const p = MCP_PROMPTS[0]!;
      expect(localizePrompt(p, 'en')).toEqual({ title: p.title, prompt: p.prompt });
      expect(localizePrompt(p, 'vi')).toEqual(p.vi);
    });

    it.each([
      ['vi', 'vi'],
      ['vi-VN', 'vi'],
      ['VI', 'vi'],
      ['en', 'en'],
      ['fr', 'en'],
      [undefined, 'en'],
    ] as const)('maps UI language %s to %s', (ui, expected) => {
      expect(defaultPromptLanguage(ui)).toBe(expected);
    });
  });
});
