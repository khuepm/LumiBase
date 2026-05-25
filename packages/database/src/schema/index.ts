/**
 * Drizzle schema barrel. `drizzle.config.ts` points at this file's
 * sibling `../schema.ts`, which simply re-exports everything here. Keep
 * domain tables grouped by file so each stays under ~300 LOC.
 */
export * from './core';
export * from './access';
export * from './cms';
export * from './platform';
export * from './ai';
