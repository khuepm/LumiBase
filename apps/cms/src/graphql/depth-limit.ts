import { GraphQLError, Kind, type ASTNode, type ASTVisitor, type ValidationContext } from 'graphql';

/**
 * A dependency-free query depth-limiting validation rule. Counts the field
 * nesting depth of each operation and reports an error once it exceeds
 * `maxDepth`, protecting the server from abusively deep (and expensive)
 * queries. Introspection meta-fields (`__schema`, `__type`) are ignored so
 * GraphiQL keeps working where introspection is allowed.
 */
export function depthLimitRule(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => {
    return {
      Field(node, _key, _parent, _path, ancestors) {
        const name = node.name.value;
        if (name.startsWith('__')) return;
        const depth = countFieldDepth(ancestors);
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(`Query exceeds the maximum depth of ${maxDepth}.`, {
              nodes: [node],
            }),
          );
        }
      },
    };
  };
}

/** Counts how many enclosing `Field` nodes wrap the current node. */
function countFieldDepth(ancestors: readonly (ASTNode | readonly ASTNode[])[]): number {
  let depth = 1;
  for (const ancestor of ancestors) {
    if (Array.isArray(ancestor)) continue;
    if ((ancestor as ASTNode).kind === Kind.FIELD) depth += 1;
  }
  return depth;
}
