import type { CacheProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import type { PermissionBundle } from '../permission-service';
import { readSchemaVersion } from '../schema-version';
import { TypegenService } from '../typegen-service';
import { permissionFingerprint, resolveAccessView } from './openapi-access';
import type { OpenApiRealm } from './openapi-config';
import { generateOpenApiDocument, type OpenApiDocument } from './openapi-generator';

/**
 * Cache TTL for a generated document. Invalidation is by key, not by expiry:
 * a schema change bumps the schema version and a permission change changes
 * the fingerprint, so a stale entry is never addressed again. The TTL only
 * bounds staleness when a version bump is lost (cache outage).
 */
export const OPENAPI_CACHE_TTL_SECONDS = 300;

export const openApiCacheKey = (siteId: string, schemaVersion: number, fingerprint: string) =>
  `openapi:${siteId}:s${schemaVersion}:${fingerprint}`;

export interface OpenApiServiceDeps {
  db: Database;
  siteId: string;
  cache?: CacheProvider | null;
  /** Test seam; defaults to the site's typegen manifest. */
  loadManifest?: () => ReturnType<TypegenService['getManifest']>;
}

export interface OpenApiResult {
  document: OpenApiDocument;
  /** Cache key the document is (or would be) stored under — also the ETag seed. */
  key: string;
  cached: boolean;
}

export class OpenApiService {
  constructor(private readonly deps: OpenApiServiceDeps) {}

  async documentFor(bundle: PermissionBundle, realm: OpenApiRealm): Promise<OpenApiResult> {
    const { siteId, cache } = this.deps;
    const schemaVersion = await readSchemaVersion(cache, siteId);
    const fingerprint = await permissionFingerprint(bundle, realm);
    const key = openApiCacheKey(siteId, schemaVersion, fingerprint);

    if (cache) {
      try {
        const hit = await cache.get<OpenApiDocument | string>(key);
        if (hit) {
          const document = typeof hit === 'string' ? (JSON.parse(hit) as OpenApiDocument) : hit;
          return { document, key, cached: true };
        }
      } catch {
        // A cache read failure degrades to regeneration, never to an error.
      }
    }

    const manifest = await (this.deps.loadManifest ?? (() => new TypegenService({ db: this.deps.db, siteId }).getManifest()))();
    const document = generateOpenApiDocument({
      manifest,
      access: resolveAccessView(bundle, manifest, realm),
      realm,
      siteId,
      schemaVersion,
    });

    if (cache) {
      try {
        await cache.set(key, JSON.stringify(document), {
          ttl: OPENAPI_CACHE_TTL_SECONDS,
          tags: [`openapi:${siteId}`],
        });
      } catch {
        // Best-effort write.
      }
    }
    return { document, key, cached: false };
  }
}
