import { z } from 'zod';
import { GEO_MAX_RADIUS_M } from '../field/geopoint';

/**
 * Zod schemas for the `geopoint` field type (#746). Types, constants and the
 * haversine helper live in `field/geopoint.ts` (zod-free).
 */

const latitude = z.number().finite().min(-90).max(90);
const longitude = z.number().finite().min(-180).max(180);

/** A stored geopoint value: `{ lat, lng }`, nothing else. */
export const GeoPointSchema = z.strictObject({ lat: latitude, lng: longitude });

/**
 * A filter operand number. Query-string filters arrive as strings, so plain
 * numeric strings are accepted; anything else (booleans, blanks, objects) is
 * refused rather than coerced (`Number(true) === 1`).
 */
const operandNumber = z.union([
  z.number(),
  z
    .string()
    .trim()
    .regex(/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d{1,3})?$/)
    .transform(Number),
]);

/** `_near` operand: centre + radius in metres (0 < radius <= half the circumference). */
export const GeoNearSchema = z.strictObject({
  lat: operandNumber.pipe(latitude),
  lng: operandNumber.pipe(longitude),
  radius: operandNumber.pipe(z.number().finite().positive().max(GEO_MAX_RADIUS_M)),
});

/**
 * `_within_bbox` operand `[minLng, minLat, maxLng, maxLat]`. Latitudes must be
 * ordered; `minLng > maxLng` is a box that crosses the antimeridian.
 */
export const GeoBBoxSchema = z
  .tuple([
    operandNumber.pipe(longitude),
    operandNumber.pipe(latitude),
    operandNumber.pipe(longitude),
    operandNumber.pipe(latitude),
  ])
  .refine(([, minLat, , maxLat]) => minLat <= maxLat, { message: 'minLat must be <= maxLat' });
