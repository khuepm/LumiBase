// Explicit release maintenance for the dev/demo schedules only.
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) throw new Error('Cloudflare credentials are required');
const base = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(accountId) + '/workers/scripts';
async function schedules(worker, method = 'GET') {
  const response = await fetch(base + '/' + worker + '/schedules', {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(method === 'PUT' ? { body: '[]' } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (response.status === 404 && method === 'GET') return [];
  if (!response.ok || !body.success) throw new Error(worker + ' schedule operation failed (HTTP ' + response.status + ')');
  return body.result;
}
for (const worker of ['lumibase-cms-dev', 'lumibase-cms-demo']) {
  console.log(worker, 'before', JSON.stringify(await schedules(worker)));
  await schedules(worker, 'PUT');
  const remaining = await schedules(worker);
  console.log(worker, 'after', JSON.stringify(remaining));
  const entries = Array.isArray(remaining) ? remaining : remaining.schedules;
  if (!Array.isArray(entries) || entries.length !== 0) throw new Error(worker + ' still has schedules');
}
for (const worker of ['lumibase-cms', 'lumibase-cms-staging', 'lumibase-cms-production']) {
  console.log(worker, 'current', JSON.stringify(await schedules(worker)));
}
