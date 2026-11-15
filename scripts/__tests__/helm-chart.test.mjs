// Helm chart render tests (#742). Each test runs `helm template` with a value
// set and asserts on the parsed manifests: the env contract the image reads,
// hardening, probes on the real health routes, migration modes, secret
// handling, and the render-time refusals. The kind smoke test
// (scripts/helm-kind-smoke.sh, .github/workflows/helm.yml) covers what only a
// cluster can show; this covers every value combination cheaply.
//
// Skips when `helm` is not on PATH, unless HELM_REQUIRED=1 (CI), where a
// missing binary is a failure rather than a silent pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { REQUIRED_PRODUCTION_VARS, encryptionKeyProblem } from '../../docker/scripts/entrypoint-lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const chart = join(root, 'deploy/helm/lumibase');
const helmAvailable = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0;
if (!helmAvailable && process.env.HELM_REQUIRED === '1') {
  throw new Error('HELM_REQUIRED=1 but `helm` is not on PATH');
}
const skip = helmAvailable ? false : 'helm is not installed';

const BASE = ['--set', 'publicUrl=https://cms.example.com'];

/** Render the chart; returns { ok, docs, stderr }. */
function render(args = BASE, { release = 'lb', namespace = 'ns' } = {}) {
  const res = spawnSync('helm', ['template', release, chart, '--namespace', namespace, ...args], {
    encoding: 'utf8',
  });
  if (res.status !== 0) return { ok: false, docs: [], stderr: res.stderr };
  const docs = yaml.loadAll(res.stdout).filter(Boolean);
  return { ok: true, docs, stderr: res.stderr };
}

function mustRender(args) {
  const out = render(args);
  assert.ok(out.ok, `helm template failed:\n${out.stderr}`);
  return out.docs;
}

const find = (docs, kind, name) => docs.find((d) => d.kind === kind && (!name || d.metadata.name === name));
const all = (docs, kind) => docs.filter((d) => d.kind === kind);
const container = (deploy, name) => deploy.spec.template.spec.containers.find((c) => c.name === name);
const envNames = (c) => (c.env ?? []).map((e) => e.name);
const envOf = (c, name) => (c.env ?? []).find((e) => e.name === name);

const dockerfile = readFileSync(join(root, 'docker/Dockerfile'), 'utf8');

test('chart and app version follow the root package.json', () => {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const chartYaml = yaml.load(readFileSync(join(chart, 'Chart.yaml'), 'utf8'));
  assert.equal(chartYaml.version, version);
  assert.equal(chartYaml.appVersion, version);
});

test('helm lint passes with the kind CI values', { skip }, () => {
  const res = spawnSync('helm', ['lint', chart, '--strict', '-f', join(chart, 'ci/kind-values.yaml')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('defaults render the CMS, bundled PostgreSQL and Redis, and nothing optional', { skip }, () => {
  const docs = mustRender();
  const kinds = docs.map((d) => `${d.kind}/${d.metadata.name}`).sort();
  assert.deepEqual(kinds, [
    'ConfigMap/lb-lumibase',
    'Deployment/lb-lumibase',
    'Pod/lb-lumibase-test-health',
    'Secret/lb-lumibase',
    'Service/lb-lumibase',
    'Service/lb-lumibase-postgresql',
    'Service/lb-lumibase-redis',
    'ServiceAccount/lb-lumibase',
    'StatefulSet/lb-lumibase-postgresql',
    'StatefulSet/lb-lumibase-redis',
  ]);
});

test('every variable production refuses to start without is provided', { skip }, () => {
  const docs = mustRender();
  const cm = find(docs, 'ConfigMap');
  const cms = container(find(docs, 'Deployment', 'lb-lumibase'), 'cms');
  const provided = new Set([...Object.keys(cm.data), ...envNames(cms)]);
  for (const name of REQUIRED_PRODUCTION_VARS) assert.ok(provided.has(name), `${name} not provided`);
  assert.equal(cm.data.NODE_ENV, 'production');
  assert.equal(cm.data.LUMIBASE_RUNTIME, 'docker');
  assert.equal(cm.data.CORS_ALLOWED_ORIGINS, 'https://cms.example.com');
  assert.equal(cm.data.LUMIBASE_PUBLIC_URL, 'https://cms.example.com');
  assert.equal(cm.data.LUMIBASE_REQUIRE_SETUP_TOKEN, 'true');
  // Bundled PostgreSQL has no TLS on the pod network.
  assert.equal(cm.data.DATABASE_SSL_MODE, 'disable');
});

test('the port and health routes are the ones the image serves', { skip }, () => {
  const exposed = dockerfile.match(/^EXPOSE (\d+)$/m)?.[1];
  const docs = mustRender();
  const cm = find(docs, 'ConfigMap');
  const cms = container(find(docs, 'Deployment', 'lb-lumibase'), 'cms');
  assert.equal(String(cms.ports[0].containerPort), exposed);
  assert.equal(cm.data.PORT, exposed);
  const health = readFileSync(join(root, 'apps/cms/src/routes/health.ts'), 'utf8');
  assert.match(readFileSync(join(root, 'apps/cms/src/index.ts'), 'utf8'), /app\.route\('\/health', healthRouter\)/);
  assert.match(health, /healthRouter\.get\('\/ready'/);
  assert.match(health, /healthRouter\.get\('\/live'/);
  // Liveness/startup never depend on PostgreSQL/Redis: an outage must not restart pods.
  assert.equal(cms.livenessProbe.httpGet.path, '/health/live');
  assert.equal(cms.startupProbe.httpGet.path, '/health/live');
  // No search and no object storage: /health/ready would answer 503 forever.
  assert.equal(cms.readinessProbe.httpGet.path, '/health');
});

test('readiness switches to /health/ready once search and storage are configured', { skip }, () => {
  const docs = mustRender([
    ...BASE,
    '--set', 'meilisearch.enabled=true',
    '--set', 's3.endpoint=https://s3.example.com',
    '--set', 's3.accessKey=AKIAEXAMPLE',
    '--set', 's3.secretKey=example-secret',
  ]);
  const cms = container(find(docs, 'Deployment', 'lb-lumibase'), 'cms');
  assert.equal(cms.readinessProbe.httpGet.path, '/health/ready');
  const cm = find(docs, 'ConfigMap');
  assert.equal(cm.data.MEILISEARCH_HOST, 'http://lb-lumibase-meilisearch:7700');
  assert.equal(cm.data.S3_ENDPOINT, 'https://s3.example.com');
  // Credentials go to the Secret, never the ConfigMap.
  assert.ok(!JSON.stringify(cm).includes('example-secret'));
  assert.ok(!JSON.stringify(cm).includes('AKIAEXAMPLE'));
  for (const name of ['MEILISEARCH_API_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']) {
    assert.ok(envOf(cms, name)?.valueFrom?.secretKeyRef, `${name} must come from a Secret`);
  }
  assert.ok(find(docs, 'StatefulSet', 'lb-lumibase-meilisearch'));
});

test('CMS pods are non-root with a read-only root filesystem and no capabilities', { skip }, () => {
  const docs = mustRender();
  const deploy = find(docs, 'Deployment', 'lb-lumibase');
  const pod = deploy.spec.template.spec;
  // The image's numeric USER, so runAsNonRoot admission can verify it.
  const user = dockerfile.match(/^USER (\d+):(\d+)$/m);
  assert.equal(String(pod.securityContext.runAsUser), user[1]);
  assert.equal(String(pod.securityContext.runAsGroup), user[2]);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(pod.automountServiceAccountToken, false);
  for (const c of [...pod.initContainers, ...pod.containers]) {
    assert.equal(c.securityContext.readOnlyRootFilesystem, true, c.name);
    assert.equal(c.securityContext.allowPrivilegeEscalation, false, c.name);
    assert.deepEqual(c.securityContext.capabilities.drop, ['ALL'], c.name);
    assert.ok(c.volumeMounts.some((m) => m.mountPath === '/tmp'), `${c.name} needs a writable /tmp`);
  }
  assert.ok(container(deploy, 'cms').resources.requests.memory);
  // Every StatefulSet runs hardened too.
  for (const sts of all(docs, 'StatefulSet')) {
    const spec = sts.spec.template.spec;
    assert.equal(spec.securityContext.runAsNonRoot, true, sts.metadata.name);
    assert.equal(spec.containers[0].securityContext.readOnlyRootFilesystem, true, sts.metadata.name);
  }
});

test('initContainer migrations: preflight via the entrypoint, then migrate.cjs apply', { skip }, () => {
  const docs = mustRender();
  const deploy = find(docs, 'Deployment', 'lb-lumibase');
  const [preflight, migrate] = deploy.spec.template.spec.initContainers;
  assert.equal(preflight.name, 'migrate-preflight');
  assert.equal(preflight.command, undefined, 'preflight must run the image entrypoint');
  assert.equal(envOf(preflight, 'MIGRATION_MODE').value, 'preflight');
  assert.deepEqual(migrate.command, ['/nodejs/bin/node', '/app/dist/migrate.cjs', 'apply']);
  // The paths exist in the image as built.
  assert.match(dockerfile, /COPY --from=builder \/app\/apps\/cms\/dist \.\/dist/);
  assert.match(dockerfile, /^WORKDIR \/app$/m);
  assert.match(readFileSync(join(root, 'apps/cms/package.json'), 'utf8'), /--outfile=dist\/migrate\.cjs/);
  for (const c of [preflight, migrate]) assert.ok(envNames(c).includes('DATABASE_URL'), c.name);
  const cms = container(deploy, 'cms');
  assert.equal(envOf(cms, 'SKIP_MIGRATIONS').value, 'true');
  // No Job in this mode, and nothing stops the history early by default.
  assert.equal(find(docs, 'Job'), undefined);
  for (const c of [preflight, migrate]) assert.equal(envOf(c, 'MIGRATE_TARGET'), undefined, c.name);
});

// The image's migrator is what makes concurrent web pods safe: it must take
// the advisory lock around the apply and offer the read-only `wait` gate the
// chart calls.
test('the bundled migrator locks the apply and implements the wait gate', () => {
  const cli = readFileSync(join(root, 'packages/database/scripts/migrate.ts'), 'utf8');
  const runner = readFileSync(join(root, 'packages/database/src/migration-runner.ts'), 'utf8');
  assert.match(cli, /await withMigrationLock\(\s*client,/);
  assert.match(cli, /case 'wait':/);
  assert.match(cli, /--timeout/);
  assert.match(cli, /process\.env\.MIGRATE_TARGET/);
  assert.match(runner, /pg_try_advisory_lock\(\$1::bigint\)/);
  assert.match(runner, /pg_advisory_unlock\(\$1::bigint\)/);
});

const gateOf = (deploy) => (deploy.spec.template.spec.initContainers ?? []).find((c) => c.name === 'migrations-ready');

test('the worker waits for the schema in every mode but none; web pods keep the migrator', { skip }, () => {
  for (const mode of ['initContainer', 'job', 'entrypoint']) {
    const docs = mustRender([...BASE, '--set', 'worker.enabled=true', '--set', `migrations.mode=${mode}`]);
    const worker = find(docs, 'Deployment', 'lb-lumibase-worker');
    const [gate, ...rest] = worker.spec.template.spec.initContainers;
    assert.equal(rest.length, 0, `${mode}: the worker never runs a migrator`);
    assert.equal(gate.name, 'migrations-ready', mode);
    assert.deepEqual(gate.command, ['/nodejs/bin/node', '/app/dist/migrate.cjs', 'wait', '--timeout', '600'], mode);
    assert.ok(envNames(gate).includes('DATABASE_URL'), mode);
    // Same image and hardening as the web migrator.
    const web = find(docs, 'Deployment', 'lb-lumibase');
    assert.equal(gate.image, container(web, 'cms').image, mode);
    assert.equal(gate.securityContext.readOnlyRootFilesystem, true, mode);
    assert.equal(gate.securityContext.allowPrivilegeEscalation, false, mode);
    assert.deepEqual(gate.securityContext.capabilities.drop, ['ALL'], mode);
    assert.ok(gate.volumeMounts.some((m) => m.mountPath === '/tmp'), mode);
    assert.equal(envOf(container(worker, 'worker'), 'SKIP_MIGRATIONS').value, 'true', mode);
  }
  const init = find(mustRender([...BASE, '--set', 'worker.enabled=true']), 'Deployment', 'lb-lumibase');
  assert.deepEqual(init.spec.template.spec.initContainers.map((c) => c.name), ['migrate-preflight', 'migrate']);

  const none = find(mustRender([...BASE, '--set', 'worker.enabled=true', '--set', 'migrations.mode=none']), 'Deployment', 'lb-lumibase-worker');
  assert.equal(none.spec.template.spec.initContainers, undefined);
  const timeout = find(
    mustRender([...BASE, '--set', 'worker.enabled=true', '--set', 'migrations.waitTimeoutSeconds=1200']),
    'Deployment',
    'lb-lumibase-worker',
  );
  assert.equal(gateOf(timeout).command.at(-1), '1200');
});

test('migrations.mode=job: one hardened Job applies, web and worker pods wait', { skip }, () => {
  const args = [...BASE, '--set', 'worker.enabled=true', '--set', 'migrations.mode=job', '--set', 'networkPolicy.enabled=true'];
  const docs = mustRender(args);
  const jobs = all(docs, 'Job');
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.match(job.metadata.name, /^lb-lumibase-migrate-[0-9a-f]{10}$/);
  // An ordinary release resource, not a hook (see the template comment).
  assert.equal(job.metadata.annotations?.['helm.sh/hook'], undefined);
  assert.equal(job.metadata.labels['app.kubernetes.io/component'], 'migrate');
  const pod = job.spec.template.spec;
  assert.equal(pod.restartPolicy, 'Never');
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.initContainers.map((c) => c.name), ['migrate-preflight']);
  assert.deepEqual(pod.containers[0].command, ['/nodejs/bin/node', '/app/dist/migrate.cjs', 'apply']);
  for (const c of [...pod.initContainers, ...pod.containers]) {
    assert.equal(c.securityContext.readOnlyRootFilesystem, true, c.name);
    assert.ok(envNames(c).includes('DATABASE_URL'), c.name);
  }
  // Web pods only wait; the server still skips migrations.
  const web = find(docs, 'Deployment', 'lb-lumibase');
  assert.deepEqual(web.spec.template.spec.initContainers.map((c) => c.name), ['migrations-ready']);
  assert.equal(envOf(container(web, 'cms'), 'SKIP_MIGRATIONS').value, 'true');
  // The Job's pods may reach the bundled database.
  const pg = find(docs, 'NetworkPolicy', 'lb-lumibase-postgresql');
  const components = pg.spec.ingress[0].from.map((f) => f.podSelector.matchLabels['app.kubernetes.io/component']);
  assert.deepEqual(components, ['cms', 'worker', 'migrate']);

  // The name follows the pod spec: same values → same Job (a re-sync leaves
  // the finished Job alone), new image → new Job (pod templates are immutable).
  assert.equal(find(mustRender(args), 'Job').metadata.name, job.metadata.name);
  const bumped = find(mustRender([...args, '--set', 'image.tag=9.9.9']), 'Job');
  assert.notEqual(bumped.metadata.name, job.metadata.name);
  const longName = find(mustRender([...args, '--set', `fullnameOverride=${'x'.repeat(63)}`]), 'Job');
  assert.ok(longName.metadata.name.length <= 63);
  assert.match(longName.metadata.name, /-[0-9a-f]{10}$/);
});

test('migrations.target reaches every runner and gate, and only them', { skip }, () => {
  const docs = mustRender([
    ...BASE,
    '--set', 'worker.enabled=true',
    '--set', 'migrations.target=0029_activation_milestones',
  ]);
  const web = find(docs, 'Deployment', 'lb-lumibase');
  const worker = find(docs, 'Deployment', 'lb-lumibase-worker');
  for (const c of [...web.spec.template.spec.initContainers, gateOf(worker)]) {
    assert.equal(envOf(c, 'MIGRATE_TARGET').value, '0029_activation_milestones', c.name);
  }
  assert.equal(envOf(container(worker, 'worker'), 'MIGRATE_TARGET'), undefined);
  const entry = find(
    mustRender([...BASE, '--set', 'migrations.mode=entrypoint', '--set', 'migrations.target=0029_activation_milestones']),
    'Deployment',
    'lb-lumibase',
  );
  assert.equal(envOf(container(entry, 'cms'), 'MIGRATE_TARGET').value, '0029_activation_milestones');
  assert.equal(render([...BASE, '--set', 'migrations.target=latest; DROP TABLE x']).ok, false);
});

test('migrations.mode=entrypoint lets the image migrate; none skips everywhere', { skip }, () => {
  const entry = find(mustRender([...BASE, '--set', 'migrations.mode=entrypoint']), 'Deployment', 'lb-lumibase');
  assert.equal(entry.spec.template.spec.initContainers, undefined);
  assert.equal(envOf(container(entry, 'cms'), 'SKIP_MIGRATIONS'), undefined);
  const none = find(mustRender([...BASE, '--set', 'migrations.mode=none']), 'Deployment', 'lb-lumibase');
  assert.equal(none.spec.template.spec.initContainers, undefined);
  assert.equal(envOf(container(none, 'cms'), 'SKIP_MIGRATIONS').value, 'true');
  assert.equal(render([...BASE, '--set', 'migrations.mode=hook']).ok, false);
});

test('bundled service URLs are assembled from the password, never stored', { skip }, () => {
  const docs = mustRender();
  const cms = container(find(docs, 'Deployment', 'lb-lumibase'), 'cms');
  const names = envNames(cms);
  assert.ok(names.indexOf('LUMIBASE_HELM_POSTGRES_PASSWORD') < names.indexOf('DATABASE_URL'));
  assert.equal(
    envOf(cms, 'DATABASE_URL').value,
    'postgresql://lumibase:$(LUMIBASE_HELM_POSTGRES_PASSWORD)@lb-lumibase-postgresql:5432/lumibase',
  );
  assert.equal(envOf(cms, 'REDIS_URL').value, 'redis://:$(LUMIBASE_HELM_REDIS_PASSWORD)@lb-lumibase-redis:6379');
  const secret = find(docs, 'Secret');
  assert.deepEqual(Object.keys(secret.data).sort(), ['ENCRYPTION_KEY', 'JWT_SECRET', 'postgres-password', 'redis-password']);
  const pg = find(docs, 'StatefulSet', 'lb-lumibase-postgresql').spec.template.spec.containers[0];
  assert.deepEqual(envOf(pg, 'POSTGRES_PASSWORD').valueFrom.secretKeyRef, { name: 'lb-lumibase', key: 'postgres-password' });
  // BullMQ needs noeviction.
  const redis = find(docs, 'StatefulSet', 'lb-lumibase-redis').spec.template.spec.containers[0];
  assert.match(redis.command.join(' '), /--maxmemory-policy noeviction/);
});

test('generated secrets are values the server accepts and are kept on uninstall', { skip }, () => {
  for (let i = 0; i < 5; i++) {
    const secret = find(mustRender(), 'Secret');
    const key = Buffer.from(secret.data.ENCRYPTION_KEY, 'base64').toString('utf8');
    assert.equal(encryptionKeyProblem({ NODE_ENV: 'production', ENCRYPTION_KEY: key }), undefined, key);
    assert.ok(Buffer.from(key, 'base64').byteLength === 32);
    assert.ok(Buffer.from(secret.data.JWT_SECRET, 'base64').toString('utf8').length >= 32);
    assert.equal(secret.metadata.annotations['helm.sh/resource-policy'], 'keep');
  }
});

test('explicit secrets are used as given; a malformed ENCRYPTION_KEY fails the render', { skip }, () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const docs = mustRender([...BASE, '--set', `secrets.encryptionKey=${key}`, '--set', `secrets.jwtSecret=${'j'.repeat(40)}`]);
  const secret = find(docs, 'Secret');
  assert.equal(Buffer.from(secret.data.ENCRYPTION_KEY, 'base64').toString('utf8'), key);
  const bad = render([...BASE, '--set', 'secrets.encryptionKey=not-a-key']);
  assert.equal(bad.ok, false);
  assert.match(bad.stderr, /secrets\.encryptionKey must be standard padded base64/);
  // Base64 of 20 bytes: valid base64, wrong AES key size.
  assert.equal(render([...BASE, '--set', `secrets.encryptionKey=${Buffer.alloc(20).toString('base64')}`]).ok, false);
  // Schema: a short JWT secret is refused.
  assert.equal(render([...BASE, '--set', 'secrets.jwtSecret=short']).ok, false);
});

test('secrets.existingSecret: the chart stores neither JWT_SECRET nor ENCRYPTION_KEY', { skip }, () => {
  const docs = mustRender([...BASE, '--set', 'secrets.existingSecret=lumibase-app']);
  const secret = find(docs, 'Secret');
  assert.ok(!('JWT_SECRET' in secret.data));
  assert.ok(!('ENCRYPTION_KEY' in secret.data));
  const cms = container(find(docs, 'Deployment', 'lb-lumibase'), 'cms');
  for (const name of ['JWT_SECRET', 'ENCRYPTION_KEY']) {
    assert.deepEqual(envOf(cms, name).valueFrom.secretKeyRef, { name: 'lumibase-app', key: name });
  }
});

test('external PostgreSQL and Redis: no bundled StatefulSets, URLs from Secrets', { skip }, () => {
  const docs = mustRender([
    ...BASE,
    '--set', 'postgresql.enabled=false',
    '--set', 'database.external.existingSecret=db',
    '--set', 'redis.enabled=false',
    '--set', 'redis.external.url=rediss://:pw@redis.example.com:6380',
  ]);
  assert.equal(all(docs, 'StatefulSet').length, 0);
  const cms = container(find(docs, 'Deployment', 'lb-lumibase'), 'cms');
  assert.deepEqual(envOf(cms, 'DATABASE_URL').valueFrom.secretKeyRef, { name: 'db', key: 'DATABASE_URL' });
  assert.deepEqual(envOf(cms, 'REDIS_URL').valueFrom.secretKeyRef, { name: 'lb-lumibase', key: 'REDIS_URL' });
  const cm = find(docs, 'ConfigMap');
  // External databases keep the production TLS requirement unless opted out.
  assert.equal(cm.data.DATABASE_SSL_MODE, undefined);
  // The external Redis URL (it carries a password) lives only in the Secret:
  // no ConfigMap key holds it, and no ConfigMap value is a Redis URL.
  assert.equal(cm.data.REDIS_URL, undefined);
  for (const value of Object.values(cm.data ?? {})) {
    assert.doesNotMatch(String(value), /^rediss?:\/\//);
  }
});

test('render refuses configurations the server would refuse', { skip }, () => {
  const noOrigin = render([]);
  assert.equal(noOrigin.ok, false);
  assert.match(noOrigin.stderr, /CORS_ALLOWED_ORIGINS is required/);
  assert.match(render([...BASE, '--set', 'corsAllowedOrigins=*']).stderr, /must not contain \*/);
  assert.match(render([...BASE, '--set', 'redis.enabled=false']).stderr, /Redis is required/);
  assert.match(render([...BASE, '--set', 'postgresql.enabled=false']).stderr, /PostgreSQL is required/);
  assert.match(render([...BASE, '--set', 'database.rls=enforce']).stderr, /needs database.systemUrl/);
  assert.match(render([...BASE, '--set', 's3.endpoint=https://s3.example.com']).stderr, /s3.accessKey/);
  // Schema-level refusals.
  assert.equal(render([...BASE, '--set', 'service.port=http']).ok, false);
  assert.equal(render([...BASE, '--set', 'environment=prod']).ok, false);
  // Non-production does not need an origin.
  assert.equal(render(['--set', 'environment=development']).ok, true);
});

test('ingress with TLS derives the https public origin and CORS from the host', { skip }, () => {
  const docs = mustRender([
    '--set', 'ingress.enabled=true',
    '--set', 'ingress.className=nginx',
    '--set', 'ingress.hosts[0].host=cms.acme.test',
    '--set', 'ingress.hosts[0].paths[0].path=/',
    '--set', 'ingress.tls[0].secretName=cms-tls',
    '--set', 'ingress.tls[0].hosts[0]=cms.acme.test',
  ]);
  const cm = find(docs, 'ConfigMap');
  assert.equal(cm.data.LUMIBASE_PUBLIC_URL, 'https://cms.acme.test');
  assert.equal(cm.data.CORS_ALLOWED_ORIGINS, 'https://cms.acme.test');
  const ing = find(docs, 'Ingress');
  assert.equal(ing.spec.ingressClassName, 'nginx');
  assert.deepEqual(ing.spec.tls, [{ hosts: ['cms.acme.test'], secretName: 'cms-tls' }]);
  assert.equal(ing.spec.rules[0].http.paths[0].backend.service.name, 'lb-lumibase');
  // Without TLS the origin is http.
  const plain = mustRender(['--set', 'ingress.enabled=true', '--set', 'ingress.hosts[0].host=cms.acme.test']);
  assert.equal(find(plain, 'ConfigMap').data.LUMIBASE_PUBLIC_URL, 'http://cms.acme.test');
});

test('worker.enabled splits web and worker roles; workers never apply migrations', { skip }, () => {
  const docs = mustRender([...BASE, '--set', 'worker.enabled=true']);
  const web = container(find(docs, 'Deployment', 'lb-lumibase'), 'cms');
  assert.equal(envOf(web, 'LUMIBASE_PROCESS_ROLE').value, 'web');
  const worker = container(find(docs, 'Deployment', 'lb-lumibase-worker'), 'worker');
  assert.equal(envOf(worker, 'LUMIBASE_PROCESS_ROLE').value, 'worker');
  assert.equal(envOf(worker, 'LUMIBASE_WORKER_HEALTH_PORT').value, '1988');
  assert.equal(envOf(worker, 'SKIP_MIGRATIONS').value, 'true');
  assert.equal(worker.livenessProbe.httpGet.port, 'health');
  assert.equal(worker.ports[0].containerPort, 1988);
  // The service only selects web pods.
  assert.equal(find(docs, 'Service', 'lb-lumibase').spec.selector['app.kubernetes.io/component'], 'cms');
  // Default role without a worker Deployment is `all`.
  const single = container(find(mustRender(), 'Deployment', 'lb-lumibase'), 'cms');
  assert.equal(envOf(single, 'LUMIBASE_PROCESS_ROLE').value, 'all');
});

test('HPA, PDB and NetworkPolicy render when enabled', { skip }, () => {
  const docs = mustRender([
    ...BASE,
    '--set', 'autoscaling.enabled=true',
    '--set', 'podDisruptionBudget.enabled=true',
    '--set', 'networkPolicy.enabled=true',
    '--set', 'meilisearch.enabled=true',
  ]);
  const deploy = find(docs, 'Deployment', 'lb-lumibase');
  assert.equal(deploy.spec.replicas, undefined, 'the HPA owns replicas');
  const hpa = find(docs, 'HorizontalPodAutoscaler');
  assert.equal(hpa.spec.scaleTargetRef.name, 'lb-lumibase');
  assert.equal(hpa.spec.metrics[0].resource.name, 'cpu');
  assert.equal(find(docs, 'PodDisruptionBudget').spec.minAvailable, 1);
  const policies = all(docs, 'NetworkPolicy');
  const names = policies.map((p) => p.metadata.name).sort();
  assert.deepEqual(names, ['lb-lumibase', 'lb-lumibase-meilisearch', 'lb-lumibase-postgresql', 'lb-lumibase-redis']);
  for (const p of policies.filter((x) => x.metadata.name !== 'lb-lumibase')) {
    const components = p.spec.ingress[0].from.map((f) => f.podSelector.matchLabels['app.kubernetes.io/component']);
    assert.deepEqual(components, ['cms', 'worker'], p.metadata.name);
  }
  assert.equal(
    render([...BASE, '--set', 'podDisruptionBudget.enabled=true', '--set', 'podDisruptionBudget.maxUnavailable=1']).ok,
    false,
  );
});

test('config overrides chart keys and every chart-set variable is read by the code', { skip }, () => {
  const docs = mustRender([...BASE, '--set', 'config.LUMIBASE_SERVE_STUDIO=false', '--set', 'config.LLM_PROVIDER=gemini']);
  const cm = find(docs, 'ConfigMap');
  assert.equal(cm.data.LUMIBASE_SERVE_STUDIO, 'false');
  assert.equal(cm.data.LLM_PROVIDER, 'gemini');

  // Guard against the chart setting a variable nothing reads (a renamed or
  // removed variable would otherwise keep "configuring" nothing).
  const full = mustRender([
    ...BASE,
    '--set', 'meilisearch.enabled=true',
    '--set', 'worker.enabled=true',
    '--set', 's3.endpoint=https://s3.example.com',
    '--set', 's3.existingSecret=s3',
    '--set', 'database.systemUrl.existingSecret=sys',
  ]);
  const chartSet = new Set(Object.keys(find(full, 'ConfigMap').data));
  for (const d of all(full, 'Deployment')) {
    for (const c of [...(d.spec.template.spec.initContainers ?? []), ...d.spec.template.spec.containers]) {
      for (const name of envNames(c)) if (!name.startsWith('LUMIBASE_HELM_')) chartSet.add(name);
    }
  }
  const sources = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(entry) && !/\.test\./.test(entry)) sources.push(readFileSync(p, 'utf8'));
    }
  };
  for (const dir of ['apps/cms/src', 'packages/runtime/src', 'packages/database/scripts', 'docker/scripts']) {
    walk(join(root, dir));
  }
  const corpus = sources.join('\n');
  for (const name of chartSet) {
    assert.ok(corpus.includes(name), `${name} is set by the chart but read nowhere in the server`);
  }
});

test('the helm test pod probes the health and setup routes with the image Node', { skip }, () => {
  const pod = find(mustRender(), 'Pod');
  assert.equal(pod.metadata.annotations['helm.sh/hook'], 'test');
  // A succeeded pod must survive until `helm test --logs` reads it (kind smoke).
  assert.doesNotMatch(pod.metadata.annotations['helm.sh/hook-delete-policy'], /hook-succeeded/);
  const c = pod.spec.containers[0];
  assert.deepEqual(c.command, ['/nodejs/bin/node', '-e']);
  for (const path of ['/health', '/api/v1/setup/state', '/setup']) assert.ok(c.args[0].includes(`'${path}'`), path);
  assert.equal(envOf(c, 'BASE').value, 'http://lb-lumibase:80');
  assert.match(dockerfile, /\/nodejs\/bin\/node/);
});
