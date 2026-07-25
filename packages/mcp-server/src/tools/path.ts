import { z } from 'zod';

const namePattern = /^[a-z][a-z0-9_]{0,62}$/;

export const collectionNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(namePattern, 'Must be lowercase, start with a letter, only a-z0-9_');

export const fieldNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(namePattern, 'Must be lowercase snake_case, start with a letter');

export const idPathSegmentSchema = z
  .string()
  .min(1)
  .refine((value) => value !== '.' && value !== '..', 'Must not be . or ..')
  .refine((value) => !/[\\/]/.test(value), 'Must not contain path separators');

export function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * Storage keys are multi-segment (`folder/sub/asset.png`), so unlike opaque ids
 * they may legitimately contain `/`. Mirror the server-side guard
 * (`apps/cms/src/routes/media.ts` → `isInvalidKey`): reject `..` traversal,
 * leading `/`, and backslashes, while preserving internal `/`.
 */
export const mediaKeySchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('..'), 'Must not contain ".."')
  .refine((value) => !value.startsWith('/'), 'Must not start with "/"')
  .refine((value) => !value.includes('\\'), 'Must not contain backslashes');

/** Percent-encode each `/`-delimited segment of a storage key, preserving separators. */
export function encodeMediaKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
