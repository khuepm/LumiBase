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
 * Storage key for a media asset. Unlike an id, a key may legitimately contain
 * nested `/` separators (the server route is `/media/:key{.+}`), so slashes are
 * allowed — but `..` traversal and leading `/` are rejected, mirroring the
 * server-side `isInvalidKey` guard.
 */
export const mediaKeySchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('..'), 'Must not contain ".."')
  .refine((value) => !value.startsWith('/'), 'Must not start with "/"');

/**
 * Encodes a multi-segment path (e.g. a media key) for safe interpolation:
 * percent-encodes each segment while preserving the `/` separators so nested
 * keys keep their structure.
 */
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
