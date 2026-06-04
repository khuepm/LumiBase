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

  it('returns the first visible option for dialog defaults', () => {
    expect(firstCollectionOption(buildAccessCollectionGroups(['posts'], false))).toBe('posts');
  });
});
