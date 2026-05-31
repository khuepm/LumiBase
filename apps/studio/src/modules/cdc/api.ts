/**
 * Studio-side API helpers for the CDC control plane
 * (ClickHouse CDC — task 13.3; design "CDC API Routes" §7).
 *
 * These thin wrappers call the CMS endpoints under `/api/v1/cdc/` via the
 * shared SDK's `rawRequest` (see `apps/studio/src/lib/api.ts`). The CDC routes
 * are not (yet) part of the typed SDK surface, so we issue raw requests and
 * type the responses against the read models in `./types`.
 *
 * Every response is unwrapped from the `{ data }` envelope the CMS routes use
 * (`serializePipeline` → `{ data }`, metrics → `{ data }`, list →
 * `{ data: { pipelines } }`). Errors surface as the SDK's `LumiError`, which
 * TanStack Query exposes to the components for the Req 6.8 retry UX.
 */

import { getApiClient } from '@/lib/api';
import type {
  HealthCheckResult,
  PipelineCreatePayload,
  PipelineMetrics,
  PipelineSummary,
} from './types';

const BASE = '/api/v1/cdc';

/** List all pipelines for the active site (Req 6.1). */
export async function listPipelines(): Promise<PipelineSummary[]> {
  const res = await getApiClient().rawRequest<{ pipelines: PipelineSummary[] }>(
    `${BASE}/pipelines`,
  );
  return res.data.pipelines;
}

/** Fetch a single pipeline's details (Req 6.4 surface). */
export async function getPipeline(id: string): Promise<PipelineSummary> {
  const res = await getApiClient().rawRequest<PipelineSummary>(
    `${BASE}/pipelines/${encodeURIComponent(id)}`,
  );
  return res.data;
}

/** Fetch a pipeline's current metrics (Req 6.6 — polled at ≤ 10s). */
export async function getPipelineMetrics(id: string): Promise<PipelineMetrics> {
  const res = await getApiClient().rawRequest<PipelineMetrics>(
    `${BASE}/pipelines/${encodeURIComponent(id)}/metrics`,
  );
  return res.data;
}

/** Run a connectivity health check for a pipeline (Req 8.5). */
export async function getPipelineHealth(id: string): Promise<HealthCheckResult> {
  const res = await getApiClient().rawRequest<HealthCheckResult>(
    `${BASE}/pipelines/${encodeURIComponent(id)}/health`,
  );
  return res.data;
}

/** Create a pipeline (Req 6.2). */
export async function createPipeline(
  payload: PipelineCreatePayload,
): Promise<PipelineSummary> {
  const res = await getApiClient().rawRequest<PipelineSummary>(
    `${BASE}/pipelines`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  return res.data;
}

/** Delete a pipeline (Req 6.5 — invoked after the confirmation dialog). */
export async function deletePipeline(id: string): Promise<void> {
  await getApiClient().rawRequest<{ deleted: boolean; id: string }>(
    `${BASE}/pipelines/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}
