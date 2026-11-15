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

/* ── Studio host services (media picker, #708) ─────────────────────────────── */

/** An asset returned by the media picker — the `lumibase_files` row shape. */
export interface PickedAsset {
  id: string;
  filenameDisk: string;
  filenameDownload: string;
  mime: string;
  filesize: number;
  width: number | null;
  height: number | null;
  folder: string | null;
  version?: number;
  metadata: Record<string, unknown>;
}

export interface MediaPickerOptions {
  /**
   * Assets shown as already selected when the picker opens. Accepts file ids
   * or storage keys (`filenameDisk`), since the built-in `file` interface
   * stores the key.
   */
  initiallySelected?: string[];
  /** Allow choosing more than one asset (default false). */
  multiple?: boolean;
  /** Exact MIME types or `type/*` prefixes, e.g. `['image/*', 'application/pdf']`. */
  allowedMimeTypes?: string[];
  /** Start in (and limit to) this folder; `null` = library root. */
  folder?: string | null;
  /** With `folder`, also show files in its sub-folders (default true). */
  includeSubfolders?: boolean;
  /** Upper bound on the selection when `multiple` (default unlimited). */
  max?: number;
  /** Dialog title override. */
  title?: string;
}

/**
 * Services the Studio exposes to UI extensions (interfaces, panels, modules).
 * The same picker the built-in file fields use — one picker everywhere.
 */
export interface StudioHost {
  /** Resolves to the chosen assets, or `null` when the editor cancels. */
  openMediaPicker(options?: MediaPickerOptions): Promise<PickedAsset[] | null>;
}

const STUDIO_HOST_KEY = '__lumibaseStudioHost__';

/**
 * The running Studio's host services, or `null` outside the Studio (tests,
 * SSR, a server-side extension). Read it at call time, not module load: the
 * Studio registers it when its shell mounts.
 */
export function getStudioHost(): StudioHost | null {
  const host = (globalThis as Record<string, unknown>)[STUDIO_HOST_KEY];
  return host && typeof (host as StudioHost).openMediaPicker === 'function' ? (host as StudioHost) : null;
}

/** Studio-internal: install (or clear with `null`) the host services. */
export function registerStudioHost(host: StudioHost | null): void {
  const g = globalThis as Record<string, unknown>;
  if (host) g[STUDIO_HOST_KEY] = host;
  else delete g[STUDIO_HOST_KEY];
}
