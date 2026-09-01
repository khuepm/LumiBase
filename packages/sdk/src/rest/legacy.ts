import { LumiClient } from "../client";
import { RealtimeClient } from "../realtime";
import {
  CollectionResource,
  CollectionInput,
  FieldResource,
  FieldInput,
  FieldDeleteOptions,
  FieldMutationOptions,
  FieldRenameInput,
  RelationResource,
  RelationInput,
  SchemaApplyInput,
  SchemaApplyResult,
  SchemaDiff,
  SchemaDiffInput,
  TypegenSchemaFilters,
  ListItemsParams,
  ItemRow,
  ListItemsResponse,
  RevisionRow,
  DefaultSchema,
  RoleResource,
  RoleDetail,
  PolicyResource,
  PolicyDetail,
  PermissionRow,
  PermissionAction,
  PermissionBundle,
  PermissionCheckResult,
  AccessConflictCheckInput,
  GrantAction,
  RealmAccessGrant,
  RealmAccessState,
  RealmGrantInput,
  AccessConflictReport,
  AccessExportManifest,
  AccessImportApplyResult,
  AccessImportDryRunResult,
  AccessImportOptions,
  ApiKeyCreateInput,
  ApiKeyPolicyAttachment,
  ApiKeyResource,
  ApiKeyRoleAttachment,
  ApiKeyRotateInput,
  ApiKeySecretResult,
  ShareCreateInput,
  ShareResource,
  ShareSecretResult,
  PresetResource,
  TranslationResource,
  ContentVersion,
  VersionCompare,
  TmEntry,
  TmSuggestion,
  TmSource,
  SettingResource,
  SiteResource,
  SiteConfigUpdate,
  DomainResource,
  DomainCreateInput,
  UserResource,
  TeamResource,
  TeamMemberResource,
  FolderResource,
  FileResource,
  UploadConfigResource,
  WebhookResource,
  ActivityResource,
  ExtensionResource,
  DeploymentTargetResource,
  DeploymentResource,
} from "../types";

/**
 * Loose shape for `users.preferences`. The CMS validates the strict schema
 * (`@lumibase/contracts/schemas#UserPreferences`); the SDK stays decoupled and
 * passes the blob through, so callers keep full type-safety on the Studio side
 * where the shared schema is imported.
 */
export interface UserPreferencesPayload {
  language?: string;
  theme?: "auto" | "light" | "dark";
  timezone?: string;
  keybindings?: Record<string, string>;
  [key: string]: unknown;
}

function withQuery(path: string, params: Record<string, unknown> = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    qs.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

export function legacyRest() {
  return function <TSchema extends DefaultSchema>(client: LumiClient<TSchema>) {
    const collections = {
      list: () =>
        client.rawRequest<CollectionResource[]>("/api/v1/collections"),
      get: (name: string) =>
        client.rawRequest<CollectionResource>(`/api/v1/collections/${name}`),
      compiled: (name: string) =>
        client.rawRequest<CollectionResource>(`/api/v1/collections/${name}/compiled`),
      create: (input: CollectionInput) =>
        client.rawRequest<CollectionResource>("/api/v1/collections", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (name: string, patch: Partial<CollectionInput>) =>
        client.rawRequest<CollectionResource>(`/api/v1/collections/${name}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (name: string) =>
        client.rawRequest<null>(`/api/v1/collections/${name}`, {
          method: "DELETE",
        }),
    };

    const fields = {
      list: (collectionName: string) =>
        client.rawRequest<FieldResource[]>(
          `/api/v1/collections/${collectionName}/fields`,
        ),
      upsert: (
        collectionName: string,
        fieldName: string,
        input: FieldInput,
      ) =>
        client.rawRequest<FieldResource>(
          `/api/v1/collections/${collectionName}/fields/${fieldName}`,
          {
            method: "PUT",
            body: JSON.stringify(input),
          },
        ),
      create: (collectionName: string, input: FieldInput) =>
        fields.upsert(collectionName, input.name, input),
      update: (
        collectionName: string,
        fieldName: string,
        input: FieldInput,
      ) => fields.upsert(collectionName, fieldName, input),
      rename: (
        collectionName: string,
        fromFieldName: string,
        toFieldName: string,
        input: FieldRenameInput,
      ) =>
        fields.upsert(
          collectionName,
          toFieldName,
          {
            ...input,
            name: toFieldName,
            renameFrom: fromFieldName,
          } as FieldInput,
        ),
      delete: (
        collectionName: string,
        fieldName: string,
        options: FieldDeleteOptions = {},
      ) =>
        client.rawRequest<null>(
          withQuery(
            `/api/v1/collections/${collectionName}/fields/${fieldName}`,
            options as Record<string, unknown>,
          ),
          { method: "DELETE" },
        ),
    };

    const relations = {
      list: () =>
        client.rawRequest<RelationResource[]>("/api/v1/relations"),
      create: (input: RelationInput) =>
        client.rawRequest<RelationResource>("/api/v1/relations", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      delete: (id: string) =>
        client.rawRequest<null>(`/api/v1/relations/${id}`, {
          method: "DELETE",
        }),
    };

    const schema = {
      collections,
      fields,
      relations,
      diff: (name: string, proposed: SchemaApplyInput) =>
        client.rawRequest<SchemaDiff>("/api/v1/collections/diff", {
          method: "POST",
          body: JSON.stringify({ name, ...proposed }),
        }),
      diffInput: (input: SchemaDiffInput) =>
        client.rawRequest<SchemaDiff>("/api/v1/collections/diff", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      apply: (name: string, proposed: SchemaApplyInput) =>
        client.rawRequest<SchemaApplyResult>(
          `/api/v1/collections/${name}/schema`,
          {
            method: "PUT",
            body: JSON.stringify(proposed),
          },
        ),
      typegen: (filters?: TypegenSchemaFilters) => {
        const params = new URLSearchParams();
        if (filters?.include?.length)
          params.set("include", filters.include.join(","));
        if (filters?.exclude?.length)
          params.set("exclude", filters.exclude.join(","));
        const qs = params.toString();
        return client.rawRequest<unknown>(
          `/api/v1/typegen/schema${qs ? `?${qs}` : ""}`,
        );
      },
      listCollections: collections.list,
      getCollection: collections.get,
      getCompiled: collections.compiled,
      createCollection: collections.create,
      updateCollection: collections.update,
      deleteCollection: collections.delete,
      listFields: fields.list,
      upsertField: fields.upsert,
      deleteField: fields.delete,
      listRelations: relations.list,
      createRelation: relations.create,
      deleteRelation: relations.delete,
    };

    function items<TName extends keyof TSchema & string>(name: TName) {
      type Row = ItemRow<
        TSchema[TName] extends Record<string, unknown>
          ? TSchema[TName]
          : Record<string, unknown>
      >;
      type ListResp = ListItemsResponse<
        TSchema[TName] extends Record<string, unknown>
          ? TSchema[TName]
          : Record<string, unknown>
      >;

      function buildQuery(params?: ListItemsParams): string {
        if (!params) return "";
        const qs = new URLSearchParams();
        if (params.fields?.length) qs.set("fields", params.fields.join(","));
        if (params.filter) qs.set("filter", JSON.stringify(params.filter));
        if (params.sort?.length) qs.set("sort", params.sort.join(","));
        if (params.limit !== undefined) qs.set("limit", String(params.limit));
        if (params.offset !== undefined)
          qs.set("offset", String(params.offset));
        if (params.status) qs.set("status", params.status);
        const s = qs.toString();
        return s ? `?${s}` : "";
      }

      const base = `/api/v1/items/${name}`;

      return {
        list: async (params?: ListItemsParams): Promise<ListResp> => {
          const res = await client.rawRequest<ListResp[keyof ListResp]>(
            `${base}${buildQuery(params)}`,
          );
          return res as unknown as ListResp;
        },
        detail: (id: string, fields?: string[]) =>
          client.rawRequest<Row>(
            `${base}/${id}${fields?.length ? `?fields=${fields.join(",")}` : ""}`,
          ),
        create: (input: {
          data: Partial<Row["data"]>;
          status?: string;
          sort?: number;
          /** ISO timestamps for content scheduling (Publish_Window). */
          publishAt?: string | null;
          unpublishAt?: string | null;
        }) =>
          client.rawRequest<Row>(base, {
            method: "POST",
            body: JSON.stringify(input),
          }),
        patch: (
          id: string,
          input: {
            data?: Partial<Row["data"]>;
            status?: string;
            sort?: number;
            /** ISO timestamps for content scheduling (Publish_Window). */
            publishAt?: string | null;
            unpublishAt?: string | null;
          },
        ) =>
          client.rawRequest<Row>(`${base}/${id}`, {
            method: "PATCH",
            body: JSON.stringify(input),
          }),
        replace: (
          id: string,
          input: { data: Row["data"]; status?: string; sort?: number },
        ) =>
          client.rawRequest<Row>(`${base}/${id}`, {
            method: "PUT",
            body: JSON.stringify(input),
          }),
        delete: (id: string) =>
          client.rawRequest<null>(`${base}/${id}`, { method: "DELETE" }),
        bulk: (
          op: "create" | "update" | "delete",
          payload: Array<Record<string, unknown>>,
        ) =>
          client.rawRequest<Row[]>(`${base}/bulk`, {
            method: "POST",
            body: JSON.stringify({ op, items: payload }),
          }),
        listRevisions: (id: string) =>
          client.rawRequest<RevisionRow[]>(`${base}/${id}/revisions`),
        revertRevision: (id: string, revisionId: string) =>
          client.rawRequest<Row>(`${base}/${id}/revert/${revisionId}`, {
            method: "POST",
          }),
        // Law Zero pins (content-os Req 8.4/8.5): fields a human edit locked
        // against agent writes. Release hands the field back to agents.
        listPins: (id: string) =>
          client.rawRequest<{ pinnedFields: string[] }>(`${base}/${id}/pins`),
        releasePin: (id: string, field: string) =>
          client.rawRequest<{ pinnedFields: string[] }>(
            `${base}/${id}/pins/${encodeURIComponent(field)}`,
            { method: "DELETE" },
          ),
        // Content versions — named parallel draft branches (content-versioning).
        versions: {
          list: (id: string) =>
            client.rawRequest<ContentVersion[]>(`${base}/${id}/versions`),
          create: (id: string, input: { key: string; name: string }) =>
            client.rawRequest<ContentVersion>(`${base}/${id}/versions`, {
              method: "POST",
              body: JSON.stringify(input),
            }),
          get: (id: string, key: string) =>
            client.rawRequest<ContentVersion>(
              `${base}/${id}/versions/${encodeURIComponent(key)}`,
            ),
          update: (
            id: string,
            key: string,
            patch: { data?: Record<string, unknown>; name?: string },
          ) =>
            client.rawRequest<ContentVersion>(
              `${base}/${id}/versions/${encodeURIComponent(key)}`,
              { method: "PATCH", body: JSON.stringify(patch) },
            ),
          delete: (id: string, key: string) =>
            client.rawRequest<null>(
              `${base}/${id}/versions/${encodeURIComponent(key)}`,
              { method: "DELETE" },
            ),
          compare: (id: string, key: string) =>
            client.rawRequest<VersionCompare>(
              `${base}/${id}/versions/${encodeURIComponent(key)}/compare`,
            ),
          // Returns the promoted item; `meta.mainDiverged` flags that main
          // changed after the branch was cut (review advised).
          promote: (id: string, key: string) =>
            client.rawRequest<Row>(
              `${base}/${id}/versions/${encodeURIComponent(key)}/promote`,
              { method: "POST" },
            ),
        },
      };
    }

    const roles = {
      list: () => client.rawRequest<RoleResource[]>("/api/v1/roles"),
      detail: (id: string) =>
        client.rawRequest<RoleDetail>(`/api/v1/roles/${id}`),
      create: (input: Partial<RoleResource> & { name: string }) =>
        client.rawRequest<RoleResource>("/api/v1/roles", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: Partial<RoleResource>) =>
        client.rawRequest<RoleResource>(`/api/v1/roles/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) =>
        client.rawRequest<null>(`/api/v1/roles/${id}`, { method: "DELETE" }),
      attachPolicy: (
        id: string,
        input: { policyId: string; priority?: number; overrideWarnings?: boolean },
      ) =>
        client.rawRequest<{
          roleId: string;
          policyId: string;
          priority: number;
        }>(`/api/v1/roles/${id}/policies`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      detachPolicy: (id: string, policyId: string) =>
        client.rawRequest<null>(`/api/v1/roles/${id}/policies/${policyId}`, {
          method: "DELETE",
        }),
      assignUser: (id: string, input: { userId: string }) =>
        client.rawRequest<{ userId: string; siteId: string; roleId: string }>(
          `/api/v1/roles/${id}/users`,
          { method: "POST", body: JSON.stringify(input) },
        ),
      removeUser: (id: string, userId: string) =>
        client.rawRequest<null>(`/api/v1/roles/${id}/users/${userId}`, {
          method: "DELETE",
        }),
    };

    const policies = {
      list: () => client.rawRequest<PolicyResource[]>("/api/v1/policies"),
      detail: (id: string) =>
        client.rawRequest<PolicyDetail>(`/api/v1/policies/${id}`),
      create: (input: Partial<PolicyResource> & { name: string }) =>
        client.rawRequest<PolicyResource>("/api/v1/policies", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: Partial<PolicyResource>) =>
        client.rawRequest<PolicyResource>(`/api/v1/policies/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) =>
        client.rawRequest<null>(`/api/v1/policies/${id}`, { method: "DELETE" }),
      addPermission: (
        id: string,
        input: {
          collection: string;
          action: PermissionAction;
          permissions?: Record<string, unknown>;
          validation?: Record<string, unknown>;
          presets?: Record<string, unknown>;
          fields?: string[];
        },
      ) =>
        client.rawRequest<PermissionRow>(`/api/v1/policies/${id}/permissions`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      patchPermission: (
        id: string,
        permId: string,
        patch: Partial<PermissionRow>,
      ) =>
        client.rawRequest<PermissionRow>(
          `/api/v1/policies/${id}/permissions/${permId}`,
          { method: "PATCH", body: JSON.stringify(patch) },
        ),
      removePermission: (id: string, permId: string) =>
        client.rawRequest<null>(
          `/api/v1/policies/${id}/permissions/${permId}`,
          { method: "DELETE" },
        ),
      attachUser: (id: string, input: { userId: string; priority?: number }) =>
        client.rawRequest<{
          userId: string;
          policyId: string;
          priority: number;
        }>(`/api/v1/policies/${id}/users`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      detachUser: (id: string, userId: string) =>
        client.rawRequest<null>(`/api/v1/policies/${id}/users/${userId}`, {
          method: "DELETE",
        }),
    };

    const permissions = {
      me: () => client.rawRequest<PermissionBundle>("/api/v1/permissions/me"),
      check: (input: {
        collection: string;
        action: PermissionAction;
        item?: Record<string, unknown>;
      }) =>
        client.rawRequest<PermissionCheckResult>("/api/v1/permissions/check", {
          method: "POST",
          body: JSON.stringify(input),
        }),
    };

    const presets = {
      list: (collection?: string) =>
        client.rawRequest<PresetResource[]>(`/api/v1/presets${collection ? `?collection=${collection}` : ""}`),
      get: (id: string) => client.rawRequest<PresetResource>(`/api/v1/presets/${id}`),
      create: (input: Partial<PresetResource> & { collection: string }) =>
        client.rawRequest<PresetResource>("/api/v1/presets", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: Partial<PresetResource>) =>
        client.rawRequest<PresetResource>(`/api/v1/presets/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) => client.rawRequest<null>(`/api/v1/presets/${id}`, { method: "DELETE" }),
    };

    const translations = {
      list: (params?: { namespace?: string; language?: string }) => {
        const qs = new URLSearchParams();
        if (params?.namespace) qs.set("namespace", params.namespace);
        if (params?.language) qs.set("language", params.language);
        const s = qs.toString();
        return client.rawRequest<TranslationResource[]>(`/api/v1/translations${s ? `?${s}` : ""}`);
      },
      get: (id: string) => client.rawRequest<TranslationResource>(`/api/v1/translations/${id}`),
      create: (input: Partial<TranslationResource> & { language: string; namespace: string; key: string; value: string }) =>
        client.rawRequest<TranslationResource>("/api/v1/translations", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: Partial<TranslationResource>) =>
        client.rawRequest<TranslationResource>(`/api/v1/translations/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) => client.rawRequest<null>(`/api/v1/translations/${id}`, { method: "DELETE" }),
    };

    const tm = {
      /** List TM entries. Filters: source/target lang pair + `entrySource` (human|mt|imported). Returns the full response so callers can read pagination `meta`. */
      list: (params?: {
        source?: string;
        target?: string;
        entrySource?: TmSource;
        limit?: number;
        offset?: number;
      }) => {
        const qs = new URLSearchParams();
        if (params?.source) qs.set("source", params.source);
        if (params?.target) qs.set("target", params.target);
        if (params?.entrySource) qs.set("entrySource", params.entrySource);
        if (params?.limit != null) qs.set("limit", String(params.limit));
        if (params?.offset != null) qs.set("offset", String(params.offset));
        const s = qs.toString();
        return client.rawRequest<TmEntry[]>(`/api/v1/tm${s ? `?${s}` : ""}`);
      },
      upsert: (input: {
        sourceLang: string;
        targetLang: string;
        sourceText: string;
        targetText: string;
        context?: string;
        quality?: number;
        source?: TmSource;
        provider?: string;
      }) =>
        client.rawRequest<TmEntry>("/api/v1/tm", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (
        id: string,
        patch: { targetText?: string; quality?: number; context?: string | null; source?: TmSource },
      ) =>
        client.rawRequest<TmEntry>(`/api/v1/tm/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) =>
        client.rawRequest<{ id: string }>(`/api/v1/tm/${id}`, { method: "DELETE" }),
      /** Fuzzy TM lookup. Normalizes the route's `{ match: { targetText, score } | null }` to a `TmSuggestion | null`. */
      lookup: async (input: {
        query: string;
        sourceLang: string;
        targetLang: string;
        threshold?: number;
      }): Promise<TmSuggestion | null> => {
        const res = await client.rawRequest<{
          match: { targetText: string; score: number; source?: TmSource; id?: string } | null;
        }>("/api/v1/tm/lookup", {
          method: "POST",
          body: JSON.stringify(input),
        });
        const m = res.data.match;
        if (!m) return null;
        return {
          targetText: m.targetText,
          similarity: m.score,
          source: m.source ?? "human",
          entryId: m.id,
        };
      },
      /** Full MT pipeline (TM → glossary → provider). */
      translate: (input: { text: string; from: string; to: string; provider?: string }) =>
        client.rawRequest<{ text: string; source?: string; provider?: string }>(
          "/api/v1/tm/translate",
          { method: "POST", body: JSON.stringify(input) },
        ),
    };

    const settings = {
      list: (scope?: string) =>
        client.rawRequest<SettingResource[]>(`/api/v1/settings${scope ? `?scope=${scope}` : ""}`),
      get: (key: string) => client.rawRequest<SettingResource>(`/api/v1/settings/${key}`),
      set: (key: string, value: Record<string, unknown>, scope?: string) =>
        client.rawRequest<SettingResource>("/api/v1/settings", {
          method: "POST",
          body: JSON.stringify({ key, value, scope }),
        }),
      delete: (key: string) => client.rawRequest<null>(`/api/v1/settings/${key}`, { method: "DELETE" }),
    };

    const site = {
      get: () => client.rawRequest<SiteResource>("/api/v1/site"),
      update: (patch: SiteConfigUpdate) =>
        client.rawRequest<SiteResource>("/api/v1/site", {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
    };

    const domains = {
      list: () => client.rawRequest<DomainResource[]>("/api/v1/domains"),
      create: (input: DomainCreateInput) =>
        client.rawRequest<DomainResource>("/api/v1/domains", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      verify: (id: string) =>
        client.rawRequest<DomainResource>(`/api/v1/domains/${id}/verify`, {
          method: "POST",
        }),
      setPrimary: (id: string) =>
        client.rawRequest<DomainResource>(`/api/v1/domains/${id}/primary`, {
          method: "POST",
        }),
      delete: (id: string) =>
        client.rawRequest<void>(`/api/v1/domains/${id}`, { method: "DELETE" }),
    };

    const users = {
      list: () => client.rawRequest<UserResource[]>("/api/v1/users"),
      get: (id: string) => client.rawRequest<UserResource>(`/api/v1/users/${id}`),
      invite: (input: { email: string; roleId?: string }) =>
        client.rawRequest<UserResource>("/api/v1/users/invite", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: { roleId?: string | null; status?: string }) =>
        client.rawRequest<{ id: string }>(`/api/v1/users/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) => client.rawRequest<null>(`/api/v1/users/${id}`, { method: "DELETE" }),
      impersonate: (id: string) =>
        client.rawRequest<{ token: string }>(`/api/v1/users/${id}/impersonate`, { method: "POST" }),
    };

    const teams = {
      list: () => client.rawRequest<TeamResource[]>("/api/v1/teams"),
      get: (id: string) => client.rawRequest<TeamResource>(`/api/v1/teams/${id}`),
      create: (input: { name: string; description?: string }) =>
        client.rawRequest<TeamResource>("/api/v1/teams", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: { name?: string; description?: string }) =>
        client.rawRequest<TeamResource>(`/api/v1/teams/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) => client.rawRequest<null>(`/api/v1/teams/${id}`, { method: "DELETE" }),
      members: {
        list: (teamId: string) => client.rawRequest<TeamMemberResource[]>(`/api/v1/teams/${teamId}/members`),
        add: (teamId: string, userId: string) =>
          client.rawRequest<TeamMemberResource>(`/api/v1/teams/${teamId}/members`, {
            method: "POST",
            body: JSON.stringify({ userId }),
          }),
        remove: (teamId: string, userId: string) =>
          client.rawRequest<null>(`/api/v1/teams/${teamId}/members/${userId}`, { method: "DELETE" }),
      },
    };

    const folders = {
      list: () => client.rawRequest<FolderResource[]>("/api/v1/files/folders"),
      create: (input: { name: string; parent?: string | null }) =>
        client.rawRequest<FolderResource>("/api/v1/files/folders", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: { name?: string; parent?: string | null }) =>
        client.rawRequest<FolderResource>(`/api/v1/files/folders/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) => client.rawRequest<null>(`/api/v1/files/folders/${id}`, { method: "DELETE" }),
    };

    const files = {
      list: () => client.rawRequest<FileResource[]>("/api/v1/files"),
      create: (input: Record<string, unknown>) =>
        client.rawRequest<FileResource>("/api/v1/files", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: Record<string, unknown>) =>
        client.rawRequest<FileResource>(`/api/v1/files/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) => client.rawRequest<null>(`/api/v1/files/${id}`, { method: "DELETE" }),
      getPresignedUrl: (filename: string) =>
        client.rawRequest<{ url: string; method: string; key: string }>("/api/v1/files/presigned-url", {
          method: "POST",
          body: JSON.stringify({ filename }),
        }),
    };

    const uploads = {
      /** Effective upload policy + catalogue — drives the picker's `accept`. */
      getConfig: () => client.rawRequest<UploadConfigResource>("/api/v1/uploads/config"),
      /** Update the per-site allowlist / size cap (site admin only). */
      updateConfig: (patch: { maxBytes?: number; allowedMimeTypes?: string[] }) =>
        client.rawRequest<UploadConfigResource>("/api/v1/uploads/config", {
          method: "PUT",
          body: JSON.stringify(patch),
        }),
    };

    const webhooks = {
      list: () => client.rawRequest<WebhookResource[]>("/api/v1/webhooks"),
      create: (input: Record<string, unknown>) =>
        client.rawRequest<WebhookResource>("/api/v1/webhooks", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: Record<string, unknown>) =>
        client.rawRequest<WebhookResource>(`/api/v1/webhooks/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) => client.rawRequest<null>(`/api/v1/webhooks/${id}`, { method: "DELETE" }),
    };

    const activity = {
      list: (params?: { limit?: number; offset?: number }) => {
        const query = new URLSearchParams();
        if (params?.limit) query.append("limit", params.limit.toString());
        if (params?.offset) query.append("offset", params.offset.toString());
        return client.rawRequest<ActivityResource[]>(`/api/v1/activity?${query.toString()}`);
      },
    };

    const extensions = {
      list: () => client.rawRequest<ExtensionResource[]>("/api/v1/extensions"),
      create: (input: Record<string, unknown>) =>
        client.rawRequest<ExtensionResource>("/api/v1/extensions", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, patch: Record<string, unknown>) =>
        client.rawRequest<ExtensionResource>(`/api/v1/extensions/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (id: string) => client.rawRequest<null>(`/api/v1/extensions/${id}`, { method: "DELETE" }),
    };

    const access = {
      /**
       * Non-staff permission picker (`/api/v1/access/grants`). One call
       * returns the site's grantable collections plus every realm's limits and
       * current grants, so a client never has to hard-code which actions a
       * realm may hold.
       */
      grants: {
        state: () => client.rawRequest<RealmAccessState>("/api/v1/access/grants"),
        enable: (realm: string) =>
          client.rawRequest<{ enabled: boolean; roleId: string; policyId: string }>(
            `/api/v1/access/grants/${encodeURIComponent(realm)}/enable`,
            { method: "POST" },
          ),
        disable: (realm: string) =>
          client.rawRequest<{ enabled: boolean; removed: boolean }>(
            `/api/v1/access/grants/${encodeURIComponent(realm)}/disable`,
            { method: "POST" },
          ),
        grant: (realm: string, input: RealmGrantInput) =>
          client.rawRequest<RealmAccessGrant>(`/api/v1/access/grants/${encodeURIComponent(realm)}`, {
            method: "POST",
            body: JSON.stringify(input),
          }),
        revoke: (realm: string, collection: string, action: GrantAction = "read") =>
          client.rawRequest<{ removed: boolean }>(
            `/api/v1/access/grants/${encodeURIComponent(realm)}/${encodeURIComponent(collection)}/${encodeURIComponent(action)}`,
            { method: "DELETE" },
          ),
      },
      checkConflicts: (input: AccessConflictCheckInput) =>
        client.rawRequest<AccessConflictReport>("/api/v1/access/conflicts/check", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      exportManifest: () =>
        client.rawRequest<AccessExportManifest>("/api/v1/access/export"),
      dryRunImport: (manifest: AccessExportManifest) =>
        client.rawRequest<AccessImportDryRunResult>("/api/v1/access/import?dryRun=true", {
          method: "POST",
          body: JSON.stringify(manifest),
        }),
      importManifest: (
        manifest: AccessExportManifest,
        options: AccessImportOptions = {},
      ) => {
        const query = options.mode ? `?mode=${encodeURIComponent(options.mode)}` : "";
        return client.rawRequest<AccessImportApplyResult>(`/api/v1/access/import${query}`, {
          method: "POST",
          body: JSON.stringify(manifest),
        });
      },
    };

    const apiKeys = {
      list: () => client.rawRequest<ApiKeyResource[]>("/api/v1/api-keys"),
      get: (id: string) => client.rawRequest<ApiKeyResource>(`/api/v1/api-keys/${id}`),
      create: (input: ApiKeyCreateInput) =>
        client.rawRequest<ApiKeySecretResult>("/api/v1/api-keys", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      rotate: (id: string, input: ApiKeyRotateInput = {}) =>
        client.rawRequest<ApiKeySecretResult>(`/api/v1/api-keys/${id}/rotate`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /**
       * Replace the key's browser-origin allowlist without rotating the token.
       * Pass `[]` to remove the constraint entirely.
       */
      setAllowedOrigins: (id: string, allowedOrigins: string[]) =>
        client.rawRequest<ApiKeyResource>(`/api/v1/api-keys/${id}/allowed-origins`, {
          method: "PATCH",
          body: JSON.stringify({ allowedOrigins }),
        }),
      revoke: (id: string) =>
        client.rawRequest<ApiKeyResource>(`/api/v1/api-keys/${id}/revoke`, {
          method: "POST",
        }),
      attachRole: (
        id: string,
        input: { roleId: string; priority?: number; overrideWarnings?: boolean },
      ) =>
        client.rawRequest<ApiKeyRoleAttachment>(`/api/v1/api-keys/${id}/roles`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      detachRole: (id: string, roleId: string) =>
        client.rawRequest<null>(`/api/v1/api-keys/${id}/roles/${roleId}`, {
          method: "DELETE",
        }),
      attachPolicy: (
        id: string,
        input: { policyId: string; priority?: number; overrideWarnings?: boolean },
      ) =>
        client.rawRequest<ApiKeyPolicyAttachment>(`/api/v1/api-keys/${id}/policies`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      detachPolicy: (id: string, policyId: string) =>
        client.rawRequest<null>(`/api/v1/api-keys/${id}/policies/${policyId}`, {
          method: "DELETE",
        }),
      previewConflicts: (id: string, input: Omit<AccessConflictCheckInput, "target">) =>
        access.checkConflicts({
          ...input,
          target: { type: "api_key", id },
        }),
    };

    const shares = {
      create: (input: ShareCreateInput) =>
        client.rawRequest<ShareSecretResult>("/api/v1/shares", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      revoke: (id: string) =>
        client.rawRequest<ShareResource>(`/api/v1/shares/${id}/revoke`, {
          method: "POST",
        }),
    };

    /**
     * Current-user surface. `preferences` is the identity-global JSONB blob
     * (`users.preferences`) — keybindings, language, theme. `update` shallow-
     * merges server-side, so callers can PATCH a single section.
     */
    const me = {
      getPreferences: () =>
        client.rawRequest<UserPreferencesPayload>("/api/v1/me/preferences"),
      updatePreferences: (patch: UserPreferencesPayload) =>
        client.rawRequest<UserPreferencesPayload>("/api/v1/me/preferences", {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
    };

    // Deployment integrations (spec: deployment-integrations).
    const deployments = {
      targets: {
        list: () =>
          client.rawRequest<DeploymentTargetResource[]>("/api/v1/deployments/targets"),
        create: (input: Record<string, unknown>) =>
          client.rawRequest<DeploymentTargetResource>("/api/v1/deployments/targets", {
            method: "POST",
            body: JSON.stringify(input),
          }),
        update: (id: string, patch: Record<string, unknown>) =>
          client.rawRequest<DeploymentTargetResource>(`/api/v1/deployments/targets/${id}`, {
            method: "PATCH",
            body: JSON.stringify(patch),
          }),
        delete: (id: string) =>
          client.rawRequest<null>(`/api/v1/deployments/targets/${id}`, { method: "DELETE" }),
        deploy: (id: string, input: { branch?: string; reason?: string } = {}) =>
          client.rawRequest<DeploymentResource>(`/api/v1/deployments/targets/${id}/deploy`, {
            method: "POST",
            body: JSON.stringify(input),
          }),
      },
      list: (params?: { targetId?: string; status?: string }) => {
        const qs = new URLSearchParams();
        if (params?.targetId) qs.set("targetId", params.targetId);
        if (params?.status) qs.set("status", params.status);
        const suffix = qs.toString() ? `?${qs.toString()}` : "";
        return client.rawRequest<DeploymentResource[]>(`/api/v1/deployments${suffix}`);
      },
      get: (id: string) => client.rawRequest<DeploymentResource>(`/api/v1/deployments/${id}`),
      logs: (id: string) =>
        client.rawRequest<{ log: string }>(`/api/v1/deployments/${id}/logs`),
      refresh: (id: string) =>
        client.rawRequest<DeploymentResource>(`/api/v1/deployments/${id}/refresh`, { method: "POST" }),
    };

    return {
      schema,
      items,
      roles,
      policies,
      access,
      apiKeys,
      shares,
      me,
      permissions,
      presets,
      translations,
      tm,
      settings,
      uploads,
      site,
      domains,
      users,
      teams,
      folders,
      files,
      webhooks,
      activity,
      extensions,
      deployments,
      realtime: {
        /**
         * Create a RealtimeClient for the current site.
         *
         * @param token  Bearer token (or dev token) for the WS handshake.
         * @param opts   Optional overrides (userId, backoff timing).
         */
        create: (
          token: string,
          opts?: { userId?: string; initialBackoffMs?: number; maxBackoffMs?: number },
        ) => {
          return new RealtimeClient({
            baseUrl: client.url,
            token,
            siteId: client.siteId ?? '',
            ...opts,
          });
        },
        /** @deprecated Use .realtime.create() instead. */
        connect: async (siteId: string) => {
          const res = await client.rawRequest<{ ticket: string }>("/api/v1/realtime/ticket", { method: "POST" });
          const ticket = res.data?.ticket;
          if (!ticket) {
            throw new Error("Failed to get realtime ticket");
          }
          const wsUrl = client.url.replace(/^http/, 'ws') + '/api/v1/realtime?ticket=' + ticket + '&siteId=' + siteId;
          return new WebSocket(wsUrl);
        },
      },
      auth: {
        me: () =>
          client.rawRequest<{
            logtoId: string;
            email?: string;
            roles: string[];
            siteId: string;
          }>("/api/v1/auth/me"),
      },
      // Phantom type witness
      _schemaType: undefined as unknown as TSchema,
      // Backward compat request method
      request: client.rawRequest,
    };
  };
}
