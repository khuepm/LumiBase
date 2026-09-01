/**
 * Permission rule DSL. The shape mirrors the JSON used in
 * `permissions.permissions` records (see `docs/features/permissions-rbac.md`).
 *
 * Phase C delivers the evaluator (server + client mirrors). For now we only
 * export the type so routers/forms can share it.
 */
export type PolicyRule =
  | { _and: PolicyRule[] }
  | { _or: PolicyRule[] }
  | { _not: PolicyRule }
  | { [field: string]: PolicyOperator };

export type PolicyOperator =
  | { _eq: PolicyValue }
  | { _neq: PolicyValue }
  | { _in: PolicyValue[] }
  | { _nin: PolicyValue[] }
  | { _gt: PolicyValue }
  | { _gte: PolicyValue }
  | { _lt: PolicyValue }
  | { _lte: PolicyValue }
  | { _contains: string }
  | { _starts_with: string }
  | { _ends_with: string }
  | { _icontains: string }
  | { _istarts_with: string }
  | { _iends_with: string }
  | { _between: [PolicyValue, PolicyValue] }
  | { _null: boolean }
  | { _nnull: boolean }
  | { _empty: boolean }
  | { _nempty: boolean }
  | { _regex: string }
  | { _dynamic: string }; // e.g. "$NOW(-7 days)"

export type PolicyValue =
  | string
  | number
  | boolean
  | null
  | `$${string}`; // magic vars like $CURRENT_USER
