// @lumibase/runtime/node — entry point for Node/Docker processes.
//
// `createRuntime` branches on `LUMIBASE_RUNTIME`, so it statically imports BOTH
// adapter subtrees. That is harmless in a Node process and fatal in a Worker
// (see the note at the top of `./index.ts`), which is why it lives here instead
// of at the package root.
//
// Cloudflare code wants `createCloudflareRuntime` from `@lumibase/runtime`
// directly — there is nothing to branch on inside a Worker.
export { createRuntime } from './factory';
export {
  withLeaderLock,
  leaderLockedCallback,
  __resetLeaderLockWarningsForTests,
} from './leader-lock';
export type { LeaderLockRedis, WithLeaderLockOptions } from './leader-lock';
