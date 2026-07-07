import { LumiClient } from "../client";
import {
  DefaultSchema,
  ListItemsParams,
  ItemRow,
  ListItemsResponse,
  CdcDeployInput,
  CdcDeploymentResult,
  CdcEnvValidationResult,
  CdcHealthCheckResult,
  CdcHealthMetricEntry,
  CdcPipelineCreateInput,
  CdcPipelineMetrics,
  CdcPipelinePatchInput,
  CdcPipelineResource,
  CdcRollbackResult,
  CdcValidateEnvInput,
  AccessExportManifest,
  AccessImportApplyResult,
  AccessImportDryRunResult,
  AccessImportOptions,
  AgentApprovalResource,
  AgentArtifactCreateInput,
  AgentArtifactResource,
  AgentEvaluationResource,
  AgentGenerateAppInput,
  AgentGenerateAppResult,
  AgentGoalCreateInput,
  AgentGoalResource,
  AgentMemoryContext,
  AgentMemoryWriteInput,
  AgentRunResource,
  AgentToolResource,
  SearchParams,
  SearchResponse,
} from "../types";

export * from "./legacy";

/**
 * Full-text search via `GET /api/v1/search`. Omit `params.collection` for a
 * cross-collection (global) search that fans out over every collection of the
 * current site; pass it to scope to one collection. Diacritics-insensitive
 * matching (e.g. "ha noi" → "Hà Nội") is handled server-side by MeiliSearch.
 */
export function search<Schema extends DefaultSchema>(query: string, params?: SearchParams) {
  return async (client: LumiClient<Schema>): Promise<SearchResponse> => {
    const qs = new URLSearchParams();
    qs.set("q", query);
    if (params?.collection) qs.set("collection", params.collection);
    if (params?.filter) qs.set("filter", params.filter);
    if (params?.sort?.length) qs.set("sort", params.sort.join(","));
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));

    const res = await client.rawRequest<unknown>(`/api/v1/search?${qs.toString()}`);
    return res as unknown as SearchResponse;
  };
}

export function readItems<
  Schema extends DefaultSchema,
  Collection extends keyof Schema & string,
  Row = ItemRow<Schema[Collection] extends Record<string, unknown> ? Schema[Collection] : Record<string, unknown>>,
  ListResp = ListItemsResponse<Schema[Collection] extends Record<string, unknown> ? Schema[Collection] : Record<string, unknown>>
>(collection: Collection, params?: ListItemsParams) {
  return async (client: LumiClient<Schema>): Promise<ListResp> => {
    const qs = new URLSearchParams();
    if (params?.fields?.length) qs.set("fields", params.fields.join(","));
    if (params?.filter) qs.set("filter", JSON.stringify(params.filter));
    if (params?.sort?.length) qs.set("sort", params.sort.join(","));
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    if (params?.status) qs.set("status", params.status);
    if (params?.meta) qs.set("meta", params.meta);

    const s = qs.toString();
    const query = s ? `?${s}` : "";

    const res = await client.rawRequest<ListResp[keyof ListResp]>(`/api/v1/items/${collection}${query}`);
    return res as unknown as ListResp;
  };
}

export function readItem<
  Schema extends DefaultSchema,
  Collection extends keyof Schema & string,
  Row = ItemRow<Schema[Collection] extends Record<string, unknown> ? Schema[Collection] : Record<string, unknown>>
>(collection: Collection, id: string, fields?: string[]) {
  return async (client: LumiClient<Schema>): Promise<Row> => {
    const res = await client.rawRequest<Row>(
      `/api/v1/items/${collection}/${id}${fields?.length ? `?fields=${fields.join(",")}` : ""}`
    );
    return res as unknown as Row;
  };
}

export function exportAccessManifest() {
  return async (client: LumiClient): Promise<AccessExportManifest> => {
    const res = await client.rawRequest<AccessExportManifest>("/api/v1/access/export");
    return res.data;
  };
}

export function dryRunAccessImport(manifest: AccessExportManifest) {
  return async (client: LumiClient): Promise<AccessImportDryRunResult> => {
    const res = await client.rawRequest<AccessImportDryRunResult>("/api/v1/access/import?dryRun=true", {
      method: "POST",
      body: JSON.stringify(manifest),
    });
    return res.data;
  };
}

export function importAccessManifest(
  manifest: AccessExportManifest,
  options: AccessImportOptions = {},
) {
  return async (client: LumiClient): Promise<AccessImportApplyResult> => {
    const query = options.mode ? `?mode=${encodeURIComponent(options.mode)}` : "";
    const res = await client.rawRequest<AccessImportApplyResult>(`/api/v1/access/import${query}`, {
      method: "POST",
      body: JSON.stringify(manifest),
    });
    return res.data;
  };
}

export function createCdcPipeline(input: CdcPipelineCreateInput) {
  return async (client: LumiClient): Promise<CdcPipelineResource> => {
    const res = await client.rawRequest<CdcPipelineResource>("/api/v1/cdc/pipelines", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function listCdcPipelines() {
  return async (client: LumiClient): Promise<CdcPipelineResource[]> => {
    const res = await client.rawRequest<{ pipelines: CdcPipelineResource[] }>("/api/v1/cdc/pipelines");
    return res.data.pipelines;
  };
}

export function readCdcPipeline(id: string) {
  return async (client: LumiClient): Promise<CdcPipelineResource> => {
    const res = await client.rawRequest<CdcPipelineResource>(`/api/v1/cdc/pipelines/${id}`);
    return res.data;
  };
}

export function updateCdcPipeline(id: string, input: CdcPipelinePatchInput) {
  return async (client: LumiClient): Promise<CdcPipelineResource> => {
    const res = await client.rawRequest<CdcPipelineResource>(`/api/v1/cdc/pipelines/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function deleteCdcPipeline(id: string) {
  return async (client: LumiClient): Promise<{ deleted: boolean; id: string }> => {
    const res = await client.rawRequest<{ deleted: boolean; id: string }>(`/api/v1/cdc/pipelines/${id}`, {
      method: "DELETE",
    });
    return res.data;
  };
}

export function startCdcPipeline(id: string) {
  return async (client: LumiClient): Promise<CdcPipelineResource> => {
    const res = await client.rawRequest<CdcPipelineResource>(`/api/v1/cdc/pipelines/${id}/start`, {
      method: "POST",
    });
    return res.data;
  };
}

export function stopCdcPipeline(id: string) {
  return async (client: LumiClient): Promise<CdcPipelineResource> => {
    const res = await client.rawRequest<CdcPipelineResource>(`/api/v1/cdc/pipelines/${id}/stop`, {
      method: "POST",
    });
    return res.data;
  };
}

export function checkCdcPipelineHealth(id: string) {
  return async (client: LumiClient): Promise<CdcHealthCheckResult> => {
    const res = await client.rawRequest<CdcHealthCheckResult>(`/api/v1/cdc/pipelines/${id}/health`);
    return res.data;
  };
}

export function readCdcPipelineMetrics(id: string) {
  return async (client: LumiClient): Promise<CdcPipelineMetrics> => {
    const res = await client.rawRequest<CdcPipelineMetrics>(`/api/v1/cdc/pipelines/${id}/metrics`);
    return res.data;
  };
}

export function readCdcPipelineMetricHistory(id: string, since?: string | Date) {
  return async (client: LumiClient): Promise<{ history: CdcHealthMetricEntry[]; since: string }> => {
    const value = since instanceof Date ? since.toISOString() : since;
    const query = value ? `?since=${encodeURIComponent(value)}` : "";
    const res = await client.rawRequest<{ history: CdcHealthMetricEntry[]; since: string }>(
      `/api/v1/cdc/pipelines/${id}/metrics/history${query}`,
    );
    return res.data;
  };
}

export function deployCdc(input: CdcDeployInput) {
  return async (client: LumiClient): Promise<CdcDeploymentResult> => {
    const res = await client.rawRequest<CdcDeploymentResult>("/api/v1/cdc/deploy", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function validateCdcDeploymentEnv(input: CdcValidateEnvInput) {
  return async (client: LumiClient): Promise<CdcEnvValidationResult> => {
    const res = await client.rawRequest<CdcEnvValidationResult>("/api/v1/cdc/deploy/validate-env", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function rollbackCdcDeployment(id: string) {
  return async (client: LumiClient): Promise<CdcRollbackResult> => {
    const res = await client.rawRequest<CdcRollbackResult>(`/api/v1/cdc/deploy/${id}/rollback`, {
      method: "POST",
    });
    return res.data;
  };
}

export function listAgentGoals() {
  return async (client: LumiClient): Promise<AgentGoalResource[]> => {
    const res = await client.rawRequest<AgentGoalResource[]>("/api/v1/agent/goals");
    return res.data;
  };
}

export function createAgentGoal(input: AgentGoalCreateInput) {
  return async (client: LumiClient): Promise<AgentGoalResource> => {
    const res = await client.rawRequest<AgentGoalResource>("/api/v1/agent/goals", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function listAgentRuns() {
  return async (client: LumiClient): Promise<AgentRunResource[]> => {
    const res = await client.rawRequest<AgentRunResource[]>("/api/v1/agent/runs");
    return res.data;
  };
}

export function retryAgentRun(id: string) {
  return async (client: LumiClient): Promise<{ goalId: string; runId: string; agentName: string }> => {
    const res = await client.rawRequest<{ goalId: string; runId: string; agentName: string }>(`/api/v1/agent/runs/${id}/retry`, {
      method: "POST",
    });
    return res.data;
  };
}

export function listAgentTools() {
  return async (client: LumiClient): Promise<AgentToolResource[]> => {
    const res = await client.rawRequest<AgentToolResource[]>("/api/v1/agent/tools");
    return res.data;
  };
}

export function listAgentApprovals() {
  return async (client: LumiClient): Promise<AgentApprovalResource[]> => {
    const res = await client.rawRequest<AgentApprovalResource[]>("/api/v1/agent/approvals");
    return res.data;
  };
}

export function decideAgentApproval(id: string, decision: "approved" | "rejected", reason?: string) {
  return async (client: LumiClient): Promise<AgentApprovalResource> => {
    const res = await client.rawRequest<AgentApprovalResource>(`/api/v1/agent/approvals/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, reason }),
    });
    return res.data;
  };
}

export function listAgentArtifacts(runId?: string) {
  return async (client: LumiClient): Promise<AgentArtifactResource[]> => {
    const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    const res = await client.rawRequest<AgentArtifactResource[]>(`/api/v1/agent/artifacts${query}`);
    return res.data;
  };
}

export function createAgentArtifact(input: AgentArtifactCreateInput) {
  return async (client: LumiClient): Promise<AgentArtifactResource> => {
    const res = await client.rawRequest<AgentArtifactResource>("/api/v1/agent/artifacts", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function evaluateAgentArtifact(id: string, runId: string) {
  return async (client: LumiClient): Promise<AgentEvaluationResource> => {
    const res = await client.rawRequest<AgentEvaluationResource>(`/api/v1/agent/artifacts/${id}/evaluate?runId=${encodeURIComponent(runId)}`, {
      method: "POST",
    });
    return res.data;
  };
}

export function publishAgentArtifact(id: string, overrideReason?: string) {
  return async (client: LumiClient): Promise<AgentArtifactResource> => {
    const res = await client.rawRequest<AgentArtifactResource>(`/api/v1/agent/artifacts/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ overrideReason }),
    });
    return res.data;
  };
}

export function rollbackAgentArtifact(id: string, reason?: string) {
  return async (client: LumiClient): Promise<AgentArtifactResource> => {
    const res = await client.rawRequest<AgentArtifactResource>(`/api/v1/agent/artifacts/${id}/rollback`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    return res.data;
  };
}

export function readAgentMemoryContext(scope?: string, scopeId?: string) {
  return async (client: LumiClient): Promise<AgentMemoryContext> => {
    const qs = new URLSearchParams();
    if (scope) qs.set("scope", scope);
    if (scopeId) qs.set("scopeId", scopeId);
    const query = qs.toString() ? `?${qs.toString()}` : "";
    const res = await client.rawRequest<AgentMemoryContext>(`/api/v1/agent/memory${query}`);
    return res.data;
  };
}

export function writeAgentMemory(input: AgentMemoryWriteInput) {
  return async (client: LumiClient): Promise<AgentMemoryContext["memories"][number]> => {
    const res = await client.rawRequest<AgentMemoryContext["memories"][number]>("/api/v1/agent/memory", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function generateAgentApp(input: AgentGenerateAppInput) {
  return async (client: LumiClient): Promise<AgentGenerateAppResult> => {
    const res = await client.rawRequest<AgentGenerateAppResult>("/api/v1/agent/generate-app", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}
