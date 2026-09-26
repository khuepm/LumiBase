/**
 * Disposable-site proof: HTTP -> Redis/BullMQ worker -> draft -> HTTP approval
 * -> publish -> verified drift resolution. Only the LLM is a local fixture.
 *
 * Start the CMS with LLM_PROVIDER=nvidia, NVIDIA_API_KEY=local-fixture,
 * NVIDIA_BASE_URL=http://host.docker.internal:23999/v1 and a Docker queue.
 * Run with Node 22+: PROOF_DISPOSABLE=1 node --env-file=<starter>/.env this-file.mjs
 * The target must be a disposable local CMS. No credentials enter the report.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

const base = process.env.NEXT_PUBLIC_LUMIBASE_URL;
const token = process.env.LUMIBASE_ADMIN_TOKEN;
const site = process.env.NEXT_PUBLIC_LUMIBASE_SITE_ID;
assert(base && token && site, 'Starter URL, site and admin token are required');
assert.equal(process.env.PROOF_DISPOSABLE, '1', 'Set PROOF_DISPOSABLE=1 only for a disposable local CMS');
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Local disposable CMS only');
const collection = `proof_${Date.now()}`;
const output = process.env.PROOF_OUTPUT || '/tmp/content-os-http-proof.json';
const events = [];
let providerCalls = 0;
const translated = 'Xin chào từ bản nghiệm thu RC.2';
const record = (step, detail) => {
  const entry = { at: new Date().toISOString(), step, ...detail };
  events.push(entry);
  console.log(JSON.stringify(entry));
};
const fixture = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      assert(body.length < 1_000_000, 'Fixture request too large');
    }
    const input = JSON.parse(body);
    assert.equal(input.model, 'deterministic-translation-fixture');
    providerCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translation: translated }) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }));
  } catch {
    res.writeHead(400).end('Invalid deterministic fixture request');
  }
});
await new Promise((resolve) => fixture.listen(23999, '0.0.0.0', resolve));

async function api(path, body, method = body ? 'POST' : 'GET', credential = token) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${credential}`, 'x-lumi-site': site, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data.data;
}
async function until(label, fn, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}

let verdict = 'failed';
try {
  await api('/settings', { key: 'contentOs', value: { reconciler: true }, scope: 'site' });
  await api('/collections', { name: collection });
  for (const field of [{ name: 'title', type: 'string', interface: 'input' }, { name: 'translations', type: 'json', interface: 'json' }]) {
    const { name, ...definition } = field;
    await api(`/collections/${collection}/fields/${name}`, definition, 'PUT');
  }
  const item = await api(`/items/${collection}`, { data: { title: 'RC2 proof', translations: { en: 'Hello from RC.2 acceptance' } }, status: 'published' });
  const intent = await api('/agent/intents', {
    name: collection, collection, rules: [{ type: 'translations', fields: ['translations'], locales: ['en', 'vi'] }],
    schedule: '0 * * * *', budget: { maxGoalsPerCycle: 10 }, autonomyCap: 2,
  });
  const scan = await api(`/agent/intents/${intent.id}/scan`, {});
  record('intent-and-drift', { collection, itemId: item.id, intentId: intent.id, scan });
  const goal = await until('goal', async () => (await api('/agent/goals')).find((g) => g.intentId === intent.id));
  const draftRun = await until('draft worker', async () => {
    const runs = (await api('/agent/runs')).filter((r) => r.goalId === goal.id);
    const failed = runs.find((r) => r.status === 'failed');
    assert(!failed, `Draft worker failed: ${JSON.stringify(failed)}`);
    const waiting = runs.find((r) => r.status === 'awaiting_approval');
    if (waiting) {
      const approval = (await api('/agent/approvals')).find((a) => a.runId === waiting.id && a.status === 'pending');
      if (approval) {
        assert.equal(providerCalls, 0, 'Provider must not run before draft approval');
        assert.equal((await api(`/items/${collection}/${item.id}`)).data.translations.vi, undefined);
        record('draft-requires-approval', { runId: waiting.id, approvalId: approval.id });
        await api(`/agent/approvals/${approval.id}/decide`, { decision: 'approved', reason: 'Disposable fixture: allow draft creation' });
      }
    }
    return runs.find((r) => r.status === 'succeeded');
  });
  const before = await api(`/items/${collection}/${item.id}`);
  assert.equal(before.data.translations.vi, undefined, 'Draft must not be published');
  record('draft-worker-succeeded', { goalId: goal.id, runId: draftRun.id, publishedTranslationAbsent: true, providerCalls });
  await api(`/agent/intents/${intent.id}/scan`, {});
  const approval = await until('human approval', async () => {
    const runIds = new Set((await api('/agent/runs')).filter((r) => r.goalId === goal.id).map((r) => r.id));
    return (await api('/agent/approvals')).find((a) => runIds.has(a.runId) && a.status === 'pending');
  });
  assert.equal((await api(`/items/${collection}/${item.id}`)).data.translations.vi, undefined);
  record('awaiting-human-approval', { approvalId: approval.id, runId: approval.runId, publishedTranslationAbsent: true });
  const decision = await api(`/agent/approvals/${approval.id}/decide`, { decision: 'approved', reason: 'Disposable RC.2 acceptance fixture; approved by test driver' });
  const after = await api(`/items/${collection}/${item.id}`);
  assert.equal(after.data.translations.vi, translated);
  record('http-approval-published', { approvalId: approval.id, decision, translations: after.data.translations });
  const verify = await api(`/agent/intents/${intent.id}/scan`, {});
  const drifts = await api(`/agent/intents/${intent.id}/drifts`);
  assert(drifts.length > 0 && drifts.every((d) => d.status === 'resolved'));
  const finalGoal = (await api('/agent/goals')).find((g) => g.id === goal.id);
  assert.equal(finalGoal.status, 'done');
  const callsBeforeRepeat = providerCalls;
  await api(`/agent/intents/${intent.id}/scan`, {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(providerCalls, callsBeforeRepeat);
  record('verified-resolution', { goalId: goal.id, status: finalGoal.status, driftIds: drifts.map((d) => d.id), verify, providerCalls });
  verdict = 'passed';
} catch (error) {
  record('failure', { message: error.message });
  process.exitCode = 1;
} finally {
  fixture.close();
  fixture.closeAllConnections();
  await writeFile(output, JSON.stringify({ verdict, base, site, llm: 'deterministic local HTTP fixture; not real model evidence', queue: 'CMS Docker Redis/BullMQ transport', approval: 'real HTTP endpoint; test driver simulates human decision', events }, null, 2) + '\n');
}
