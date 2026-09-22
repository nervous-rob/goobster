---
title: Shared-instance safety and release evidence
kind: reference
summary: Account isolation, shared execution admission, edit conflicts, and the host verification gate for Increment D.
tags: [identity, isolation, concurrency, sandbox, deployment]
---

# Shared-instance safety

Increment D implements the code-side safety gates in [the product spec](shared_instance_product_spec.md) and [issue #247](https://github.com/nervous-rob/goobster/issues/247). It does **not** authorize opening invitations. Strong isolation on the actual deployment host remains a required, separately recorded check. Spending limits and atomic cost reservations belong to [#248](https://github.com/nervous-rob/goobster/issues/248); invitation volume and measured host capacity belong to [#265](https://github.com/nervous-rob/goobster/issues/265).

## Re-audit of current main

The implementation was rechecked against `42be241` (main after PR #271), rather than relying on the September 19–21 observations.

| Area | Main at audit | Increment D change / evidence |
|---|---|---|
| Native identity and disabled accounts | Sessions, active-account checks, recent authentication and session versions already existed. | Reuse them for every live stream, including idle connections. Recheck active accounts on execution admission and lease renewal. |
| Retrieval and project access | DM/user scopes, owner-qualified project lookup, collaboration checks and existing scope regression tests already existed. | Add adversarial native-account HTTP tests and fail-closed stream tests. Project-linked discussion lists and reads now consult authoritative project membership even when the discussion mirror is stale. |
| Operator documentation | `operator/` notes were part of the same searchable/listable corpus as public documentation. | Exclude them before lexical/vector retrieval and fallback, and from lists/direct resolution. `consultDocs` permits them only for an active operator in their private Study. Unknown context and shared discussions receive public docs only. |
| Browser state | Music Lab content and samples used device-wide keys/databases; query providers outlived a changed session. | Account/installation namespaces, aborted fetches, recreated providers, cache/buffer clearing and cross-tab session notices. Headers bind private API fetches to the displayed account/session. |
| Live connections | Authentication happened at connection establishment. | Bounded ordered output, fresh session/account and resource checks before delivery, idle reauthorization, shared connection caps and lease cleanup. |
| Execution concurrency | Durable web-turn/scheduler claims existed, but sandbox counters were process-local; routed model calls had no shared installation admission. | Database-backed model, sandbox and stream leases shared by replicas; bounded waiting and per-account caps. Preserve existing durable turn and delivery claims. |
| Settings conflicts | Revision checks were read before a later write, allowing a Postgres race. | Conditional revision increment in the same transaction as the section update. |
| Notes, assets and plans | Asset history and plan revisions existed but did not consistently reject stale human saves. | Revision tokens, conflict responses and compare/reload flows; serialize shared asset/plan/workspace writes with membership removal and recheck access under that lock. |
| Sandbox isolation | Bubblewrap and a required CI canary already existed; a weak-isolation escape hatch was configurable. | Invited/open/non-operator accounts and installations with multiple accounts cannot use the weak fallback. Shared DB leases supplement the local fast rejection. |

## Browser ownership and revocation

Private Music Lab keys and IndexedDB sample databases are prefixed with installation and principal id. Device appearance remains device-scoped. Logging out, replacing a session or learning that it was revoked aborts private requests, remounts account providers, clears query data, releases sample caches and broadcasts a content-free notice to other tabs. `/me` polling also catches cookie changes not initiated by this tab. A late response cannot populate the replacement account's query cache. Authenticated API responses use `Cache-Control: no-store`.

Old `goobster.conservatory.*` keys and the old sample database are retained, never automatically loaded into the next account. Music Lab offers recovery only to migration/bootstrap accounts, with recent authentication and an explicit ownership acknowledgement. Export preserves a portable recovery copy. Import refuses an occupied account namespace and leaves the original legacy data intact. An invited user cannot invoke that recovery endpoint.

SSE and portal voice/discussion WebSockets reauthorize each output batch and at least once per second while idle. Pending output is discarded on session expiry/deletion, account disable/version change, resource-membership loss, or authorization-store failure. A revoked subscription ends rather than broadening its scope. Previously delivered copies cannot be withdrawn. Disconnecting a browser does not erase a turn that is already running: it may still finish into its original authorized history; account disable prevents subsequent admission and aborts active leased execution.

## Shared resource admission

`resourceAdmissionService` serializes admission through a database lock row per resource. A transaction expires dead claims, considers running claims and queued accounts, and conditionally claims one slot. SQLite uses its transaction serialization; Postgres uses the row lock. Use the **same database and the same policy in every participating process**, including the sandbox runner. Independent SQLite files cannot coordinate one installation; use the supported shared-database topology, not SQLite copies on separate hosts.

Eligible accounts are ordered by their most recent admission, then queued creation time. One recursive producer cannot jump an already-waiting eligible account. There are at most 64 queued requests per resource and four per account. Waiting is cancellable and bounded. Chat/project commands display why a routed model request is waiting; code execution and excess connections currently fail promptly with an actionable busy/limit error instead of building an unbounded queue. Existing per-user web-turn claims remain unchanged.

`config.json.admission` defines policy, not measured capacity:

| Setting | Default | Meaning |
|---|---:|---|
| `modelConcurrent` | 4 | Running routed model calls across the installation |
| `modelPerAccount` | 1 | Running routed model calls for one attributed account |
| `modelQueueMs` | 30000 | Maximum wait for a model slot |
| `modelTimeoutMs` | 300000 | Model request deadline, including admission wait |
| `streamConcurrent` | 128 | Live portal connections across the installation |
| `streamPerAccount` | 12 | Live portal connections for one account |
| `streamPerSession` | 6 | Live portal connections for one session |

Code runs use `sandbox.maxConcurrent`, `sandbox.maxPerAccount` (default 1), `sandbox.runsPerWindow`, existing CPU/memory/time/output limits, and one shared lease per project directory. The dedicated runner can set those three values with `GOOBSTER_SANDBOX_MAX_CONCURRENT`, `GOOBSTER_SANDBOX_MAX_PER_ACCOUNT` and `GOOBSTER_SANDBOX_RUNS_PER_WINDOW`; the split Compose profile connects it to the same Postgres database without mounting the application config or the whole data volume. Limits are checked before spawning. Leases renew while work is active and release after work settles; a crashed worker's claim expires. Losing a lease or disabling an account signals cancellation. Short-lived finished rows support fair scheduling/rate windows, are pruned on admission, and are reachable through privacy export/audit/erasure.

Model admission covers `aiService.chat` and `generateText` and their routed callers, including foreground, research and persona work. It is **not** a token/currency budget or coverage of every paid integration (images, speech, search, embeddings). Calls without user attribution share the unattributed-account cap. Existing usage context supplies actor/owning scope; full collaborative billing policy is #248. Provider timeout/abort is not proof that a remote provider performed no work. No automatic retry is introduced by admission; uncertain paid outcomes require reconciliation before retry.

## Conflict and membership contract

Human note and asset editors send `expectedRevision`; settings use their section revision and plans use `planRevision`. A stale write returns 409 (`EDIT_CONFLICT` or `SETTINGS_CONFLICT`) with the current revision. The UI keeps the unsaved note/asset draft and offers the current saved version for comparison. A new save uses a fresh revision only after the person explicitly chooses to continue. API clients should always pass their observed revision; legacy/internal callers without a token retain their existing append/update semantics.

A project slug remains a label. Resource checks bind an immutable project id and its authorized owner. Asset saves/metadata/rollback/deletion, workspace writes/deletions and human plan changes take the same project row lock as membership removal, then recheck authority. An edit waiting behind a committed removal is rejected. Filesystem writes remain filesystem operations; the lock serializes the access/quota check, not a transactional filesystem rollback.

Invitation acceptance conditionally consumes the still-pending invitation and inserts membership in one transaction. An acceptance/revocation race cannot produce a second successful acceptance. Project-linked discussions consult project membership directly, so a delayed mirror update cannot preserve access or leak list metadata.

## Automated evidence

The new suites run without live providers or keys:

- `tests/sharedInstanceSafety.test.js`: native A/B scope and forged identity tests; notes/settings/assets/plans races; membership loss between lookup and commit; stale linked-discussion membership; buffer drops on authorization failure; SSE/WS revocation; per-session caps; account-scoped portal events; a forked worker sharing admission state; queue limits/cancellation/progress; crash expiry; disabled accounts and erasure.
- `tests/selfDocs.test.js`: private operator content excluded from public list/read, mixed lexical/vector results and embedding-failure fallback.
- Existing scope, collaboration, durable scheduler/turn claims, settings, sandbox, streaming, mission and asset suites remain regression gates on both database engines. `sharedInstanceSafety` is included exactly once in `tests/ciGroups.js`.
- `e2e/sharedInstance.spec.js`: A/B account switch with real sample blobs; unowned legacy content stays unclaimed; cross-tab logout; a held late A response after B signs in; stale note draft comparison and explicit merge.
- CI `sandbox isolation`: existing planted-secret, neighboring-project and host-network canary on a Bubblewrap runner and inside the sandbox deployment image.

## Actual-host gate — pending

No result from a developer container or CI substitutes for this gate. Before inviting a second account, record the deployed revision, host/runtime identity, database topology and policy, and run the canary **as the actual execution service user with its real mounts and namespace policy**:

```sh
node scripts/sandbox-isolation-smoke.js
```

Use the sandbox container/runner when that is where production code executes. A privileged CI pass is insufficient evidence for an unprivileged production service. Require the `bwrap blocked secret, neighbor, and host network` success result; verify invited-account execution still refuses a deliberately unavailable strong-isolation backend. Record the result on #247. Do not disable strong isolation to get a shared deployment to start.

Also confirm `webapp.devMode` is off, account admission is enforced, all execution processes use the same database and limits, and the deployment's configured bind mounts do not expose configuration, credentials or another project's storage. Host load/invitation volume is measured in #265. Spending controls remain a separate shared-release prerequisite in #248. D's status stays pending host verification until that evidence exists.
