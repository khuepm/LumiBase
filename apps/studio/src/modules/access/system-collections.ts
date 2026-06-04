export type AccessCollectionGroupId = 'content' | 'schema' | 'access' | 'sensitive';

export type AccessCollectionOption = {
  name: string;
  group: AccessCollectionGroupId;
  label: string;
  sensitive: boolean;
  fromSystemContract: boolean;
};

export type AccessCollectionGroup = {
  id: AccessCollectionGroupId;
  label: string;
  hint: string;
  options: AccessCollectionOption[];
};

const SCHEMA_COLLECTIONS = ['collections', 'fields', 'relations', 'materialized_collections'] as const;
const ACCESS_COLLECTIONS = [
  'roles',
  'policies',
  'role_policies',
  'user_roles',
  'user_policies',
  'permissions',
] as const;
const SENSITIVE_COLLECTIONS = [
  'system_state',
  'audit_log',
  'login_attempts',
  'login_baselines',
  'admin_backup_codes',
  'scim_tokens',
  'api_keys',
  'api_key_roles',
  'api_key_policies',
] as const;

const SYSTEM_CONTRACT_COLLECTIONS = [
  ...SCHEMA_COLLECTIONS,
  ...ACCESS_COLLECTIONS,
  ...SENSITIVE_COLLECTIONS,
] as const;

const SCHEMA_SET = new Set<string>(SCHEMA_COLLECTIONS);
const ACCESS_SET = new Set<string>(ACCESS_COLLECTIONS);
const SENSITIVE_SET = new Set<string>(SENSITIVE_COLLECTIONS);
const SYSTEM_CONTRACT_SET = new Set<string>(SYSTEM_CONTRACT_COLLECTIONS);

export const ACCESS_COLLECTION_GROUPS: Record<AccessCollectionGroupId, Omit<AccessCollectionGroup, 'options'>> = {
  content: {
    id: 'content',
    label: 'Content collections',
    hint: 'Project content and custom collections returned by the schema API.',
  },
  schema: {
    id: 'schema',
    label: 'Schema builder',
    hint: 'Collections, fields, and relations that shape the data model.',
  },
  access: {
    id: 'access',
    label: 'Access control',
    hint: 'Roles, policies, bindings, and permission rows.',
  },
  sensitive: {
    id: 'sensitive',
    label: 'Sensitive system',
    hint: 'Security state, audit trails, backup codes, and API key metadata.',
  },
};

export function buildAccessCollectionGroups(
  collectionNames: string[],
  isAdmin: boolean,
): AccessCollectionGroup[] {
  const names = new Set<string>([
    ...collectionNames.map((name) => name.trim()).filter(Boolean),
    ...SYSTEM_CONTRACT_COLLECTIONS,
  ]);

  const grouped: Record<AccessCollectionGroupId, AccessCollectionOption[]> = {
    content: [],
    schema: [],
    access: [],
    sensitive: [],
  };

  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const sensitive = SENSITIVE_SET.has(name);
    if (sensitive && !isAdmin) continue;

    const group = collectionGroupFor(name);
    grouped[group].push({
      name,
      group,
      label: name,
      sensitive,
      fromSystemContract: SYSTEM_CONTRACT_SET.has(name),
    });
  }

  return (['content', 'schema', 'access', 'sensitive'] as const)
    .map((id) => ({ ...ACCESS_COLLECTION_GROUPS[id], options: grouped[id] }))
    .filter((group) => group.options.length > 0);
}

export function firstCollectionOption(groups: AccessCollectionGroup[]): string {
  return groups[0]?.options[0]?.name ?? '';
}

function collectionGroupFor(name: string): AccessCollectionGroupId {
  if (SENSITIVE_SET.has(name)) return 'sensitive';
  if (ACCESS_SET.has(name)) return 'access';
  if (SCHEMA_SET.has(name)) return 'schema';
  return 'content';
}
