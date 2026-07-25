import {
  GraphQLError,
  Kind,
  type ASTVisitor,
  type FieldNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
} from 'graphql';

/**
 * A dependency-free query *cost* limiting validation rule, complementing
 * `depthLimitRule`. Depth limiting stops abusively deep queries but not ones
 * that are shallow yet wide — many parallel fields, large `first`/`limit`
 * lists, or the same expensive field aliased many times. This rule assigns a
 * static cost to each operation from its AST (no resolver runs) and rejects
 * operations that exceed `maxCost` (CWE-770 — resource allocation without
 * limits).
 *
 * Cost model:
 *   - Each non-introspection `Field` contributes a base cost of 1.
 *   - The cost of a list field's subtree is multiplied by a *list multiplier*
 *     derived from its pagination argument (`first`/`last`/`limit`/`pageSize`),
 *     or `defaultListSize` when absent or given as a variable.
 *   - Nested lists multiply naturally through the recursion.
 *   - Introspection meta-fields (`__schema`, `__type`, `__typename`) are free
 *     so GraphiQL keeps working where introspection is allowed.
 *
 * The rule is static: a `Variable` pagination argument (`first: $n`) cannot be
 * read at validation time, so such fields are priced at `defaultListSize` — a
 * deliberately conservative choice that never over-blocks. Combined with the
 * depth limit and rate limiter, this is defence-in-depth, not a precise quota.
 */

const PAGINATION_ARGS = ['first', 'last', 'limit', 'pageSize'] as const;

export interface CostLimitOptions {
  maxCost: number;
  defaultListSize: number;
  maxListMultiplier: number;
}

export function costLimitRule(opts: CostLimitOptions) {
  return (context: ValidationContext): ASTVisitor => {
    return {
      OperationDefinition(node) {
        const total = costOfSelectionSet(node.selectionSet, 1, context, opts, new Set());
        if (total > opts.maxCost) {
          context.reportError(
            new GraphQLError(`Query exceeds the maximum cost of ${opts.maxCost}.`, {
              nodes: [node],
            }),
          );
        }
      },
    };
  };
}

/**
 * Recursively sums the cost of a selection set. `inheritedMultiplier` is the
 * product of enclosing list multipliers; it scales every field beneath a list.
 * `visitingFragments` guards against fragment cycles (the spec forbids them,
 * so this is belt-and-braces alongside the standard validation rules).
 */
function costOfSelectionSet(
  selectionSet: SelectionSetNode,
  inheritedMultiplier: number,
  context: ValidationContext,
  opts: CostLimitOptions,
  visitingFragments: Set<string>,
): number {
  let total = 0;

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        if (selection.name.value.startsWith('__')) break; // introspection is free
        const childMultiplier = listMultiplier(selection, opts);
        const subtree = selection.selectionSet
          ? costOfSelectionSet(selection.selectionSet, childMultiplier, context, opts, visitingFragments)
          : 0;
        total += inheritedMultiplier * (1 + subtree);
        break;
      }
      case Kind.INLINE_FRAGMENT: {
        if (selection.selectionSet) {
          total += costOfSelectionSet(
            selection.selectionSet,
            inheritedMultiplier,
            context,
            opts,
            visitingFragments,
          );
        }
        break;
      }
      case Kind.FRAGMENT_SPREAD: {
        const name = selection.name.value;
        if (visitingFragments.has(name)) break; // cycle guard
        const fragment: FragmentDefinitionNode | null | undefined = context.getFragment(name);
        if (fragment) {
          visitingFragments.add(name);
          total += costOfSelectionSet(
            fragment.selectionSet,
            inheritedMultiplier,
            context,
            opts,
            visitingFragments,
          );
          visitingFragments.delete(name);
        }
        break;
      }
    }
  }

  return total;
}

/**
 * Derives a list field's multiplier from its pagination argument. A literal
 * `IntValue` is clamped to `[1, maxListMultiplier]` so a huge `first` cannot
 * overflow the arithmetic and deterministically pushes the operation over the
 * limit. Absent or variable arguments fall back to `defaultListSize`.
 */
function listMultiplier(field: FieldNode, opts: CostLimitOptions): number {
  for (const argName of PAGINATION_ARGS) {
    const arg = field.arguments?.find((a) => a.name.value === argName);
    if (arg && arg.value.kind === Kind.INT) {
      const n = Number.parseInt(arg.value.value, 10);
      if (Number.isFinite(n)) return clamp(n, 1, opts.maxListMultiplier);
    }
  }
  return opts.defaultListSize;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
