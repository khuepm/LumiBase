#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

/**
 * Logical queues the deploy provisions: the Flows queues (B118), the content
 * side-effect queues and the envelope-migration queue (B131). `agent-runs` predates this script and is created
 * by hand (DEPLOYMENT-CHECKLIST).
 */
export const PROVISIONED_QUEUES = [
  'flow-runs',
  'flow-events',
  'content-indexing',
  'revalidation-dispatch',
  'encryption-envelope-migration',
];

export function flowQueueNames(environment) {
  if (!['dev', 'staging', 'demo', 'production'].includes(environment)) {
    throw new Error('Expected dev, staging, demo or production');
  }
  return PROVISIONED_QUEUES.flatMap((logical) => [
    `lumibase-${logical}-${environment}`,
    `lumibase-${logical}-${environment}-dlq`,
  ]);
}

/** Provision only this deployment's queues. Existing queues are untouched. */
export async function ensureFlowQueues(environment, { accountId, token, fetcher = fetch }) {
  const names = flowQueueNames(environment);
  if (!accountId || !token) throw new Error('Cloudflare deploy credentials are required');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/queues`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function request(url, options = {}) {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(30_000), ...options });
    const body = await response.json();
    if (!response.ok || body.success !== true) {
      throw new Error(`Flow queue provisioning failed (HTTP ${response.status})`);
    }
    return body.result;
  }
  async function exists(name) {
    const result = await request(`${endpoint}?name=${encodeURIComponent(name)}`);
    if (!Array.isArray(result)) throw new Error('Invalid Cloudflare queue listing');
    return result.some((queue) => queue.queue_name === name);
  }
  for (const name of names) {
    if (await exists(name)) continue;
    try {
      await request(endpoint, { method: 'POST', body: JSON.stringify({ queue_name: name }) });
    } catch (error) {
      // Concurrent deployments may create the same queue after our read.
      if (!await exists(name)) throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await ensureFlowQueues(process.argv[2], {
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    console.log('Worker queues are ready');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
