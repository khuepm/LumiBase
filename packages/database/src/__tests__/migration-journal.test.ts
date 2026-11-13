import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Journal sequencing gate.
 *
 * `scripts/migrate.ts` treats a migration as pending only when its journal
 * `when` is later than the newest applied one. Two PRs that each add the
 * "next" migration (same `idx`/`NNNN_` prefix, e.g. #792 and #795 both shipping
 * `0026_*`) therefore cannot both merge as-is: the journal gets a duplicate
 * entry, and if the later-merged one carries the earlier `when`, existing
 * environments silently skip it. Whoever merges second must take the next
 * number and a `when` later than every existing entry — this test makes that a
 * CI failure instead of a reviewer's memory.
 */

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const drizzleDir = resolve(__dirname, '../../drizzle');
const entries = (
  JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }
).entries;

describe('drizzle migration journal', () => {
  it('has contiguous idx values matching each tag prefix', () => {
    entries.forEach((entry, position) => {
      expect({ tag: entry.tag, idx: entry.idx }).toEqual({ tag: entry.tag, idx: position });
      expect(entry.tag.startsWith(`${String(position).padStart(4, '0')}_`), entry.tag).toBe(true);
    });
  });

  it('has unique tags and unique NNNN_ prefixes', () => {
    const prefixes = entries.map((e) => e.tag.slice(0, 4));
    expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
    expect(new Set(prefixes).size).toBe(entries.length);
  });

  it('has strictly increasing `when` (a later entry with an earlier `when` is skipped on migrated databases)', () => {
    for (let i = 1; i < entries.length; i += 1) {
      const prev = entries[i - 1]!;
      const cur = entries[i]!;
      expect(cur.when > prev.when, `${cur.tag} (${cur.when}) must be later than ${prev.tag} (${prev.when})`).toBe(true);
    }
  });

  it('maps every journal entry to an .sql file and every .sql file to an entry', () => {
    for (const entry of entries) {
      expect(existsSync(join(drizzleDir, `${entry.tag}.sql`)), entry.tag).toBe(true);
    }
    const sqlFiles = readdirSync(drizzleDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.replace(/\.sql$/, ''))
      .sort();
    expect(sqlFiles).toEqual(entries.map((e) => e.tag).sort());
  });
});
