import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureFlowQueues, flowQueueNames } from '../ensure-flow-queues.mjs';

const response = (result, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => ({ success: ok, result }) });
test('creates only missing queues in the selected environment and is idempotent', async () => {
  const queues = new Set([flowQueueNames('staging')[0], 'unrelated']);
  const writes = [];
  const fetcher = async (url, options) => {
    if (options.method === 'POST') {
      const name = JSON.parse(options.body).queue_name;
      writes.push(name); queues.add(name); return response({ queue_name: name });
    }
    return response([...queues].map((queue_name) => ({ queue_name })));
  };
  const options = { accountId: 'account', token: 'synthetic-test-token', fetcher };
  await ensureFlowQueues('staging', options);
  await ensureFlowQueues('staging', options);
  assert.deepEqual(writes, flowQueueNames('staging').slice(1));
});
test('fails closed on permission failure and invalid environment', async () => {
  const options = { accountId: 'account', token: 'synthetic-test-token', fetcher: async () => response(null, false) };
  await assert.rejects(ensureFlowQueues('staging', options), /HTTP 403/);
  await assert.rejects(ensureFlowQueues('unknown', options), /Expected/);
});
test('accepts a concurrent successful queue creation', async () => {
  let created = false;
  await ensureFlowQueues('dev', { accountId: 'account', token: 'synthetic-test-token', fetcher: async (_url, options) => {
    if (options.method === 'POST') { created = true; return response(null, false); }
    return response(created ? flowQueueNames('dev').map((queue_name) => ({ queue_name })) : []);
  } });
  assert.equal(created, true);
});
test('provisions the Flows and content queues with their dead-letter queues', () => {
  assert.deepEqual(flowQueueNames('production'), [
    'lumibase-flow-runs-production', 'lumibase-flow-runs-production-dlq',
    'lumibase-flow-events-production', 'lumibase-flow-events-production-dlq',
    'lumibase-content-indexing-production', 'lumibase-content-indexing-production-dlq',
    'lumibase-revalidation-dispatch-production', 'lumibase-revalidation-dispatch-production-dlq',
  ]);
});
