---
version: 1
lastUpdated: 2026-11-25T18:14:56.944Z
sourceLang: en
contentHash: 7e08c2ef9053979c
---

# Item co-editing (#854)

## Decision

Use Yjs 13.6.27 (MIT) for collaborative rich text. Give each editable field its own Y.Doc, keyed by site, collection, item, content version and field. This makes the replication boundary match the unit of authorization. A whole-item document would reveal hidden values through its binary history. Keep scalar, array and relation edits on the existing conditional API. Studio retains the local draft on a stale save and asks the editor to reconcile.

Server-authoritative OT would require both runtimes to retain an ordered transformation history and rebase offline operations. Yjs lets a returning editor exchange missing updates by state vector. Automerge and Loro are alternatives for structured documents, but this slice only needs rich-text sequences. Load Yjs lazily with the Studio editor. Measure compressed Studio chunk and Worker bundle deltas against the epic branch before enabling the feature. Include the MIT notice with distributed builds.

## Existing prototype

Retire cursor-protocol.ts, use-cursor.ts and cursor-overlay.tsx when their replacements land. Keep the existing presence banner. Starting from “ab”, Alice and Bob each insert their initial at offset 1. Applying the remote batch to each local buffer produces “aBAb” for Alice and “aABb” for Bob. Sorting a single batch in applyOps() cannot order operations already applied locally. Duplicate delivery also repeats an insert.

## Delivery and verification

- CE2 (#914) maps the rich-text schema from #695 to a versioned field snapshot. Persist accepted updates and the projected JSON revision atomically. Record actor and update identity so retries create one revision.
- CE3 (#915) shares the handshake and state-vector protocol between SiteRoom and node-hub. Rehydrate from durable state after restart.
- CE4 (#916) requires unmasked field read access to join and checks write permission for every update. Stage and validate changes before persistence or broadcast. Revoke sessions on permission changes.
- CE5 (#917) binds the editor to the field and uses relative cursor positions. Test two Studio sessions editing offline and online, then reconnect and resend. Both editors and stored JSON must converge on Workers and Docker.
- CE6 (#918) isolates release drafts and versions. Governed writes pass through existing approval and revision checks. An external whole-field replacement starts a new document generation and surfaces stale offline work for explicit reconciliation.

Schema editing, media editing and collaborative relation ordering are outside this decision.
