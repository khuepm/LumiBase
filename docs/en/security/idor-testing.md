# Insecure Direct Object References (IDOR) Testing Guidelines

## Overview
This document outlines the testing guidelines for preventing Insecure Direct Object References (IDOR) in Lumibase. IDOR occurs when an application provides direct access to objects based on user-supplied input. As a result, attackers can bypass authorization and access resources in the system directly, for example, database records or files.

In Lumibase, it's crucial to ensure strict tenant isolation. Data belonging to one tenant (site) must never be accessible or modifiable by a user from another tenant, even if they know or guess the internal ID.

## Scope
*   **Target Collections:** All built-in tables/collections prefixed with `lumibase_`. (Note: Custom collections created by users have their own role/policy-based permission system).
*   **Target Endpoints:** Primarily CRUD endpoints under `/items`, including single and bulk operations.

## Key Principles
1.  **Tenant Isolation:** A user authenticated within Tenant A (`X-Lumi-Site: tenant-a`) should receive a `403 Forbidden` or `404 Not Found` when attempting to access or modify records belonging to Tenant B (`X-Lumi-Site: tenant-b`).
2.  **Authorization Checks:** Every endpoint accepting an ID must verify that the requested resource belongs to the current tenant context *before* performing any action.

## Testing Scenarios

The following scenarios must be covered in our automated test suite (`apps/cms/src/__tests__/idor-tenant-isolation.integration.test.ts`):

### 1. Single Item Operations
*   **GET `/:collection/:id`**: Attempt to fetch a record belonging to another tenant.
*   **PATCH `/:collection/:id`**: Attempt to update a record belonging to another tenant.
*   **DELETE `/:collection/:id`**: Attempt to delete a record belonging to another tenant.

### 2. Bulk Operations
*   **POST `/:collection/bulk`**:
    *   Attempt to update a batch of records where some or all belong to another tenant.
    *   Attempt to delete a batch of records where some or all belong to another tenant.
    *   *Risk:* Iterating over a list of updates without verifying tenant ownership for *each* item.

### 3. Revisions and Sub-resources
*   **GET `/:collection/:id/revisions`**: Attempt to view the revision history of a record from another tenant.
*   **POST `/:collection/:id/revert/:revisionId`**: Attempt to revert a record from another tenant to a previous revision.
*   **DELETE `/:collection/:id/pins/:field`**: Attempt to remove pins from a record belonging to another tenant.

## Simulating Tenants in Tests

In integration tests, the tenant context is established using the `X-Lumi-Site` HTTP header.

```typescript
const res = await app.request('/api/v1/items/lumibase_example/target_id', {
  method: 'GET',
  headers: {
    'X-Lumi-Site': 'tenant-b-id', // Simulated tenant context
    'Authorization': 'Bearer <token_for_tenant_a_user>'
  }
});
// Expect 403 or 404
```
