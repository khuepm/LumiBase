/**
 * LumiBase Firebase Sync module — public surface.
 *
 * Syncs LumiBase content (`items`) to a Firebase target (Cloud Firestore or
 * Realtime Database). The control-plane router is mounted by the main app at
 * `/api/v1/firebase-sync`; {@link FirebaseSyncService} is invoked in real time
 * from `ItemService` on item create/update/delete to push changes outbound.
 */

export { lumibaseFirebaseSyncRouter } from './routes';
export {
  FirebaseSyncService,
  serializePipeline,
  type FirebaseSyncDeps,
  type PipelineInput,
  type PipelineView,
} from './service';
export {
  createFirebaseConnector,
  type FirebaseConnector,
  type FirebaseCredentials,
  type FirebaseTarget,
  type SyncAction,
} from './connector';
