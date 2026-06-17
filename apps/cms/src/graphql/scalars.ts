import { GraphQLScalarType, Kind, type ValueNode } from 'graphql';

/**
 * `JSON` scalar — passthrough for arbitrary JSONB values (relational
 * payloads, csv arrays, geometry, free-form objects). Mirrors the way the
 * REST surface returns `items.data` verbatim, so consumers see the same
 * shape across both APIs.
 */
function parseLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
      return parseInt(ast.value, 10);
    case Kind.FLOAT:
      return parseFloat(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map(parseLiteral);
    case Kind.OBJECT: {
      const obj: Record<string, unknown> = {};
      for (const field of ast.fields) {
        obj[field.name.value] = parseLiteral(field.value);
      }
      return obj;
    }
    default:
      return null;
  }
}

export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  description:
    'Arbitrary JSON value (objects, arrays, scalars). Used for free-form ' +
    'item data, relational payloads, and filter inputs.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral,
});

/**
 * `DateTime` scalar — serialised as an ISO-8601 string, matching the REST
 * envelope which JSON-encodes `Date` columns to ISO strings.
 */
export const DateTimeScalar = new GraphQLScalarType({
  name: 'DateTime',
  description: 'An ISO-8601 date-time string.',
  serialize: (value) => {
    if (value instanceof Date) return value.toISOString();
    return value;
  },
  parseValue: (value) => value,
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? ast.value : null),
});
