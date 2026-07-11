/**
 * Drizzle schema barrel. `drizzle.config.ts` points at this file's
 * sibling `../schema.ts`, which simply re-exports everything here. Keep
 * domain tables grouped by file so each stays under ~300 LOC.
 */
export * from './core';
export * from './access';
export * from './consent';
export * from './compliance';
export * from './cms';
export * from './platform';
export * from './ai';
export * from './security';
export * from './cdc';
export * from './content-os';
export * from './firebase-sync';
export * from './regulated';
export * from './deployments';
export * from './domains';
export * from './external-auth';
