/**
 * Build and release metadata shared by LumiBase runtime surfaces.
 *
 * Values are injected by deployment/build tooling where possible and may fall
 * back to `"unknown"` in local development when a particular datum is absent.
 */
export interface BuildMetadata {
  /** Semver package/application version for the deployed LumiBase build. */
  version: string;
  /** Source-control revision used for this build. */
  gitSha: string;
  /** ISO-8601 timestamp for when this build artifact was produced. */
  buildTime: string;
  /** Release track for the artifact, for example `development`, `staging`, or `production`. */
  releaseChannel: string;
}
