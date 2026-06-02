/**
 * Studio CDC Management Panel — barrel export
 * (ClickHouse CDC — task 13.3; design "Studio CDC Panel" §6).
 *
 * Re-exports the panel's page components and the pure form-validation /
 * recommendation logic so the router (and task 13.4's property test) can
 * import from a single module path.
 */

export { CdcPipelineListPage } from './pipeline-list';
export { CdcPipelineWizardPage } from './pipeline-wizard';
export { CdcPipelineDetailPage } from './pipeline-detail';

export {
  validatePipelineForm,
  validateSyncInterval,
  toCreatePayload,
  emptyPipelineForm,
  requiresIntermediaryConnection,
  usesSyncSchedule,
  PIPELINE_NAME_MAX_LENGTH,
  SYNC_INTERVAL_MIN_SECONDS,
  SYNC_INTERVAL_MAX_SECONDS,
  CDC_CONNECTOR_TYPES,
  SYNC_MODES,
  type PipelineFormValues,
  type PipelineFormErrors,
  type PipelineFormField,
  type PipelineFormValidationResult,
  type SyncMode,
} from './pipeline-form';

export { recommendApproach } from './recommender';

export type {
  CdcConnectorType,
  PipelineStatus,
  PipelineSummary,
  PipelineMetrics,
  HealthCheckResult,
  PipelineCreatePayload,
} from './types';
