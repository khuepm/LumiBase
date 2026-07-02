---
version: 1
lastUpdated: 2026-06-23T09:48:37.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: 576e46902420aee8
mtEngine: claude
syncStatus: machine-translated
---

# LumiBase AI-Native Vision — Redefining the CMS for the AI era

> **Status:** Proposal / product direction. This document describes a vision and a plan — not the current behavior of the system. What is already implemented is clearly marked in the [Gap analysis](#7-gap-analysis--current-state-vs-target) section.
>
> **Technical premises:** [agent-harness-layer.md](./features/agent-harness-layer.md) · [ai-copilot.md](./features/ai-copilot.md) · [flows-automation.md](./features/flows-automation.md) · [ADR-003 HITL](./architecture/decisions/adr-003-hitl-for-dangerous-ai-skills.md)

---

## 1. The central thesis

**A traditional CMS is a tool for humans to operate on content. LumiBase is an operating system for AI to operate content — humans take on the role of setting intent, defining taste, and holding ultimate accountability.**

A new name for the category: **Content Operating System (Content OS)** — no longer a *Content Management System*.

Three foundational shifts:

| | Traditional CMS | LumiBase Content OS |
|---|---|---|
| **Unit of work** | An operation (create item, edit field, publish) | An **intent** (goal: "keep the catalog always stocked with images + descriptions in 2 languages") |
| **Operator** | An editor/admin acting through the UI | An **agent** executing in a harness; humans review exceptions |
| **Content state** | Static — correct as of whenever someone last edited it | **Live** — continuously reconciled toward a desired state |

"Replacing humans" here has a precise meaning: **replacing operational labor** (data entry, translation, tagging, manual SEO, data cleanup, writing descriptions). Humans move up a layer: intent, taste, policy, accountability. This is not a safety slogan — it is design: the system can only become autonomous when responsibility has an address and every action is reversible.

---

## 2. Seven deep design principles

### P1. Intent over operations (Intent-driven, not operation-driven)

The CMS's first-class API is no longer `POST /items` but `POST /agent/goals`. A goal is a declarative statement of a desired outcome + constraints + budget. The harness decomposes a goal into a plan, and the plan into tool calls. `agent_goals` already exists — this principle elevates it from "a log of the copilot" into the **primary operating interface** of the product.

Design consequence: every new feature must answer "how does an agent call it?" before it answers "how does the UI display it?". The UI is a projection of the agent surface, not the other way around.

### P2. Desired state & reconciliation (learned from Kubernetes, applied to content)

Content has declarable **SLOs**: *"every published `product` must have ≥1 image, a 50–200 word description, `vi`+`en` translations, no broken links, and a price updated within 24h"*. A **reconciliation loop** runs periodically: detect drift → generate a goal → the agent fixes it within budget → record the artifact + provenance. Humans do not "manage content"; humans **declare the desired state** and the system converges toward it on its own.

This is the deepest redefinition: today's CMS is a *write-time tool*; the Content OS is a *control loop* — content that violates its SLO is an incident that is auto-handled, like a crashed pod being restarted.

### P3. Trust gradient — autonomy is earned, not granted

Binary HITL (safe → run, dangerous → wait for approval) is correct on day one but does not scale: humans become a bottleneck and "approval fatigue" strips approval of its value. Replace it with **5 levels of autonomy per (site, agent, capability)**:

| Level | Name | Behavior |
|---|---|---|
| **L0** | Shadow | The agent runs, output is only recorded into artifacts — no proposals, no impact. Used for evaluation. |
| **L1** | Propose | Every action creates a pending approval (full HITL). |
| **L2** | Co-sign | Safe actions run automatically, dangerous actions wait for approval. *(= current harness behavior)* |
| **L3** | Veto-window | A dangerous action **executes into a staging revision and commits after T hours unless someone vetoes**. Humans shift from pre-approval to post-veto (HOTL — human-on-the-loop). |
| **L4** | Autopilot | Executes within the capability + budget; a kill switch is always available. |

**Promotion is data, not gut feeling:** level up after N consecutive runs pass evaluation + approval-rate ≥ threshold + zero incidents within the window. **Demotion is automatic** on an incident, rejection, or evaluation failure. The whole thing is an auditable *trust ledger* — the existing `agent_evaluations` + `agent_approvals` are the data source.

L3 (veto-window) is the most important invention of this scale: it reverses the burden — silence means consent — while still retaining an absolute veto right and rollback. Most organizations will live long-term at L3, not L4.

### P4. Content constitution (Tenant Constitution) — editorial taste becomes machine-checkable

What humans are best at — brand voice, tone, legal boundaries, taxonomy, "what makes a good article" — must be encoded into a **constitution per tenant**: a set of evaluators (rule DSL + LLM-judge prompt) that is versioned and hashed. Every `agent_run` pins to a `constitutionHash` (extending the existing `policySnapshotHash`). An artifact that does not pass the constitution cannot be published, regardless of autonomy level.

Consequence: the "editor" of the AI era is the person who **writes and refines the constitution**, not the person who edits each article. Editing one evaluator = changing the behavior of every agent from then on — a 1→N lever instead of 1→1.

### P5. Provenance-first — every byte of content has a lineage

In the era of machine-generated content, **lineage is a distribution feature, not auxiliary metadata**. Every revision records: the agent/run/model that produced it, the referenced sources, the constitution hash, the evaluation result, which human approved it (if any), and a confidence score. Provenance is exposed via the Delivery API (inspired by C2PA) — downstream sites can prove their content is clean. This is the commercial USP: other CMSs cannot answer the question *"where did this paragraph come from and who is responsible for it?"*.

### P6. An agent newsroom (multi-agent organization, not one-big-agent)

An omnipotent agent is an anti-pattern: context balloons, responsibility blurs, and evaluation cannot isolate faults. Instead, an **org chart of agents** — modeling a newsroom:

```
                    ┌────────────────────┐
   intent ───────► │  Planner / Chief    │  decompose goal → sub-goals
                    └─────┬──────────────┘
        ┌────────────┬────┴───────┬─────────────┐
        ▼            ▼            ▼             ▼
   Writer        Translator   Taxonomist     SEO agent
   (items:write) (items:write)(schema:read)  (items:update)
        │            │            │             │
        └────────────┴─────┬──────┴─────────────┘
                           ▼
                    ┌────────────────────┐
                    │  Reviewer / Fact-  │  agent-as-reviewer for low risk,
                    │  checker agent     │  escalate to humans for high risk
                    └────────────────────┘
```

Mechanism: a sub-goal is an `agent_goals` with a `parentGoalId`; each role agent has its own narrow capability grant in `agent_permissions`; **cross-review between agents** is a kind of approval (the approver is an agent with the `review:*` capability) — humans only receive escalations. Narrow per-role permissions are defense-in-depth: a Writer never has `schema:*`, so a prompt-injected writer still cannot modify the schema.

### P7. A dual interface — Studio is Mission Control, API/MCP is the front door

- **For agents (the front door):** the entire skill registry is exposed as a standard **MCP server**, so external agents (Claude Code, a customer's agent) can operate the CMS as first-class citizens, still going through the harness/capability/risk just like internal agents. Plus a per-site `llms.txt` for content delivery — because **content consumers are increasingly agents too**.
- **For humans (the oversight door):** Studio evolves from an *editing surface* into a *mission control*: an exception inbox, diff review, the trust ledger, the kill switch, the constitution editor. The item-edit form still exists, but as an emergency exit, not the main workflow.

---

## 3. The target operating model (a day in the Content OS)

```
06:00  The reconciler scans SLOs: 14 products missing vi translations, 3 blog posts stale,
       2 broken links → generates 3 goals, assigned to Translator/Writer/Librarian agents.
06:05  The Translator agent (L4) translates 14 descriptions, evals pass the constitution → publish directly,
       provenance fully recorded.
06:10  The Writer agent (L3) rewrites 3 stale posts → commit into a staging revision,
       4h veto window, notify the #content channel.
08:30  An editor opens mission control: sees 3 diffs awaiting veto — skims them, vetoes 1 post
       (wrong tone), the other 2 auto-commit at 10:10. The vetoed post → a demotion signal
       for the Writer agent on that capability.
09:00  A customer types into chat: "next month we're launching a new product line, prepare the landing page"
       → a new goal → the Planner decomposes: schema diff (needs approval - L2), page spec,
       seed content, SEO plan → artifacts awaiting review.
```

Humans in this picture do three things: **set intent**, **veto/approve exceptions**, and **refine the constitution**. Nobody types `create item` forms all day anymore.

---

## 4. The Human Control Plane

Autonomy does not mean slipping out of human hands. This is still a **tool** — and "the tool must obey the human" is encoded as an immutable law of the system, not a promise in the docs.

### Law Zero — Human override is law

**Every human manual edit wins absolutely. An agent/reconciler never overwrites a human edit.** This is the lesson from GitOps: a controller that "argues with humans" (reverting a manual change back to the desired state) is the fastest way to lose trust. Mechanism:

- Each revision has an `authorType: human | agent`. When a human edits content that an SLO/agent is managing, the system asks exactly one question: *"Is this a **one-time exception** (pin it, the agent won't touch it again) or a **new rule** (update the desired state / constitution)?"* — the safe default is **pin**.
- Pinning is at the **field** level: if a human edits the headline, the headline is pinned, while the agent may still update the price/inventory on the same item.
- Pins are visible and removable — the human "releases" control back to the agent when they wish.

Each such human edit is also a **signal that teaches the system**: the pattern of pins and vetoes is the data used to refine the constitution (section P4) — human intent seeps into the law instead of requiring endless manual edits.

### Four powers of intervention — each with a concrete surface and mechanism

| Power | The user's question | Surface | Mechanism |
|---|---|---|---|
| **Observe** — monitor | "What is the system doing? Why is it doing that?" | Mission control: SLO health per collection, run timeline, provenance on each revision, the trust ledger | The existing harness tables + Prometheus metrics; proactive notifications via the notifications module / email / webhook (Slack…) |
| **Steer** — redirect | "Do it, but do it differently" | Intent composer, constitution editor, autonomy grants | Edit the goal/SLO/evaluator → every subsequent run pins to the new version; no need to touch each item |
| **Override** — do it yourself | "Step aside, I'll do it myself" | Form editing (still exists), veto within the window, edit the artifact before publish | Law Zero; veto = auto-rollback + incident + demotion signal for the agent |
| **Stop** — halt | "Stop right now" | Kill switch | 4 levels of granularity: cancel a **run** → pause an **intent** → freeze a **role** → freeze the **site**; a freeze halts even a running run at the tool-call boundary |

### Reverse escalation — the machine proactively calls the human

Intervention is not just a human on patrol. The agent **must** escalate when: confidence is low, an evaluation is borderline, the budget is nearly exhausted, an action touches an irreversible boundary, or two reviewing agents disagree. Every escalation includes a deep-link to the diff + action buttons right in the notification — a person decides in 10 seconds, not by digging through logs.

### Who may intervene at what level

No new permission model is invented: the rights to veto, approve, edit the constitution, remove a pin, and hit the kill switch are all **permissions in the existing RBAC**. A site admin assigns intervention rights per human role exactly like assigning data permissions — a single permission language for both humans and machines (see 5.2).

---

## 5. The two real planes of work

Operating a CMS in practice consists of two planes. This vision must serve both, including the operational problems that arise (cache, overload, continuous DB writes).

### 5.1 Experience plane — configuring the website

Scope: sitemap, pages, sections, layout, filters, forms, personalization, and the data flows feeding the CMS (ingestion).

**How an agent operates this plane — config is code, not a chain of clicks:**

- The entire UI configuration is a **config-as-code artifact**: an intent *"add landing page X: hero + a product grid filtered by tag + a sign-up form"* → the agent generates a page spec / sitemap diff / form spec as an artifact → review the diff like a PR → veto-window → publish. Nobody clicks to build each section anymore; humans review the **diff of the experience**, not each step.
- Personalization = segments + rules proposed by the agent from behavioral data, checked by the constitution (no dark patterns, complying with the tenant's privacy policy) and measured with an experiment artifact before being applied to all traffic.
- Ingestion flows = Flows + CDC; the agent monitors these very flows (failure rate, schema drift of external sources) — a broken data flow is also a kind of drift to be reconciled.

**The inherent operational problems of this plane and their solutions:**

| Real problem | Existing foundation | Addition in the plan |
|---|---|---|
| Configure the UI then call again to fetch data (2 round-trips) | The hydration BFF `/deliver/page/:slug` merges page config + data into 1 JSON ([page-hydration.md](./architecture/page-hydration.md)) | An agent-generated page spec must declare a `source` per section so it always goes through the hydration path; the evaluator rejects any spec that forces the client to make separate calls |
| Cache churn when config/content changes constantly | Tag-based invalidation ([ADR-004](./architecture/decisions/adr-004-tag-based-cache-invalidation.md)) | The agent writes **batch + coalesce** per run per collection → invalidate by tag **once**, not N times |
| Traffic overload / hot read path | Edge cache + materialized collections ([materialized-collections.md](./features/materialized-collections.md)) | The agent itself proposes a materialized collection when it sees a hot query pattern from metrics — optimizing the read infrastructure is also drift to be reconciled |
| The DB being written to continuously | CDC + anomaly module | **Load-aware autonomy** (below) |

**Load-aware autonomy — a system that creates load must sense load.** This is the deepest operational guardrail: when an agent runs reconciliation continuously, it itself becomes a new source of load. Therefore:

- Each intent has a **maintenance window** (off-peak by default) and a **separate rate budget for writes** (writes/minute), distinct from the tool-call budget.
- A **backpressure feedback loop**: the anomaly module (RPS spike, rising DB latency, dropping cache hit-rate) emits a signal to the harness → the reconciler slows down or pauses itself + opens an incident. Autonomy is not just bounded by a static budget but by **real-time runtime health** — the machine must yield to the traffic of real users.

### 5.2 Content plane — editing, data processing, permissions

- **An editorial flow tailored to each organization**: an editorial workflow is a Flows graph in which each station is either a **human station** (await approval/edit) or an **agent station** (writer, translator, fact-checker — section P6) — the same engine, mixing humans and machines by trust level. An organization that wants 100% human review keeps every dangerous station at L1; one that wants gradual automation promotes each station per the trust ledger.
- **Data processing** (dedupe, normalize, enrich, classify, migrate) is a drift detector + a skill running in the background — high volume, artifact-first: the agent presents a batch diff "normalize 2,300 records" to approve once, not 2,300 times.
- **One permission language for both humans and machines**: an agent role uses the very policy DSL / capability of the existing RBAC ([permissions-rbac.md](./features/permissions-rbac.md)) via `agent_permissions`. An admin assigns agent permissions just like user permissions — no new model to learn; and the human's intervention rights (veto/approve/constitution) live in that same system (section 4).

---

## 6. The target architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  INTENT LAYER          goals · SLO/desired-state · constitution │
├─────────────────────────────────────────────────────────────────┤
│  ORCHESTRATION LAYER   planner · multi-agent delegation ·       │
│                        reconciliation loops (Flows + queue)     │
├─────────────────────────────────────────────────────────────────┤
│  HARNESS LAYER (exists) runs · tools · capability check · risk ·│
│                        budget · approvals · artifacts · evals ·  │
│                        memory                  + autonomy ledger │
├─────────────────────────────────────────────────────────────────┤
│  TRUST LAYER           provenance · trust ledger · veto window · │
│                        kill switch · incident → demotion         │
├─────────────────────────────────────────────────────────────────┤
│  DATA LAYER (exists)   collections · items · revisions · RLS ·  │
│                        multi-tenant · embeddings                 │
├─────────────────────────────────────────────────────────────────┤
│  SURFACES              MCP server · Agent API · Delivery API +   │
│                        llms.txt │ Studio Mission Control          │
└─────────────────────────────────────────────────────────────────┘
```

Invariants inherited intact from the current harness (non-negotiable):

1. Prompt text can never grant a capability — only the policy snapshot and grants can.
2. Every agent table is scoped by `siteId`.
3. Every autonomous action must be reversible (revisions) — an irreversible action (hard delete, sending email externally) never exceeds L2.
4. Budgets (tool calls, cost, time, artifact size) hard-cap every run.
5. The audit is never overwritten — a retry is a new run linked to the old one.

---

## 7. Gap analysis — current state vs target

Already present (per the docs + code in `apps/cms/src/services/`):

- ✅ A complete harness: `agent_goals/runs/plans/tools/permissions/tool_calls/approvals/artifacts/evaluations/memory`, budget, risk policy, audit, metrics, dead-letter queue.
- ✅ 2-level HITL (= L1/L2 of the autonomy scale), capability check, policy snapshot hash.
- ✅ A multi-provider LLM layer + embedding service + RAG skills.
- ✅ The Flows engine (webhook/event/schedule/manual triggers) — the foundation for the reconciler.
- ✅ Artifact-first app generation MVP + evaluation gates.

Gaps already closed (the Content OS spec — see [`.kiro/specs/content-os/tasks.md`](../../.kiro/specs/content-os/tasks.md)):

- ✅ The 5 core skills wired to a real LLM, with provider errors surfaced explicitly (no fallback stub).
- ✅ SLO/desired-state: `content_intents` + drift detection + a reconciliation loop on Flows.
- ✅ The L0–L4 trust ledger: grants, human-gated promotion, automatic demotion, veto-window (L3), a 4-level kill switch.
- ✅ A constitution per tenant: versioned evaluators (rule DSL + llm_judge), pinning the hash into the run, a publish gate.
- ✅ Provenance on revisions (`authorType`, `createdByRunId`, `model`, `constitutionHash`, …) + `?provenance=true` on Delivery.
- ✅ Multi-agent delegation: `parentGoalId`, a role library (role ∩ grant), agent-as-reviewer (self-review forbidden).
- ✅ An MCP server at `/api/v1/mcp` (Streamable HTTP) + a public llms.txt per site.
- ✅ Long-running runs via a queue (`queued/cancelled`, resume without re-running already-completed tool calls).
- ✅ Mission Control in Studio: exception inbox, SLO health, trust ledger, constitution editor, intent composer, kill switch UI.

Rollout: four per-site flags `contentOs.reconciler / vetoWindow / agentReview / mcp` — **off** by default; with every flag off ⇒ behavior is identical to pre-Content-OS.

---

## 8. The 5-phase roadmap

> **Detailed implementation spec** (EARS requirements, design, task checklist): [`.kiro/specs/content-os/`](../../.kiro/specs/content-os/requirements.md)

Each phase ships independently, with later phases building on earlier ones. Label conventions follow [roadmap/tasks.md](./roadmap/tasks.md).

### Phase A — Make the foundation real (Make it real)

*Goal: no more stubs; external agents can connect; long-running runs work.*

- `[BE]` Wire the 5 stub skills to a real LLM provider + embedding context (RAG from existing items/schema).
- `[BE]` Push runs that exceed the request limit through `QueueProvider` (the abstraction already exists) — run state machine: `queued → running → awaiting_approval → done/failed`.
- `[BE]` An **MCP server** mounted at `/api/v1/mcp`: expose the `agent_tools` registry as MCP tools; auth = a token with a capability; every call goes through the harness just like internal ones. *(One codepath, two doors.)*
- `[BE]` `llms.txt` + semantic delivery per site for content consumers that are agents.
- `[DB]` Provenance columns on revisions: `createdByRunId`, `model`, `constitutionHash`, `sources jsonb`, `confidence` — plus `authorType: human | agent` and `pinnedFields jsonb` as the foundation for Law Zero (section 4).

### Phase B — Content as a living system (Reconciliation)

*Goal: content converges to the desired state on its own.*

- `[DB]` A `content_intents` table (SLO): `siteId, collection, rules jsonb, schedule, budget, autonomyCap, status`.
- `[BE]` **Drift detectors** (running as scheduled Flows): stale content, missing SLO-required fields, missing translations (leveraging translation memory), broken links, SEO score, glossary deviation.
- `[BE]` The reconciler: drift → auto-generated `agent_goals` (idempotent, deduped by drift fingerprint) → the harness executes within the intent's `autonomyCap`.
- `[BE]` **Override-is-law semantics**: the reconciler reads `authorType`/`pinnedFields` — never overwrites a human edit; the "exception or new rule?" prompt when a human edits SLO-managed content.
- `[BE]` **Load-aware autonomy**: a maintenance window + a write rate budget per intent; write batching/coalescing + a single tag-invalidation per run; a backpressure signal from the anomaly module → slow down/pause the reconciler + an incident.
- `[FE]` Studio: the SLO screen — declare an intent in natural language, the LLM compiles it into rules jsonb, displays "content health" per collection.

### Phase C — The agent newsroom (Multi-agent org)

*Goal: decomposition and cross-review between agents; humans only receive escalations.*

- `[DB]` `agent_goals.parentGoalId`; an `agent_roles` table (name, systemPrompt ref, capability grants, model).
- `[BE]` The Planner agent: goal → sub-goals assigned by role; each role runs its own narrow capability (a Writer never has `schema:*`).
- `[BE]` Agent-as-reviewer: an approval has an `approverType: human | agent`; low risk is decided by the Reviewer agent (capability `review:*`), with a reason recorded in the audit; high risk escalates to a human. The escalation threshold is policy, not hardcoded.
- `[AI]` A default role library: Writer, Translator, Taxonomist, SEO, Fact-checker, Librarian (archive/cleanup).

### Phase D — Earned autonomy (Trust ledger)

*Goal: the L0–L4 scale operates on data.*

- `[DB]` An `agent_autonomy_grants` table: `siteId, agentRole, capability, level (0-4), evidence jsonb, grantedBy, expiresAt`. An `agent_incidents` table: the source of demotions.
- `[BE]` A promotion engine: computed from `agent_evaluations` + `agent_approvals` + incident history; promotion requires human confirmation (itself an approval), while **demotion is automatic and immediate**.
- `[BE]` **Veto window (L3)**: a dangerous op writes into a staging revision + an `agent_approvals` of the `auto_commit_at` kind; a commit job via the queue; veto = reject + auto-rollback + incident.
- `[BE]` Kill switch per site/per role: `agent_runtime: active | paused | frozen` — frozen halts even a running run at the tool-call boundary.
- `[FE]` Trust ledger UI: the current level, the evidence, the promote/demote history per role × capability.

### Phase E — Inverting the interface (Mission Control)

*Goal: Studio defaults to monitoring, not data entry.*

- `[FE]` The **exception inbox** becomes the default screen: the veto queue (diff view), escalations, incidents, SLO violations not yet auto-handled.
- `[FE]` The **constitution editor**: write/edit an evaluator in natural language + test it on real content (eval-driven editing); versioning + a constitution diff.
- `[FE]` The intent composer: replace "Create item" with "Describe what you want" as the primary CTA; form editing remains as a secondary path.
- `[DOC]` Reposition the messaging: LumiBase = Content OS; update [vision-and-positioning.md](./vision-and-positioning.md).

---

## 9. North-star metrics

| Metric | Definition | Maturity target |
|---|---|---|
| **Autonomous operation rate** | % of write operations executed by an agent without a human touch | > 90% |
| **Human-touch per published item** | Number of human interactions / published item | < 0.1 |
| **Intent-to-live latency** | From setting a goal to content going live | Minutes, not days |
| **Veto rate (L3)** | % of staging commits that get vetoed | < 5% and declining |
| **Incident rate** | Incidents / 1,000 autonomous ops | Monotonically decreasing over time |
| **Constitution leverage** | Number of agent behaviors changed / 1 evaluator edit | Increasing |
| **Override-respect rate** | % of human edits/pins respected absolutely by the agent | 100% — an invariant, not a target |
| **Coalescing ratio** | Number of agent writes / number of tag-based cache invalidations | Increasing (efficient batching) |
| **Backpressure activations** | Number of times the reconciler slows itself down due to runtime load | Present and reviewed — proving load-awareness works |

All of these are measurable from the existing harness tables + the Prometheus metrics described in [observability.md](./features/observability.md).

---

## 10. Risks & guardrails

| Risk | Guardrail |
|---|---|
| Prompt injection from content/web escalating an agent | Invariant #1 (a prompt grants no rights) + narrow per-role capability + the existing outbound URL guard/SSRF guard |
| Silent quality drift at L4 | Sampling: x% of L4 output always falls back to human review; constitution eval runs on every publish |
| Approval fatigue making review meaningless | This is the very reason L3 veto-window + agent-as-reviewer exist — reducing the human's review load down to only exceptions |
| A reconcile loop running wild (goal storm) | Dedupe by drift fingerprint + a budget per intent + a circuit breaker (N consecutive failures → pause the intent + an incident) |
| Irreversible actions | Never exceed L2; hard delete is still a soft delete + retention as today |
| The machine "arguing with humans" — the reconciler reverting a manual edit | Law Zero: `authorType` + field-level pins; the reconciler never overwrites a human edit |
| The agent overloading the infrastructure itself (cache churn, DB write storm) | Load-aware autonomy: write batching + a single tag-invalidation, a maintenance window, a write rate budget, backpressure from the anomaly module |
| Losing the customer's trust | Public provenance + a complete audit trail + a one-button kill switch |

---

## 11. One-paragraph summary

LumiBase already has the right skeleton: a harness governing agents with goals, runs, tools, approvals, artifacts, evaluations, and memory. This plan turns the skeleton into a living body in 5 steps: **(A)** make the skills real + open the MCP, **(B)** turn content into a self-converging system via SLOs + reconciliation, **(C)** organize agents into a newsroom with role assignment and cross-review, **(D)** replace binary HITL with an earned autonomy scale featuring a veto-window, **(E)** invert Studio into mission control. The result is a new product category — the **Content Operating System** — where AI is the primary operating workforce across both planes (configuring the experience and managing the content), while humans retain four non-negotiable powers — observe, steer, override, stop — with Law Zero ensuring the machine never argues with the human, and load-aware autonomy ensuring the machine never crushes the infrastructure that serves real users.
