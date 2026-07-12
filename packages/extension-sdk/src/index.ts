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
