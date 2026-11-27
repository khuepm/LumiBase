{{/* vim: set filetype=mustache: */}}

{{- define "lumibase.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "lumibase.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "lumibase.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels. */}}
{{- define "lumibase.labels" -}}
helm.sh/chart: {{ include "lumibase.chart" . }}
app.kubernetes.io/name: {{ include "lumibase.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: lumibase
{{- end -}}

{{/* Selector labels for one component: (dict "ctx" $ "component" "cms"). */}}
{{- define "lumibase.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lumibase.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "lumibase.componentLabels" -}}
{{ include "lumibase.labels" .ctx }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "lumibase.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "lumibase.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "lumibase.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{/* Name of the chart-managed Secret. */}}
{{- define "lumibase.secretName" -}}
{{- include "lumibase.fullname" . -}}
{{- end -}}

{{- define "lumibase.postgresql.fullname" -}}
{{- printf "%s-postgresql" (include "lumibase.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "lumibase.redis.fullname" -}}
{{- printf "%s-redis" (include "lumibase.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "lumibase.meilisearch.fullname" -}}
{{- printf "%s-meilisearch" (include "lumibase.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "lumibase.worker.fullname" -}}
{{- printf "%s-worker" (include "lumibase.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Public origin: publicUrl, else the first ingress host (https when a TLS entry
lists it). Empty when neither is known.
*/}}
{{- define "lumibase.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{- .Values.publicUrl | trimSuffix "/" -}}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts -}}
{{- $host := (first .Values.ingress.hosts).host -}}
{{- $tls := false -}}
{{- range .Values.ingress.tls -}}
{{- if has $host (default (list) .hosts) -}}{{- $tls = true -}}{{- end -}}
{{- end -}}
{{- printf "%s://%s" (ternary "https" "http" $tls) $host -}}
{{- end -}}
{{- end -}}

{{/* Whether search is configured (bundled or external). */}}
{{- define "lumibase.searchEnabled" -}}
{{- if or .Values.meilisearch.enabled .Values.meilisearch.external.host -}}true{{- end -}}
{{- end -}}

{{- define "lumibase.storageEnabled" -}}
{{- if .Values.s3.endpoint -}}true{{- end -}}
{{- end -}}

{{/* Readiness path: explicit, else /health/ready only when every probed subsystem exists. */}}
{{- define "lumibase.readinessPath" -}}
{{- if .Values.cms.readinessPath -}}
{{- .Values.cms.readinessPath -}}
{{- else if and (include "lumibase.searchEnabled" .) (include "lumibase.storageEnabled" .) -}}
/health/ready
{{- else -}}
/health
{{- end -}}
{{- end -}}

{{- define "lumibase.isProduction" -}}
{{- if eq .Values.environment "production" -}}true{{- end -}}
{{- end -}}

{{/*
Render-time checks for the variables the server refuses to start without in
production, so `helm install` fails with a message instead of a crash loop.
*/}}
{{- define "lumibase.validate" -}}
{{- if not (has .Values.migrations.mode (list "initContainer" "job" "entrypoint" "none")) -}}
{{- fail "migrations.mode must be one of initContainer, job, entrypoint, none" -}}
{{- end -}}
{{- if and (not .Values.postgresql.enabled) (not .Values.database.external.url) (not .Values.database.external.existingSecret) -}}
{{- fail "PostgreSQL is required: set postgresql.enabled=true, or database.external.url / database.external.existingSecret" -}}
{{- end -}}
{{- if and (not .Values.redis.enabled) (not .Values.redis.external.url) (not .Values.redis.external.existingSecret) -}}
{{- fail "Redis is required (cache, queues, locks): set redis.enabled=true, or redis.external.url / redis.external.existingSecret" -}}
{{- end -}}
{{- if and .Values.meilisearch.enabled .Values.meilisearch.external.host -}}
{{- fail "Set either meilisearch.enabled or meilisearch.external.host, not both" -}}
{{- end -}}
{{- if and (include "lumibase.isProduction" .) (not .Values.corsAllowedOrigins) (not (include "lumibase.publicUrl" .)) -}}
{{- fail "In production CORS_ALLOWED_ORIGINS is required: set publicUrl (e.g. https://cms.example.com), corsAllowedOrigins, or enable ingress with a host" -}}
{{- end -}}
{{- if has "*" (splitList "," (.Values.corsAllowedOrigins | replace " " "")) -}}
{{- fail "corsAllowedOrigins must not contain * (the server rejects it in production)" -}}
{{- end -}}
{{- if .Values.secrets.encryptionKey -}}
{{- $k := .Values.secrets.encryptionKey | trim -}}
{{- if or (not (regexMatch "^[A-Za-z0-9+/]+={0,2}$" $k)) (not (has (len $k) (list 24 32 44))) -}}
{{- fail "secrets.encryptionKey must be standard padded base64 of 16, 24 or 32 bytes (openssl rand -base64 32)" -}}
{{- end -}}
{{- end -}}
{{- if and (eq .Values.database.rls "enforce") (not .Values.database.systemUrl.value) (not .Values.database.systemUrl.existingSecret) -}}
{{- fail "database.rls=enforce needs database.systemUrl (a BYPASSRLS role)" -}}
{{- end -}}
{{- if not (has .Values.database.rls (list "off" "enforce")) -}}
{{- fail "database.rls must be off or enforce" -}}
{{- end -}}
{{- if and .Values.s3.endpoint (not .Values.s3.existingSecret) (or (not .Values.s3.accessKey) (not .Values.s3.secretKey)) -}}
{{- fail "s3.endpoint is set: also set s3.accessKey and s3.secretKey, or s3.existingSecret" -}}
{{- end -}}
{{- end -}}

{{/* secretKeyRef env entry: (dict "env" NAME "secret" SECRET "key" KEY [ "optional" true ]). */}}
{{- define "lumibase.secretEnv" -}}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
      {{- if .optional }}
      optional: true
      {{- end }}
{{- end -}}

{{/*
Secret-backed environment shared by the CMS containers and the migration init
containers. Bundled-service URLs are assembled by Kubernetes from the
password variable defined just before them ($(VAR) expansion), so no URL with
a password in it is stored anywhere.
*/}}
{{- define "lumibase.databaseEnv" -}}
{{- $secret := include "lumibase.secretName" . -}}
{{- if .Values.postgresql.enabled }}
{{ include "lumibase.secretEnv" (dict "env" "LUMIBASE_HELM_POSTGRES_PASSWORD" "secret" (default $secret .Values.postgresql.auth.existingSecret) "key" (ternary .Values.postgresql.auth.existingSecretKey "postgres-password" (not (empty .Values.postgresql.auth.existingSecret)))) }}
- name: DATABASE_URL
  value: {{ printf "postgresql://%s:$(LUMIBASE_HELM_POSTGRES_PASSWORD)@%s:5432/%s" (.Values.postgresql.auth.username | urlquery) (include "lumibase.postgresql.fullname" .) .Values.postgresql.auth.database | quote }}
{{- else if .Values.database.external.existingSecret }}
{{ include "lumibase.secretEnv" (dict "env" "DATABASE_URL" "secret" .Values.database.external.existingSecret "key" .Values.database.external.existingSecretKey) }}
{{- else }}
{{ include "lumibase.secretEnv" (dict "env" "DATABASE_URL" "secret" $secret "key" "DATABASE_URL") }}
{{- end }}
{{- end -}}

{{/* DATABASE_URL plus MIGRATE_TARGET: the env of every migration runner and gate. */}}
{{- define "lumibase.migrationEnv" -}}
{{ include "lumibase.databaseEnv" . | trim }}
{{- with .Values.migrations.target }}
- name: MIGRATE_TARGET
  value: {{ . | quote }}
{{- end }}
{{- end -}}

{{/*
Read-only migration gate: `migrate.cjs wait` exits 0 once the database has no
migration pending for this image's journal, polling with backoff. Runs first
in every pod that must not start on an older schema (the worker always; the
web pods too in job mode). Same image and hardening as the migrator.
*/}}
{{- define "lumibase.migrationsReadyContainer" -}}
- name: migrations-ready
  image: {{ include "lumibase.image" . }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  command: ["/nodejs/bin/node", "/app/dist/migrate.cjs", "wait", "--timeout", {{ .Values.migrations.waitTimeoutSeconds | int | toString | quote }}]
  env:
    {{- include "lumibase.migrationEnv" . | trim | nindent 4 }}
  securityContext:
    {{- toYaml .Values.cms.securityContext | nindent 4 }}
  resources:
    {{- toYaml .Values.migrations.resources | nindent 4 }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
{{- end -}}

{{/*
The migration runners: the image entrypoint's preflight (waits for the
database with retry/backoff and prints the schema version), then
`migrate.cjs apply`, which holds a Postgres advisory lock for the whole apply
so concurrent runners serialise and the later ones find nothing to apply.
*/}}
{{- define "lumibase.migratePreflightContainer" -}}
- name: migrate-preflight
  image: {{ include "lumibase.image" . }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  env:
    {{- include "lumibase.migrationEnv" . | trim | nindent 4 }}
    - name: MIGRATION_MODE
      value: preflight
  securityContext:
    {{- toYaml .Values.cms.securityContext | nindent 4 }}
  resources:
    {{- toYaml .Values.migrations.resources | nindent 4 }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
{{- end -}}

{{- define "lumibase.migrateContainer" -}}
- name: migrate
  image: {{ include "lumibase.image" . }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  command: ["/nodejs/bin/node", "/app/dist/migrate.cjs", "apply"]
  env:
    {{- include "lumibase.migrationEnv" . | trim | nindent 4 }}
  securityContext:
    {{- toYaml .Values.cms.securityContext | nindent 4 }}
  resources:
    {{- toYaml .Values.migrations.resources | nindent 4 }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
{{- end -}}

{{- define "lumibase.cmsSecretEnv" -}}
{{- $secret := include "lumibase.secretName" . -}}
{{- $appSecret := default $secret .Values.secrets.existingSecret -}}
{{ include "lumibase.secretEnv" (dict "env" "JWT_SECRET" "secret" $appSecret "key" "JWT_SECRET") }}
{{ include "lumibase.secretEnv" (dict "env" "ENCRYPTION_KEY" "secret" $appSecret "key" "ENCRYPTION_KEY") }}
{{ include "lumibase.databaseEnv" . | trim }}
{{- if .Values.database.systemUrl.existingSecret }}
{{ include "lumibase.secretEnv" (dict "env" "DATABASE_SYSTEM_URL" "secret" .Values.database.systemUrl.existingSecret "key" .Values.database.systemUrl.existingSecretKey) }}
{{- else if .Values.database.systemUrl.value }}
{{ include "lumibase.secretEnv" (dict "env" "DATABASE_SYSTEM_URL" "secret" $secret "key" "DATABASE_SYSTEM_URL") }}
{{- end }}
{{- if .Values.redis.enabled }}
{{ include "lumibase.secretEnv" (dict "env" "LUMIBASE_HELM_REDIS_PASSWORD" "secret" (default $secret .Values.redis.auth.existingSecret) "key" (ternary .Values.redis.auth.existingSecretKey "redis-password" (not (empty .Values.redis.auth.existingSecret)))) }}
- name: REDIS_URL
  value: {{ printf "redis://:$(LUMIBASE_HELM_REDIS_PASSWORD)@%s:6379" (include "lumibase.redis.fullname" .) | quote }}
{{- else if .Values.redis.external.existingSecret }}
{{ include "lumibase.secretEnv" (dict "env" "REDIS_URL" "secret" .Values.redis.external.existingSecret "key" .Values.redis.external.existingSecretKey) }}
{{- else }}
{{ include "lumibase.secretEnv" (dict "env" "REDIS_URL" "secret" $secret "key" "REDIS_URL") }}
{{- end }}
{{- if .Values.meilisearch.enabled }}
{{ include "lumibase.secretEnv" (dict "env" "MEILISEARCH_API_KEY" "secret" $secret "key" "MEILISEARCH_API_KEY") }}
{{- else if .Values.meilisearch.external.existingSecret }}
{{ include "lumibase.secretEnv" (dict "env" "MEILISEARCH_API_KEY" "secret" .Values.meilisearch.external.existingSecret "key" .Values.meilisearch.external.existingSecretKey) }}
{{- else if .Values.meilisearch.external.apiKey }}
{{ include "lumibase.secretEnv" (dict "env" "MEILISEARCH_API_KEY" "secret" $secret "key" "MEILISEARCH_API_KEY") }}
{{- end }}
{{- if include "lumibase.storageEnabled" . }}
{{ include "lumibase.secretEnv" (dict "env" "S3_ACCESS_KEY" "secret" (default $secret .Values.s3.existingSecret) "key" "S3_ACCESS_KEY") }}
{{ include "lumibase.secretEnv" (dict "env" "S3_SECRET_KEY" "secret" (default $secret .Values.s3.existingSecret) "key" "S3_SECRET_KEY") }}
{{- end }}
{{- end -}}

{{- define "lumibase.podSecurityContext" -}}
{{- toYaml .Values.cms.podSecurityContext -}}
{{- end -}}

{{/* /tmp as a small in-memory volume: the root filesystem is read-only. */}}
{{- define "lumibase.tmpVolume" -}}
- name: tmp
  emptyDir:
    medium: Memory
    sizeLimit: {{ .Values.cms.tmpSizeLimit }}
{{- end -}}

{{/* Checksum of everything user-supplied that ends up in the chart Secret. */}}
{{- define "lumibase.secretChecksum" -}}
{{- $in := dict "s" .Values.secrets "db" .Values.database "pg" .Values.postgresql.auth "r" .Values.redis.auth "re" .Values.redis.external "m" .Values.meilisearch.masterKey "me" .Values.meilisearch.external "s3" .Values.s3 -}}
{{- toJson $in | sha256sum -}}
{{- end -}}

{{/* Clients of the bundled data services: the web and worker pods, and the migration Job. */}}
{{- define "lumibase.dataClients" -}}
- podSelector:
    matchLabels:
      app.kubernetes.io/instance: {{ .Release.Name }}
      app.kubernetes.io/component: cms
- podSelector:
    matchLabels:
      app.kubernetes.io/instance: {{ .Release.Name }}
      app.kubernetes.io/component: worker
{{- if eq .Values.migrations.mode "job" }}
- podSelector:
    matchLabels:
      app.kubernetes.io/instance: {{ .Release.Name }}
      app.kubernetes.io/component: migrate
{{- end }}
{{- end -}}

{{/*
Egress rules for pods that run extension code (CMS and worker), when
networkPolicy.egress.restrict is on (#1009, ADR-015). Allows DNS, the
release's own bundled data services, `allowTo` peers, and public addresses;
blocks cloud metadata, private, CGNAT and link-local ranges, so an extension
(in process or in its child process) cannot reach them outside ctx.fetch.
*/}}
{{- define "lumibase.restrictedEgress" -}}
- to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          k8s-app: kube-dns
  ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
- to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/instance: {{ .Release.Name }}
{{- with .Values.networkPolicy.egress.allowTo }}
- to:
    {{- toYaml . | nindent 4 }}
{{- end }}
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          {{- toYaml .Values.networkPolicy.egress.blockedCidrs | nindent 10 }}
{{- if .Values.networkPolicy.egress.ipv6 }}
    - ipBlock:
        cidr: ::/0
        except:
          {{- toYaml .Values.networkPolicy.egress.blockedCidrsV6 | nindent 10 }}
{{- end }}
{{- end -}}
