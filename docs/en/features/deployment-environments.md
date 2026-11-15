---
version: 2
sourceLang: en
syncStatus: source
lastUpdated: 2026-11-15T08:36:24.853Z
contentHash: cc561dbc1dc254c4
codeVerified: 2026-11-15T08:36:24.853Z
codeVerifiedHash: cc561dbc1dc254c4
codeVerifiedClaims: 30
---

# Deployment Environments, Permissions & Promotion

> Decide **who** may deploy **where**. Map deployment targets to environments (`preview`, `staging`, `production`, or your own), grant `deploy:trigger:<env>` per role, promote a verified staging build to production, and put production behind a human approval that the requester cannot grant themselves.

Builds on [Deployment Integrations](./deployment-integrations.md) (targets, providers, status). Service: `apps/cms/src/services/deployment/release-service.ts` · Environment map: `apps/cms/src/services/deployment/environments.ts` · Mounted at `/api/v1/deployments`.

## 1. Model

- **Environment** — a named slot (`key`, `name`) mapped to one or more deployment targets (`targetIds`). Deploying an environment deploys every target it maps.
- **`requiresApproval`** — triggering or promoting **into** this environment never dispatches on request. It creates a pending approval; nothing reaches the provider until a different person approves it.
- **`promotesTo`** — the environment that `POST /environments/:key/promote` ships this environment's latest ready build into (`staging → production` by default).

The map is stored per site in the settings key `deployment.environments` (settings writes are site-admin only). Defaults, used until an admin saves a map:

| key | requiresApproval | promotesTo | targets |
|---|---|---|---|
| `preview` | no | — | none |
| `staging` | no | `production` | none |
| `production` | **yes** | — | none |

No target is mapped by default, so a site that never configures environments behaves exactly as before. A stored map that fails validation is **not** replaced by the defaults: every deploy path answers `ENVIRONMENTS_INVALID` until an admin fixes it, because silently falling back could un-map a production target from its approval gate.

## 2. Capabilities

Deploy permissions use the existing policy language, the same way `ai:decide` does: a permission row on the reserved pseudo-collection `lumibase_deploy:<scope>`. `<scope>` is an environment key, a deployment-target id, or `*`.

| Permission row | Capability | Allows |
|---|---|---|
| `lumibase_deploy:<scope>` · `create` | `deploy:trigger:<scope>` | trigger / promote into the scope (or request it, when approval is required) |
| `lumibase_deploy:<scope>` · `update` | `deploy:approve:<scope>` | approve or reject pending deploys gating that environment |
| `lumibase_deploy:*` · `create` / `update` | `deploy:trigger:*` / `deploy:approve:*` | every environment and target |

Derived in `capabilitiesFromPermissionBundle` (`apps/cms/src/services/effective-capability-service.ts`). Only exact rows count — no wildcard policy row mints a deploy capability — and a deploy row never mints an item capability. In Studio, **Access → Policies** lists these under the **Deployments** group.

Rules (`canTriggerEnvironment`, `canTriggerTarget`, `canApproveEnvironment`):

- Triggering an environment needs `deploy:trigger:*`, `deploy:trigger:<env>`, or `deploy:trigger:<targetId>` on **every** target it maps.
- Triggering one target directly needs `deploy:trigger:*`, `deploy:trigger:<targetId>`, or the key of any environment that contains it. If any of those environments requires approval, the direct trigger is gated too (the strictest environment wins) — `POST /targets/:id/deploy` cannot bypass the gate.
- A promotion is a deploy **into the destination**: it needs the trigger grant on the destination environment.
- A site admin holds every deploy capability. Admins are still subject to `requiresApproval` and still cannot approve their own requests.
- Publishable API keys and frontend sessions never get a deploy capability, whatever a policy says.

A caller with no deploy capability at all gets `403` on every deployments route, as before. Target CRUD, the environment map and build logs stay site-admin only.

### Example: Editor and Release manager

| Role | Permission rows | Staging | Production |
|---|---|---|---|
| Editor | `lumibase_deploy:staging` create, `lumibase_deploy:production` create | deploys now (`201`) | request parked (`202`) |
| Staging editor | `lumibase_deploy:staging` create | deploys now | `403` |
| Release manager | `lumibase_deploy:production` update | `403` | approves others' requests |

## 3. Approval gate

A gated request is stored in the site's HITL approval table `lumibase_ai_approvals` (agent `lumibase-deployments`, skill `deploy:trigger` or `deploy:promote`), see `apps/cms/src/services/deployment/deploy-approvals.ts`. These rows are not AI skills, so the AI approval inbox does not list or decide them; they are decided only through `/deployments/approvals`.

Deciding (`DeploymentReleaseService.decide`):

1. The decider must be a signed-in person (`HUMAN_APPROVER_REQUIRED` for an API key or agent).
2. The decider must not be the requester (`SELF_APPROVAL_FORBIDDEN`). The requester may **reject** (withdraw) their own request.
3. The decider needs `deploy:approve:<env>` or `deploy:approve:*`.
4. An approval expires after 7 days (`APPROVAL_EXPIRED`).
5. The plan is checked against the current environment map; targets an admin removed since the request are not deployed, and if none remain the approval fails (`PLAN_STALE`).
6. The requester's grant is resolved again; a requester demoted since parking makes the approval fail (`REQUESTER_REVOKED`).
7. An atomic `pending → deciding` claim makes sure two approvers clicking at once dispatch once.

Statuses: `pending`, `deciding`, `approved`, `rejected`, `expired`, `failed`.

## 4. Promotion

`POST /environments/staging/promote` takes the newest `ready` deployment of the staging targets (or the one given as `deploymentId`) and ships it to every production target (`DeploymentService.promote`):

- **native** — the destination target is the same provider project and the adapter supports promotion: the exact build goes live without a rebuild (Vercel `POST /v10/projects/:id/promote/:deploymentId`, Netlify deploy restore).
- **retrigger** — anything else: a fresh build of the same commit (Vercel pins `gitSource.sha`) or the same branch (Netlify builds the branch).

Promoted deployments are recorded with `triggerSource: promote`, and the mode is in the `deployment.promoted` audit event.

## 5. API

All responses use `{ data }` / `{ errors }`.

| Method & path | Who | Result |
|---|---|---|
| `GET /deployments/access` | any deploy grant | caller's `canTrigger` / `canApprove` per environment |
| `GET /deployments/environments` | any deploy grant | the environment map |
| `PUT /deployments/environments` | site admin | replace the map (`{ environments: [...] }`; unknown target ids → `UNKNOWN_TARGET`) |
| `POST /deployments/environments/:key/deploy` | `deploy:trigger:<key>` | `201` `{ status: 'dispatched', results }` or `202` `{ status: 'pending_approval', approval }` |
| `POST /deployments/environments/:key/promote` | trigger grant on the destination | as above |
| `POST /deployments/targets/:id/deploy` | trigger grant on the target or its environment | `201` deployment, or `202` pending approval when gated |
| `GET /deployments/approvals?status=pending` | any deploy grant | approvals with `canDecide` for the caller (`status=all` for history) |
| `POST /deployments/approvals/:id/decide` | `deploy:approve:<env>`, not the requester | `{ decision: 'approved' \| 'rejected', reason? }` |

## 6. Audit

Every step writes an audit event: `deployment.trigger.denied`, `deployment.approval.requested`, `deployment.approval.approved`, `deployment.approval.rejected`, `deployment.approval.refused` (self-approval, missing grant, revoked requester, stale plan), `deployment.approval.expired`, `deployment.promoted`, `deployment.triggered`, `deployment.environments.updated`.

## 7. Scope notes

- Gating applies to deploys a person or API caller requests through the deployments API. The agent tool `triggerDeployment` keeps its own HITL gate (`deployments:write`, approval below autopilot), and Flow `deploy:trigger` operations run as configured by a site admin.
- A `deciding` row left by a crashed process is not swept automatically; it stays out of the pending list and the request must be made again.
