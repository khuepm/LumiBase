import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLOutputType,
} from 'graphql';
import { isZonedDateTimeField, isZonedDateTimeValue } from '@lumibase/contracts/field';
import { JSONScalar, DateTimeScalar } from './scalars';
import type { CompiledField } from '../services/schema-service';

/**
 * Value of a timezone-aware datetime field (#747). A legacy bare-string value
 * (written before `options.timezone` was enabled) resolves as `instant` only.
 */
export const ZonedDateTimeType = new GraphQLObjectType<unknown>({
  name: 'ZonedDateTime',
  description: 'An instant plus the IANA time zone it was authored in.',
  fields: {
    instant: {
      type: DateTimeScalar,
      description: 'ISO-8601 instant in UTC.',
      resolve: (src) => (isZonedDateTimeValue(src) ? src.instant : typeof src === 'string' ? src : null),
    },
    tz: {
      type: GraphQLString,
      description: 'IANA time zone, e.g. `America/New_York`.',
      resolve: (src) => (isZonedDateTimeValue(src) ? src.tz : null),
    },
    offset: {
      type: GraphQLString,
      description: 'UTC offset of `tz` at `instant`, e.g. `-04:00`.',
      resolve: (src) => (isZonedDateTimeValue(src) ? ((src as { offset?: string }).offset ?? null) : null),
    },
  },
});

/**
 * Maps a LumiBase field type (see `fields.type` / interfaces) onto a
 * GraphQL output type. Anything structured or unknown falls back to the
 * `JSON` scalar so the schema never fails to build for an exotic field —
 * the value still round-trips verbatim, exactly like REST.
 */
export function mapFieldType(field: CompiledField): GraphQLOutputType {
  if (isZonedDateTimeField(field)) return ZonedDateTimeType;
  switch (field.type) {
    case 'boolean':
      return GraphQLBoolean;
    case 'integer':
      return GraphQLInt;
    case 'float':
    case 'decimal':
      return GraphQLFloat;
    // bigInteger is kept as String to avoid 53-bit precision loss.
    case 'bigInteger':
      return GraphQLString;
    case 'dateTime':
    case 'date':
    case 'time':
    case 'timestamp':
      return DateTimeScalar;
    case 'string':
    case 'text':
    case 'uuid':
    case 'hash':
    case 'slug':
    case 'code':
    case 'color':
      return GraphQLString;
    // Structured / relational / multi-value types passthrough as JSON.
    case 'json':
    case 'csv':
    case 'geometry':
    case 'files':
    case 'm2o':
    case 'o2m':
    case 'm2m':
    case 'm2a':
    // Dynamic zones (#748): the schema builder swaps in a per-field union of
    // block object types; JSON is only the fallback when no template resolves.
    case 'blocks':
      return JSONScalar;
    default:
      return GraphQLString;
  }
}
