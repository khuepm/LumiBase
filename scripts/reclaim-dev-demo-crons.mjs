// Explicit release maintenance. Staging changes require a separate opt-in.
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) throw new Error('Cloudflare credentials are required');
const base = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(accountId) + '/workers/scripts';
async function schedules(worker, method = 'GET', crons = []) {
  const response = await fetch(base + '/' + worker + '/schedules', {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(method === 'PUT' ? { body: JSON.stringify(crons.map((cron) => ({ cron }))) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (response.status === 404 && method === 'GET') return [];
  if (!response.ok || !body.success) throw new Error(worker + ' schedule operation failed (HTTP ' + response.status + ')');
  return body.result;
}
for (const worker of ['lumibase-cms-dev', 'lumibase-cms-demo']) {
  console.log(worker, 'before', JSON.stringify(await schedules(worker)));
  const before = await schedules(worker);
  const existing = Array.isArray(before) ? before : before.schedules;
  if (existing?.length) await schedules(worker, 'PUT');
  const remaining = await schedules(worker);
  console.log(worker, 'after', JSON.stringify(remaining));
  const entries = Array.isArray(remaining) ? remaining : remaining.schedules;
  if (!Array.isArray(entries) || entries.length !== 0) throw new Error(worker + ' still has schedules');
}
if (process.env.RESERVE_PRODUCTION_MINUTE === 'true') {
  const worker = 'lumibase-cms-staging';
  const before = await schedules(worker);
  const entries = Array.isArray(before) ? before : before.schedules;
  if (!Array.isArray(entries)) throw new Error('Invalid staging schedules response');
  const kept = entries.map((entry) => entry.cron).filter((cron) => cron !== '* * * * *');
  console.log(worker, 'before', JSON.stringify(entries));
  if (kept.length !== entries.length) await schedules(worker, 'PUT', kept);
  const after = await schedules(worker);
  const remaining = Array.isArray(after) ? after : after.schedules;
  if (!Array.isArray(remaining) ||
      JSON.stringify(remaining.map((entry) => entry.cron).sort()) !== JSON.stringify([...kept].sort())) {
    throw new Error('Staging schedules did not match the requested cron list');
  }
  console.log(worker, 'after', JSON.stringify(remaining));
}
for (const worker of ['lumibase-cms', 'lumibase-cms-staging', 'lumibase-cms-production']) {
  console.log(worker, 'current', JSON.stringify(await schedules(worker)));
}
