/**
 * Tripwire for the post-deploy CMS check (#461).
 *
 * The probe bodies below are what staging.lumibase.dev answered on 2026-11-01
 * (UTC 2026-10-31T22:17), at main b12e9385: `/health` 200 degraded with the
 * database unhealthy, and `/health/ready` 200 with Studio's index.html because
 * only `/health` was routed to the Worker. The old check (`curl --fail /health`
 * plus the channel) passed on exactly that state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessDeployment, parseJsonBody } from '../verify-cms-deploy.mjs';

const json = (status, value) => ({ status, contentType: 'application/json', body: JSON.stringify(value) });
const STUDIO_HTML = {
  status: 200,
  contentType: 'text/html; charset=utf-8',
  body: '<!doctype html>\n<html lang="en"><head><title>LumiBase Studio</title></head><body><div id="root"></div></body></html>',
};
const DEGRADED = {
  status: 'degraded',
  services: { database: 'unhealthy', cache: 'unhealthy', search: 'unhealthy', storage: 'unhealthy', queue: 'healthy' },
};
const VERSION = json(200, {
  version: '1.0.0-rc.4',
  gitSha: 'b12e9385996a',
  buildTime: '2026-10-31T20:50:13Z',
  releaseChannel: 'staging',
});

test('observed staging state: readiness unrouted fails, although the old check passed', () => {
  const verdict = assessDeployment({
    health: json(200, DEGRADED),
    version: VERSION,
    ready: STUDIO_HTML,
    channel: 'staging',
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /\/health\/ready returned HTML/);
});

test('routed but not ready: a warning with the dependency breakdown, not a failure', () => {
  const verdict = assessDeployment({
    health: json(200, DEGRADED),
    version: VERSION,
    ready: json(503, DEGRADED),
    channel: 'staging',
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0], /database=unhealthy/);
});

test('--require-ready turns a 503 into a failure', () => {
  const verdict = assessDeployment({
    health: json(200, DEGRADED),
    version: VERSION,
    ready: json(503, { status: 'degraded' }),
    channel: 'staging',
    requireReady: true,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0], /503.*detail hidden/);
});

test('the original #461 symptom: /health 500 fails as a boot failure', () => {
  const verdict = assessDeployment({
    health: json(500, { errors: [{ code: 'INTERNAL', message: 'Internal Server Error', requestId: 'pjiTWeYTUsZ_' }] }),
    version: json(500, { errors: [{ code: 'INTERNAL' }] }),
    ready: json(500, { errors: [{ code: 'INTERNAL' }] }),
    channel: 'staging',
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0], /\/health returned 500/);
});

test('/health served by Pages is reported as a routing failure', () => {
  const verdict = assessDeployment({ health: STUDIO_HTML, version: VERSION, ready: json(200, { status: 'healthy' }), channel: 'staging' });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0], /served by Pages/);
});

test('wrong channel fails', () => {
  const verdict = assessDeployment({
    health: json(200, { status: 'healthy' }),
    version: json(200, { releaseChannel: 'production' }),
    ready: json(200, { status: 'healthy' }),
    channel: 'staging',
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0], /releaseChannel="production", expected "staging"/);
});

test('fully healthy deploy passes with no warnings', () => {
  const verdict = assessDeployment({
    health: json(200, { status: 'healthy' }),
    version: VERSION,
    ready: json(200, { status: 'healthy' }),
    channel: 'staging',
    requireReady: true,
  });
  assert.deepEqual({ ok: verdict.ok, failures: verdict.failures, warnings: verdict.warnings }, { ok: true, failures: [], warnings: [] });
});

test('HTML is recognised by body even without a content-type', () => {
  assert.equal(parseJsonBody({ contentType: '', body: '  <!doctype html>' }).kind, 'html');
  assert.equal(parseJsonBody({ contentType: 'application/json', body: '{"status":"healthy"}' }).kind, 'json');
});
