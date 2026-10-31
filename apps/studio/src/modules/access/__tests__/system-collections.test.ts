import { describe, expect, it } from 'vitest';
import { buildAccessCollectionGroups, firstCollectionOption } from '../system-collections';

function optionNames(isAdmin: boolean) {
  return buildAccessCollectionGroups(['posts', 'authors', 'api_keys'], isAdmin)
    .flatMap((group) => group.options.map((option) => option.name));
}

describe('access system collection grouping', () => {
  it('groups schema and access manager collections from the system contract', () => {
    const groups = buildAccessCollectionGroups(['posts'], false);
    const byId = new Map(groups.map((group) => [group.id, group]));

    expect(byId.get('content')?.options.map((option) => option.name)).toContain('posts');
    expect(byId.get('schema')?.options.map((option) => option.name)).toEqual(
      expect.arrayContaining(['collections', 'fields', 'relations']),
    );
    expect(byId.get('access')?.options.map((option) => option.name)).toEqual(
      expect.arrayContaining(['roles', 'policies', 'permissions']),
    );
    expect(byId.get('extension')?.options.map((option) => option.name)).toEqual(
      expect.arrayContaining([
        'extensions',
        'extension_modules',
        'extension_endpoints',
        'extension_operations',
      ]),
    );
  });

  it('hides sensitive system collections from non-admin principals', () => {
    expect(optionNames(false)).not.toEqual(expect.arrayContaining([
      'system_state',
      'audit_log',
      'login_attempts',
      'admin_backup_codes',
      'scim_tokens',
      'api_keys',
    ]));
  });

  it('shows sensitive system collections to admin principals only', () => {
    const groups = buildAccessCollectionGroups(['posts'], true);
    const sensitive = groups.find((group) => group.id === 'sensitive');

    expect(sensitive?.options.map((option) => option.name)).toEqual(
      expect.arrayContaining([
        'system_state',
        'audit_log',
        'login_attempts',
        'admin_backup_codes',
        'scim_tokens',
        'api_keys',
      ]),
    );
  });

  it('lists the AI decision capability in its own group, before sensitive, for non-admins too (#511)', () => {
    for (const isAdmin of [false, true]) {
      const groups = buildAccessCollectionGroups([], isAdmin);
      const ids = groups.map((group) => group.id);
      const ai = groups.find((group) => group.id === 'ai');

      expect(ai?.label).toBe('AI usage');
      expect(ai?.options).toEqual([
        expect.objectContaining({ name: 'lumibase_ai_decisions', label: 'AI decisions', fromSystemContract: true, sensitive: false }),
      ]);
      if (isAdmin) expect(ids.indexOf('ai')).toBeLessThan(ids.indexOf('sensitive'));
      expect(ids.indexOf('ai')).toBeGreaterThan(ids.indexOf('extension'));
    }
  });

  it('keeps the collection name as the label when there is no system label', () => {
    const content = buildAccessCollectionGroups(['posts'], false).find((group) => group.id === 'content');
    expect(content?.options[0]).toMatchObject({ name: 'posts', label: 'posts' });
  });

  it('returns the first visible option for dialog defaults', () => {
    expect(firstCollectionOption(buildAccessCollectionGroups(['posts'], false))).toBe('posts');
  });
});
