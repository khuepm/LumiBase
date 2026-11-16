---
version: 2
lastUpdated: 2026-11-15T19:40:16.120Z
sourceLang: en
contentHash: 6970ed76c5a83487
codeVerified: 2026-11-15T19:40:16.120Z
codeVerifiedHash: 6970ed76c5a83487
codeVerifiedClaims: 6
---

# Agent receipts

Agents leave receipts. **Mission Control → Receipts** (`/mission-control/receipts`) shows what the
site's governed agents did over a window, what humans had to decide, what it cost and where content
drifted — so an operator can tell whether to grant more autonomy or less (#713, epic #671 A05).

## What is reported

`GET /api/v1/agent/receipts?since=…&until=…` (default: the last 30 days; at most 180 days) returns:

| Section | Figures | Source table |
|---|---|---|
| `runs` | total, by status, by agent, `failureRate` = failed / (succeeded + failed) | `agent_runs` |
| `toolCalls` | per skill: calls, outcome counts, p50 latency | `agent_tool_calls` |
| `approvals` | by status, by approver (`human` / `agent`), latency p50 / p90 / average in minutes (decided approvals only) | `agent_approvals` (`kind = 'approval'`) |
| `vetoes` | veto windows: vetoed, committed, pending, `vetoRate` | `agent_approvals` (`kind = 'veto'`) |
| `questions` | `askUser` questions asked / answered / expired | `agent_approvals` (`kind = 'question'`) |
| `overrides` | a human said no: rejected approvals + vetoes, `overrideRate` | `agent_approvals` |
| `cost` | tokens and USD, per skill | `agent_tool_calls.cost` |
| `drift` | opened, resolved, open now, by rule | `content_drifts` |
| `incidents` | by source and severity | `agent_incidents` |
| `autonomy` | current grants, level distribution, promotions applied, incidents that carry a capability | `agent_autonomy_grants`, `activity` (`trust_ledger.promotion_applied`) |
| `daily` | per day: runs, succeeded, failed, approvals, incidents, tokens, USD | the tables above |

Every figure is computed at read time from tables the harness and trust ledger already write.
**Nothing is written on the agent hot path** for this report, and no worker produces it.

## Alerts

Thresholds are set in the page (or `PUT /api/v1/agent/receipts/alerts`) and stored in the
`agent.receipts.alerts` setting. The report lists every threshold it crosses in `alerts`, and the
page highlights the matching tile. An absent threshold is not checked; a metric with no data
(for example no finished run) never alerts. Defaults: run failure rate 0.2, veto rate 0.25, human
override rate 0.3, approval latency p90 1440 minutes. A corrupt stored row falls back to the
defaults rather than silencing every alert.

## CSV export

`GET /api/v1/agent/receipts/export?kind=runs|tool_calls|approvals` streams one row per run, tool call
or approval in the window, at most 10,000 rows (`X-Export-Truncated: true` when cut). Tool inputs and
outputs are never exported. Text cells that start with `=`, `+`, `-` or `@` are prefixed with `'` so a
spreadsheet does not evaluate them.

## Access

The routes live under `/api/v1/agent`, which is a control-plane prefix: only a site administrator
reaches them, like the trust ledger.

## Multi-tenancy

Every query is filtered by the request's `site_id` and the window; thresholds are a per-site setting.
Verified by `agent-receipts.db.integration.test.ts`, which seeds an identical fixture on a second site
and checks that no figure doubles.
