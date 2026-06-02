export type DefaultSchema = Record<string, Record<string, unknown>>;

export interface CollectionResource {
  id: string;
  siteId: string;
  name: string;
  singleton: boolean;
  displayTemplate: string | null;
  sortField: string | null;
  archiveField: string | null;
  archiveValue: string | null;
  meta: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface FieldResource {
  id: string;
  collectionId: string;
  name: string;
  type: string;
  interface: string;
  required: boolean;
  hidden: boolean;
  sortOrder: number;
  [key: string]: unknown;
}

export interface RelationResource {
  id: string;
  siteId: string;
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  oneField: string | null;
  junctionCollection: string | null;
}

export type ItemFilterOp =
  | "_eq"
  | "_neq"
  | "_in"
  | "_nin"
  | "_gt"
  | "_gte"
  | "_lt"
  | "_lte"
  | "_contains"
  | "_starts_with"
  | "_ends_with"
  | "_null"
  | "_nnull";

export interface ItemFilter {
  _and?: ItemFilter[];
  _or?: ItemFilter[];
  [key: string]: { [op in ItemFilterOp]?: unknown } | ItemFilter[] | undefined;
}

export interface ListItemsParams {
  fields?: string[];
  filter?: ItemFilter;
  sort?: string[];
  limit?: number;
  offset?: number;
  status?: string | null;
  search?: string;
}

export interface ItemRow<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  siteId: string;
  collectionId: string;
  status: string;
  data: TData;
  sort: number;
  userCreated: string | null;
  userUpdated: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface RevisionRow {
  id: string;
  siteId: string;
  collectionId: string;
  itemId: string;
  delta: {
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown>;
  };
  userId: string | null;
  createdAt: string;
}

export interface ListItemsResponse<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  data: ItemRow<T>[];
  meta: { total: number; limit: number; offset: number };
}

/* ---------------- Access (Phase C) ---------------- */

export type PermissionAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "share";

export interface RoleResource {
  id: string;
  siteId: string;
  name: string;
  description: string | null;
  icon: string | null;
  adminAccess: boolean;
  appAccess: boolean;
  createdAt?: string;
}

export interface RoleDetail extends RoleResource {
  policies: Array<{ policyId: string; priority: number }>;
  users: Array<{ userId: string }>;
}

export interface PolicyResource {
  id: string;
  siteId: string;
  name: string;
  description: string | null;
  /** Top-level guardrails: time window, IP allow/deny. */
  rules: Record<string, unknown>;
  createdAt?: string;
}

export interface PermissionRow {
  id: string;
  siteId: string;
  policyId: string;
  collection: string;
  action: PermissionAction;
  permissions: Record<string, unknown>;
  validation: Record<string, unknown>;
  presets: Record<string, unknown>;
  fields: string[];
}

export interface PolicyDetail extends PolicyResource {
  permissions: PermissionRow[];
}

export interface CompiledPermission {
  collection: string;
  action: PermissionAction;
  rule: Record<string, unknown> | null;
  fields: string[];
  presets: Record<string, unknown>;
  validation: Record<string, unknown>;
}

export interface PermissionBundle {
  admin: boolean;
  byKey: Record<string, CompiledPermission>;
  roles: Array<{
    id: string;
    name: string;
    adminAccess: boolean;
    appAccess: boolean;
  }>;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason: string | null;
  fields: string[];
  rule?: Record<string, unknown> | null;
  presets?: Record<string, unknown>;
}

export interface PresetResource {
  id: string;
  siteId: string;
  bookmark: string | null;
  collection: string;
  userId: string | null;
  roleId: string | null;
  layout: string;
  layoutQuery: Record<string, unknown>;
  layoutOptions: Record<string, unknown>;
  search: string | null;
  filter: Record<string, unknown>;
  icon: string | null;
  color: string | null;
  refreshInterval: number;
  createdAt: string;
}

export interface TranslationResource {
  id: string;
  siteId: string;
  language: string;
  namespace: string;
  key: string;
  value: string;
  status: string;
  updatedAt: string;
}

export interface SettingResource {
  id: string;
  siteId: string;
  key: string;
  value: Record<string, unknown>;
  scope: string;
  updatedAt: string;
}

/* ---------------- CDC ---------------- */

export type CdcConnectorType =
  | "debezium_kafka"
  | "materialized_engine"
  | "airbyte";

export type CdcPipelineStatus =
  | "active"
  | "paused"
  | "error"
  | "provisioning";

export type CdcDeploymentTarget = "docker_compose" | "cloudflare_workers";

export type CdcDeploymentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "rolled_back";

export interface CdcPipelineResource {
  id: string;
  siteId: string;
  pipelineName: string;
  connectorType: CdcConnectorType;
  status: CdcPipelineStatus;
  statusMessage: string | null;
  replicationTables: string[];
  config: Record<string, unknown>;
  lastSyncAt: string | null;
  lastSyncRecordCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CdcPipelineCreateInput {
  pipeline_name: string;
  cdc_connector_type: CdcConnectorType;
  source_database_connection: string;
  clickhouse_sink_connection: string;
  replication_tables: string[];
  intermediary_connection?: string;
  config?: Record<string, unknown>;
}

export interface CdcPipelinePatchInput {
  pipeline_name?: string;
  source_database_connection?: string;
  clickhouse_sink_connection?: string;
  intermediary_connection?: string | null;
  replication_tables?: string[];
  config?: Record<string, unknown>;
}

export interface CdcHealthCheckResult {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface CdcPipelineMetrics {
  pipelineId?: string;
  replicationLagMs: number;
  eventsPerSecond: number;
  errorCount: number;
  lastEventAt?: string | null;
  status?: string;
}

export interface CdcHealthMetricEntry {
  pipelineId: string;
  replicationLagMs: number;
  eventsPerSecond: number;
  errorCount: number;
  recordedAt: string;
}

export interface CdcDeploymentStep {
  id?: string;
  name: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  error?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface CdcDeploymentResult {
  deploymentId: string;
  status: CdcDeploymentStatus;
  steps: CdcDeploymentStep[];
  completedAt: string;
  error?: {
    code?: string;
    description?: string;
    [key: string]: unknown;
  };
}

export interface CdcDeployInput {
  approach: CdcConnectorType;
  target: CdcDeploymentTarget;
  pipeline_id?: string;
  env?: Record<string, string>;
}

export interface CdcValidateEnvInput {
  approach: CdcConnectorType;
  target: CdcDeploymentTarget;
  env: Record<string, string>;
}

export interface CdcEnvValidationResult {
  valid: boolean;
  invalidFields: Array<{
    key: string;
    reason: string;
  }>;
}

export interface CdcRollbackResult {
  deploymentId: string;
  status: CdcDeploymentStatus;
  steps: CdcDeploymentStep[];
  rolledBackAt?: string;
  error?: string | Record<string, unknown>;
}

export interface UserResource {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  status: string;
  lastSeenAt: string | null;
  roleId: string | null;
  joinedAt: string;
}

export interface TeamResource {
  id: string;
  siteId: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface TeamMemberResource {
  teamId: string;
  userId: string;
  addedAt: string;
}

export interface FolderResource {
  id: string;
  siteId: string;
  name: string;
  parent: string | null;
  createdAt: string;
}

export interface FileResource {
  id: string;
  siteId: string;
  storage: string;
  filenameDisk: string;
  filenameDownload: string;
  mime: string;
  filesize: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  folder: string | null;
  metadata: Record<string, unknown>;
  uploadedBy: string | null;
  createdAt: string;
}

export interface WebhookResource {
  id: string;
  siteId: string;
  name: string;
  url: string;
  actions: string[];
  collections: string[];
  headers: Record<string, string>;
  status: string;
  secret: string | null;
  createdAt: string;
}

export interface ActivityResource {
  id: string;
  siteId: string;
  action: string;
  userId: string | null;
  collection: string | null;
  itemId: string | null;
  ip: string | null;
  userAgent: string | null;
  comment: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExtensionResource {
  id: string;
  siteId: string | null;
  name: string;
  version: string;
  type: string;
  enabled: boolean;
  bundleUrl: string;
  manifest: Record<string, unknown>;
  capabilities: string[];
  installedBy: string | null;
  installedAt: string;
}

/* ---------------- AI Copilot (POST-GA1) ---------------- */

export type AIChatStatus = "executed" | "pending_approval" | "denied";

export interface AIChatResponse {
  status: AIChatStatus;
  message: string;
  conversationId: string;
  pendingId: string | null;
  result: Record<string, unknown> | null;
}

export interface AIConversation {
  id: string;
  siteId: string;
  userId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls: Array<Record<string, unknown>> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type AIApprovalStatus = "pending" | "approved" | "rejected";

export interface AIApproval {
  id: string;
  siteId: string;
  userId: string | null;
  conversationId: string | null;
  toolName: string;
  toolArgs: Record<string, unknown>;
  status: AIApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface AIFieldSuggestion {
  type: string;
  interface: string;
  confidence: number;
}

export interface AIContentAssistResult {
  content: string;
  tokensUsed: number;
}

/* ---------------- Flows Automation (POST-GA2) ---------------- */

export interface FlowNode {
  id: string;
  key: string;
  options?: Record<string, unknown>;
  next?: string | null;
  onError?: string | null;
}

export interface FlowGraph {
  entry?: string | null;
  nodes: FlowNode[];
}

export type FlowStatus = "active" | "inactive" | "draft";
export type FlowTriggerType = "webhook" | "event" | "schedule" | "manual";

export interface FlowResource {
  id: string;
  siteId: string;
  name: string;
  description: string | null;
  status: FlowStatus;
  triggerType: FlowTriggerType;
  triggerOptions: Record<string, unknown>;
  graph: FlowGraph;
  createdAt: string;
  updatedAt: string;
}

export type FlowRunStatus = "running" | "success" | "error";

export interface FlowRun {
  id: string;
  flowId: string;
  siteId: string;
  status: FlowRunStatus;
  input: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface FlowRunResult {
  runId: string;
  status: "success" | "error";
  steps: Array<Record<string, unknown>>;
  error: string | null;
}

/* ---------------- Marketplace (POST-GA3) ---------------- */

export interface MarketplaceExtension {
  id: string;
  name: string;
  slug: string;
  version: string;
  type: string;
  bundleUrl: string;
  /** Base64-encoded Ed25519 detached signature of SHA-256(bundle). */
  signature: string;
  keyId: string;
  manifest: Record<string, unknown>;
  capabilities: string[];
  publishedAt: string;
  verified: boolean;
}

export interface ListMarketplaceExtensionsParams {
  type?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface MarketplaceListResponse {
  data: MarketplaceExtension[];
  meta: { total: number; limit: number; offset: number };
}

/* ---------------- Materialized Collections (POST-GA4) ---------------- */

export type MaterializeRefreshStrategy = "auto" | "cron" | "manual";

export interface MaterializeProjection {
  fields: string[];
  orderBy?: string | null;
}

export interface MaterializedCollection {
  id: string;
  siteId: string;
  collection: string;
  target: string;
  refreshStrategy: MaterializeRefreshStrategy;
  refreshCron: string | null;
  projection: MaterializeProjection;
  filter: Record<string, unknown>;
  lastRefreshedAt: string | null;
  rowCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaterializeRefreshResult {
  rowsInserted: number;
  refreshedAt: string;
}

export interface MaterializeDataResponse {
  data: Array<Record<string, unknown>>;
  meta: { total: number; limit: number; offset: number };
}

/* ---------------- SCIM Token Management (POST-GA5) ---------------- */

export interface SCIMTokenMeta {
  id: string;
  label: string;
  createdBy: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface SCIMTokenCreated extends SCIMTokenMeta {
  /** Raw bearer token — returned exactly once in plaintext. Store immediately. */
  token: string;
}

export interface SCIMTokenRotated extends SCIMTokenCreated {
  /** Old token continues to accept requests until this ISO-8601 timestamp (24h grace). */
  oldTokenGraceExpiresAt: string;
}

export interface CreateSCIMTokenParams {
  label: string;
  /** Number of days until expiry. Default: 90. Max: 365. */
  lifespanDays?: number;
}
