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
