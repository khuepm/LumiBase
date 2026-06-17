import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLString,
  type GraphQLOutputType,
} from 'graphql';
import { JSONScalar, DateTimeScalar } from './scalars';
import type { CompiledField } from '../services/schema-service';

/**
 * Maps a LumiBase field type (see `fields.type` / interfaces) onto a
 * GraphQL output type. Anything structured or unknown falls back to the
 * `JSON` scalar so the schema never fails to build for an exotic field —
 * the value still round-trips verbatim, exactly like REST.
 */
export function mapFieldType(field: CompiledField): GraphQLOutputType {
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
      return JSONScalar;
    default:
      return GraphQLString;
  }
}
