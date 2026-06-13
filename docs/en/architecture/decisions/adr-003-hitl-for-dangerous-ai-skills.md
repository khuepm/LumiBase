# ADR-003: Human-in-the-Loop (HITL) for Dangerous AI Skills

**Date:** 2024-03-20
**Status:** Accepted

## Context

LumiBase includes an AI Copilot (`apps/cms/src/services/ai-harness.ts`) that allows admin users to issue natural-language commands which are executed as typed "skills" (e.g., `createCollection`, `deleteItem`, `updateField`).

Without guardrails, an AI agent could:
- Misinterpret an ambiguous command and delete a production collection
- Be manipulated via prompt injection in user-supplied content
- Execute a schema migration that cannot be easily rolled back
- Chain multiple destructive operations before a human notices

The risk profile is asymmetric: reading data is low-risk, but schema changes and bulk deletions are potentially catastrophic and irreversible.

## Decision

Classify every AI skill into one of two categories:

**Safe skills** (execute immediately):
- Any skill that only *reads* data: `listCollections`, `listItems`
- Create/update operations on *items* (data, not schema): `createItem`, `updateItem`

**Dangerous skills** (require Human-in-the-Loop approval):
- Any skill requiring capability `schema:write`: `createCollection`, `deleteCollection`, `createField`, `deleteField`, `updateField`
- Any skill whose name starts with `delete`: `deleteItem`, `deleteCollection`, `deleteField`, `deleteUser`

Classification logic in `AISecureHarness.evaluateRisk()`:

```typescript
function isDangerous(skill: Skill, session: Session): boolean {
  return skill.requiredCapabilities.includes('schema:write') ||
         skill.name.startsWith('delete');
}
```

When a dangerous skill is requested:
1. The harness creates an `ai_approvals` row with `status='pending'`, storing the skill name and arguments
2. It returns `{ status: 'pending_approval', approvalId }` to the Studio UI
3. An admin reviews the approval in the Approvals Dashboard and clicks **Approve** or **Reject**
4. On approval, the harness executes the skill with the stored arguments

## Consequences

**Positive:**
- Humans remain in control of all destructive or schema-altering operations
- Audit trail: every AI action (executed or rejected) is recorded in `ai_approvals`
- Reduces blast radius of prompt injection attacks — an injected instruction can at most create a pending approval, which a human must review
- Simple, predictable rules that developers and admins can understand at a glance

**Negative:**
- Adds friction to legitimate destructive commands — admin must context-switch to Approvals Dashboard
- Async flow complicates the Studio UX (need pending badge, polling or WebSocket push)
- Wildcard `'*'` in user capabilities bypasses classification — must be restricted to superadmin only

**Neutral:**
- The threshold (safe vs dangerous) is a judgment call. Future iteration may add an intermediate category ("warn but execute") for medium-risk operations
- HITL does not prevent a compromised superadmin account from approving injected actions — this is a known limitation outside the scope of the AI harness
