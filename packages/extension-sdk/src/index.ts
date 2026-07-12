/**
 * Extension authoring SDK. See `docs/features/extensions-system.md` for the
 * capability model. The runtime loader lives in `apps/cms/src/extensions/`.
 */
export type ExtensionType =
  | 'hook'
  | 'endpoint'
  | 'operation'
  | 'interface'
  | 'display'
  | 'layout'
  | 'panel'
  | 'module';

export interface ExtensionManifest {
  name: string;
  version: string;
  type: ExtensionType;
  entry: string;
  /** Declared capabilities (e.g. `items:read:posts`, `http:fetch:api.example.com`). */
  capabilities: string[];
  config?: Array<{ key: string; type: 'string' | 'integer' | 'boolean' | 'json'; default?: unknown }>;
  /** Auto-install during setup/reconcile (verified official `lumibase-*` only). */
  autoInstall?: boolean;
  /** Whether an auto-installed extension starts enabled. */
  enabledByDefault?: boolean;
}

export interface HookContext {
  readonly siteId: string;
  readonly config: Record<string, unknown>;
  readonly logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
  /** Sandboxed fetch; only hosts declared in `capabilities` resolve. */
  readonly fetch: typeof fetch;
  readonly errors: { ValidationError: new (msg: string) => Error };
}

export interface HookDefinition<TPayload = unknown> {
  on: string;
  handler: (input: {
    payload: TPayload;
    item?: Record<string, unknown>;
    ctx: HookContext;
  }) => Promise<void> | void;
}

export function defineHook<TPayload = unknown>(def: HookDefinition<TPayload>): HookDefinition<TPayload> {
  return def;
}

export type InterfaceGroup =
  | 'standard'
  | 'selection'
  | 'relational'
  | 'presentation'
  | 'group'
  | 'other';

export type InterfaceOptionType = 'string' | 'text' | 'integer' | 'decimal' | 'boolean' | 'json';

export interface InterfaceOption {
  field: string;
  name: string;
  type?: InterfaceOptionType;
  required?: boolean;
  schema?: Record<string, unknown>;
  meta?: {
    width?: 'half' | 'full' | 'fill';
    interface?: string;
    note?: string;
    options?: Record<string, unknown>;
  };
}

export interface InterfaceProps<TValue = unknown, TOptions = Record<string, unknown>> {
  value: TValue | null | undefined;
  field: unknown;
  disabled?: boolean;
  options?: TOptions;
  onChange: (next: TValue | null) => void;
}

export type InterfaceComponent<TValue = unknown, TOptions = Record<string, unknown>> = (
  props: InterfaceProps<TValue, TOptions>,
) => unknown;

export interface InterfaceDefinition<TValue = unknown, TOptions = Record<string, unknown>> {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  component: InterfaceComponent<TValue, TOptions>;
  types: string[];
  group?: InterfaceGroup;
  relational?: boolean;
  localTypes?: string[];
  options?: InterfaceOption[];
  recommendedDisplays?: string[];
}

export function defineInterface<TValue = unknown, TOptions = Record<string, unknown>>(
  def: InterfaceDefinition<TValue, TOptions>,
): InterfaceDefinition<TValue, TOptions> {
  return def;
}

/* ── Change Feed subscriber (spec cdc-extension-integration, Req 5.1) ────── */

/** One delivered change event; `id` is the idempotency key (at-least-once). */
export interface CdcEvent<TData = Record<string, unknown>> {
  id: string;
  /** `items.<operation>` */
  type: string;
  schemaVersion: number;
  siteId: string;
  collection: string;
  itemId: string;
  operation: 'create' | 'update' | 'delete';
  /** ISO timestamp (Postgres clock). */
  occurredAt: string;
  actor: { type: 'user' | 'api_key' | 'agent' | 'system'; id?: string };
  source: 'api' | 'agent' | 'flow' | 'system';
  changedFields?: string[];
  /** Present only when the subscription uses `payloadMode: 'snapshot'`; pii/phi masked. */
  data?: TData;
  /** Opaque keyset token for this event — resume/ack marker. */
  cursor: string;
}

export interface CdcSubscriberContext {
  readonly siteId: string;
  readonly config: Record<string, unknown>;
  readonly logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

/**
 * Declares an async change-feed consumer. The host delivers batches
 * at-least-once AFTER the mutation commits (unlike sync `hooks`, this can
 * never block or abort a mutation) and only for collections covered by the
 * manifest's `cdc:subscribe:<collection>` capabilities — the host enforces
 * that filter, not the extension. Handlers MUST be idempotent on `event.id`.
 */
export interface CdcSubscriberDefinition<TData = Record<string, unknown>> {
  collections: string[];
  operations?: Array<'create' | 'update' | 'delete'>;
  payloadMode?: 'reference' | 'snapshot';
  handler: (input: { events: CdcEvent<TData>[]; ctx: CdcSubscriberContext }) => Promise<void>;
}

export function defineCdcSubscriber<TData = Record<string, unknown>>(
  def: CdcSubscriberDefinition<TData>,
): CdcSubscriberDefinition<TData> {
  return def;
}
