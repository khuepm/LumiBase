import type { PermissionBundle } from '../permission-service';
import { applyFieldMask } from '../permission-dsl';
import type { TypegenManifest } from '../typegen-service';
import type { OpenApiRealm } from './openapi-config';

/**
 * What one caller may see of one collection — the only permission input the
 * OpenAPI generator receives. Field lists are the effective `data` keys after
 * the same mask `PermissionService.maskItem` applies at read time
 * (`applyFieldMask`), so the document can never name a field the caller's
 * reads would strip.
 */
export interface CollectionAccess {
  /** Readable user fields (keys of `item.data`). */
  read: string[];
  /** Writable on create (⊆ read), or null when create is not granted. */
  create: string[] | null;
  /** Writable on update (⊆ read), or null when update is not granted. */
  update: string[] | null;
  delete: boolean;
  /** Encrypted fields come back decrypted instead of `'***'`. */
  readDecrypted: boolean;
}

export type AccessView = Map<string, CollectionAccess>;

const DOC_ACTIONS = ['read', 'create', 'update', 'delete', 'read_decrypted'] as const;

/** Realms that only ever receive the read surface. */
const READ_ONLY_REALMS: ReadonlySet<OpenApiRealm> = new Set(['public']);

/**
 * Permission fingerprint: a stable digest of every bundle input the document
 * depends on. Two callers with the same fingerprint (and the same realm and
 * schema version) receive byte-identical documents, so it is safe as a cache
 * key component; anything that changes what a caller may see changes it.
 *
 * Computed from the bundle alone — no schema read — so a cache hit costs no
 * collection/field queries.
 */
export async function permissionFingerprint(
  bundle: PermissionBundle,
  realm: OpenApiRealm,
): Promise<string> {
  const entries = bundle.admin
    ? []
    : Object.values(bundle.byKey)
        .filter((perm) => (DOC_ACTIONS as readonly string[]).includes(perm.action))
        .map((perm) => [perm.collection, perm.action, [...perm.fields].sort()] as const)
        .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonical = JSON.stringify({ realm, admin: bundle.admin, entries });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Resolve the caller's view of every collection in the manifest. */
export function resolveAccessView(
  bundle: PermissionBundle,
  manifest: TypegenManifest,
  realm: OpenApiRealm,
): AccessView {
  const view: AccessView = new Map();
  const readOnly = READ_ONLY_REALMS.has(realm);
  for (const collection of manifest.collections) {
    const userFields = collection.fields.filter((field) => !field.system).map((field) => field.name);
    const masked = (action: (typeof DOC_ACTIONS)[number]): string[] | null => {
      if (bundle.admin) return userFields;
      const perm = bundle.byKey[`${collection.name}::${action}`];
      if (!perm) return null;
      return applyFieldMask(userFields, perm.fields);
    };
    const read = masked('read');
    if (read === null) continue;
    const readable = new Set(read);
    const writable = (action: 'create' | 'update') => {
      if (readOnly) return null;
      const fields = masked(action);
      return fields === null ? null : fields.filter((name) => readable.has(name));
    };
    view.set(collection.name, {
      read,
      create: writable('create'),
      update: writable('update'),
      delete: !readOnly && masked('delete') !== null,
      readDecrypted: masked('read_decrypted') !== null,
    });
  }
  return view;
}
