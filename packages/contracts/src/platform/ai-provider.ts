import type { FieldClassification } from '../field';
import type { SeamContext, TenantRef } from './index';

/** Resolution selects a route. The caller must authorize its destination before dispatch. */
export type ModelOperation = 'generation' | 'document-embedding' | 'query-embedding' | 'reranking';

export interface ModelRoute {
  provider: string;
  model: string;
  /** Deployment-defined ID bound to the adapter's exact outbound endpoint. */
  destinationId: string;
  /** Opaque lookup handle, never a raw key. */
  credentialRef: string;
}

export interface AIProviderResolver<TRuntime = unknown> {
  /** Null disables the operation. Resolution errors abort dispatch. */
  resolve(
    context: SeamContext<TRuntime>,
    tenant: TenantRef,
    operation: ModelOperation,
  ): Promise<ModelRoute | null>;
}

/** Trusted inventory of the payload, including free text and query inputs. */
export type RetrievalDataClass = FieldClassification | 'credential' | 'encrypted' | 'unclassified';

interface DataScope {
  siteId: string;
  dataClass: RetrievalDataClass;
}

export type RetrievalGrant = DataScope & (
  | { action: 'index' }
  | { action: 'transfer'; destinationId: string }
);

/** Evaluate one classified component. Callers must cover every component of a payload. */
export function hasRetrievalGrant(grants: readonly RetrievalGrant[], required: RetrievalGrant): boolean {
  if (!required.siteId.trim() || required.dataClass === 'unclassified') return false;
  return grants.some((grant) => {
    if (grant.siteId !== required.siteId || grant.dataClass !== required.dataClass) return false;
    if (required.action === 'index') return grant.action === 'index';
    return grant.action === 'transfer' && required.destinationId.trim().length > 0
      && grant.destinationId === required.destinationId;
  });
}
