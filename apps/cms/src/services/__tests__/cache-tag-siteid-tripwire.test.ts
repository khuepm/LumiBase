/**
 * Tripwire: cache tag literals in CMS services must include siteId (task 8.5/9.5).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVICES_ROOT = join(__dirname, '..');

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...walkTsFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Tag prefixes that must be tenant-scoped in production writers. */
const SCOPED_TAG_PREFIXES = ['items:', 'deliver:', 'schema:', 'perm:', 'perm-ver:'] as const;

function lineHasSiteIdReference(line: string): boolean {
  return /siteId|site_id|this\.deps\.siteId|ctx\.siteId|c\.get\(['"]siteId['"]\)/.test(line);
}

function extractStringLiterals(line: string): string[] {
  const literals: string[] = [];
  const patterns = [
    /'([^'\\]*(?:\\.[^'\\]*)*)'/g,
    /"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /`([^`\\]*(?:\\.[^`\\]*)*)`/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      literals.push(match[1] ?? '');
    }
  }
  return literals;
}

describe('cache tag tenant-prefix tripwire', () => {
  it('scoped tag literals in services reference siteId', () => {
    const violations: string[] = [];

    for (const file of walkTsFiles(SERVICES_ROOT)) {
      const rel = file.slice(SERVICES_ROOT.length + 1);
      const lines = readFileSync(file, 'utf8').split('\n');

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (!line.includes('invalidateByTag') && !line.includes('tags:')) continue;

        for (const literal of extractStringLiterals(line)) {
          const prefix = SCOPED_TAG_PREFIXES.find((p) => literal.startsWith(p));
          if (!prefix) continue;
          if (literal.includes('${')) continue;
          if (lineHasSiteIdReference(line)) continue;
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
