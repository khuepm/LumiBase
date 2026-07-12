/**
 * Change Feed barrel (spec: cdc-extension-integration). The router is the
 * primary public artifact; stores/services are exported for tests and the
 * Phase D dispatcher.
 */
export {
  cdcFeedRouter,
  createCdcFeedRouter,
  defaultCdcFeedServicesFactory,
  DispatcherUnavailableError,
  type CdcFeedRouteServices,
  type CdcFeedServicesFactory,
} from './routes';
export * from './outbox-writer';
export * from './feed-reader';
export * from './subscription-service';
export * from './subscription-state';
