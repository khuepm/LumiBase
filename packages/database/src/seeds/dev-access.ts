export const DEV_SITE_ID = 'site_demo';

export const DEV_ACCESS_ROLE_IDS = {
  administrator: 'role_administrator',
} as const;

export const DEV_ACCESS_POLICY_IDS = {
  admin: 'policy_admin',
  accessManager: 'policy_access_manager',
  schemaManager: 'policy_schema_manager',
  securityManager: 'policy_security_manager',
  extensionManager: 'policy_extension_manager',
  studioSelf: 'policy_studio_self',
  public: 'policy_public',
} as const;

export const DEV_SCHEMA_MANAGER_COLLECTIONS = [
  'collections',
  'fields',
  'relations',
] as const;

export const DEV_ACCESS_MANAGER_COLLECTIONS = [
  'roles',
  'policies',
  'permissions',
] as const;

export const DEV_SENSITIVE_COLLECTIONS = [
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

export const DEV_EXTENSION_ACCESS_TARGETS = [
  'extensions',
  'extension_modules',
  'extension_endpoints',
  'extension_operations',
] as const;

export const DEV_SYSTEM_PERMISSION_ACTIONS = [
  'create',
  'read',
  'update',
  'delete',
] as const;

export const DEV_EXTENSION_PERMISSION_ACTIONS = {
  extensions: ['read', 'configure', 'install', 'enable', 'delete', 'grant_capability'],
  extension_modules: ['read'],
  extension_endpoints: ['execute'],
  extension_operations: ['execute'],
} as const satisfies Record<(typeof DEV_EXTENSION_ACCESS_TARGETS)[number], readonly string[]>;

export type DevAccessRoleSeed = {
  id: string;
  siteId: string;
  key: string;
  systemKey: string;
  name: string;
  description: string;
  icon: string | null;
  adminAccess: boolean;
  appAccess: boolean;
};

export type DevAccessPolicySeed = {
  id: string;
  siteId: string;
  key: string;
  name: string;
  description: string;
  icon: string | null;
  adminAccess: boolean;
  appAccess: boolean;
  enforceTfa: boolean;
  ipAllow: string[];
  ipDeny: string[];
  rules: Record<string, unknown>;
};

export type DevRolePolicySeed = {
  roleId: string;
  policyId: string;
  priority: number;
};

export type DevPermissionSeed = {
  id: string;
  siteId: string;
  policyId: string;
  collection: string;
  action: string;
  permissions: Record<string, unknown>;
  validation: Record<string, unknown>;
  presets: Record<string, unknown>;
  fields: string[];
};

function systemPermissions(
  policyId: string,
  collections: readonly string[],
  actions: readonly string[] = DEV_SYSTEM_PERMISSION_ACTIONS,
): DevPermissionSeed[] {
  return collections.flatMap((collection) =>
    actions.map((action) => ({
      id: `perm_${policyId}_${collection}_${action}`,
      siteId: DEV_SITE_ID,
      policyId,
      collection,
      action,
      permissions: {},
      validation: {},
      presets: {},
      fields: ['*'],
    })),
  );
}

export const DEV_ACCESS_SEED = {
  roles: [
    {
      id: DEV_ACCESS_ROLE_IDS.administrator,
      siteId: DEV_SITE_ID,
      key: 'administrator',
      systemKey: 'administrator',
      name: 'Administrator',
      description: 'Built-in administrator role for local development.',
      icon: 'shield-check',
      adminAccess: false,
      appAccess: true,
    },
  ],
  policies: [
    {
      id: DEV_ACCESS_POLICY_IDS.admin,
      siteId: DEV_SITE_ID,
      key: 'policy_admin',
      name: 'Administrator',
      description: 'Full admin bypass for trusted site administrators.',
      icon: 'shield-check',
      adminAccess: true,
      appAccess: true,
      enforceTfa: true,
      ipAllow: [],
      ipDeny: [],
      rules: {},
    },
    {
      id: DEV_ACCESS_POLICY_IDS.accessManager,
      siteId: DEV_SITE_ID,
      key: 'policy_access_manager',
      name: 'Access manager',
      description: 'Manage roles, policies, and permission rows without admin bypass.',
      icon: 'key-round',
      adminAccess: false,
      appAccess: true,
      enforceTfa: true,
      ipAllow: [],
      ipDeny: [],
      rules: {},
    },
    {
      id: DEV_ACCESS_POLICY_IDS.schemaManager,
      siteId: DEV_SITE_ID,
      key: 'policy_schema_manager',
      name: 'Schema manager',
      description: 'Manage collections, fields, and relations without admin bypass.',
      icon: 'database',
      adminAccess: false,
      appAccess: true,
      enforceTfa: true,
      ipAllow: [],
      ipDeny: [],
      rules: {},
    },
    {
      id: DEV_ACCESS_POLICY_IDS.securityManager,
      siteId: DEV_SITE_ID,
      key: 'policy_security_manager',
      name: 'Security manager',
      description: 'Read security-sensitive system collections and manage API key metadata.',
      icon: 'lock-keyhole',
      adminAccess: false,
      appAccess: true,
      enforceTfa: true,
      ipAllow: [],
      ipDeny: [],
      rules: {},
    },
    {
      id: DEV_ACCESS_POLICY_IDS.extensionManager,
      siteId: DEV_SITE_ID,
      key: 'policy_extension_manager',
      name: 'Extension manager',
      description: 'Install, configure, enable, and grant capabilities for extensions.',
      icon: 'puzzle',
      adminAccess: false,
      appAccess: true,
      enforceTfa: true,
      ipAllow: [],
      ipDeny: [],
      rules: {},
    },
    {
      id: DEV_ACCESS_POLICY_IDS.studioSelf,
      siteId: DEV_SITE_ID,
      key: 'policy_studio_self',
      name: 'Studio self access',
      description: 'Allows Studio sign-in and own-account self-service surfaces.',
      icon: 'user-round',
      adminAccess: false,
      appAccess: true,
      enforceTfa: false,
      ipAllow: [],
      ipDeny: [],
      rules: {},
    },
    {
      id: DEV_ACCESS_POLICY_IDS.public,
      siteId: DEV_SITE_ID,
      key: 'policy_public',
      name: 'Public',
      description: 'Anonymous public policy. Grants nothing until explicit content permissions are added.',
      icon: 'globe',
      adminAccess: false,
      appAccess: false,
      enforceTfa: false,
      ipAllow: [],
      ipDeny: [],
      rules: {},
    },
  ],
  rolePolicies: [
    {
      roleId: DEV_ACCESS_ROLE_IDS.administrator,
      policyId: DEV_ACCESS_POLICY_IDS.admin,
      priority: 0,
    },
  ],
  permissions: [
    ...systemPermissions(DEV_ACCESS_POLICY_IDS.schemaManager, DEV_SCHEMA_MANAGER_COLLECTIONS),
    ...systemPermissions(DEV_ACCESS_POLICY_IDS.accessManager, DEV_ACCESS_MANAGER_COLLECTIONS),
    ...systemPermissions(DEV_ACCESS_POLICY_IDS.securityManager, DEV_SENSITIVE_COLLECTIONS, ['read']),
    ...DEV_EXTENSION_ACCESS_TARGETS.flatMap((target) =>
      systemPermissions(DEV_ACCESS_POLICY_IDS.extensionManager, [target], DEV_EXTENSION_PERMISSION_ACTIONS[target]),
    ),
  ],
} satisfies {
  roles: DevAccessRoleSeed[];
  policies: DevAccessPolicySeed[];
  rolePolicies: DevRolePolicySeed[];
  permissions: DevPermissionSeed[];
};
