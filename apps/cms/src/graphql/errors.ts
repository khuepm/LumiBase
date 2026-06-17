import { GraphQLError } from 'graphql';
import { ItemServiceError } from '../services/item-service';
import { formatSafeError } from '@lumibase/shared/utils';

/**
 * Normalises a thrown error into a `GraphQLError` whose `extensions.code`
 * matches the REST error-code vocabulary (`VALIDATION`, `PERMISSION_DENIED`,
 * `NOT_FOUND`, `INTERNAL`, …). This keeps client error handling identical
 * across the REST and GraphQL surfaces.
 */
export function toGraphQLError(err: unknown): GraphQLError {
  if (err instanceof GraphQLError) return err;

  if (err instanceof ItemServiceError) {
    return new GraphQLError(err.message, {
      extensions: { code: err.code, status: err.status },
    });
  }

  console.error('[graphql] unexpected error', formatSafeError(err));
  return new GraphQLError('Unhandled item error.', {
    extensions: { code: 'INTERNAL', status: 500 },
  });
}
