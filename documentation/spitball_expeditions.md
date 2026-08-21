# Spitball and Spitball Expeditions

**Spitball** is the user-facing name for Goobster's knowledge system — what
Goobster and the user know, organized as a living network. Internally it is
the existing knowledge graph (`kg_nodes` / `kg_edges` / `kg_tags` /
`kg_provenance`, spec: `documentation/user_knowledge_graph.md`); the internal
schema keeps its `kg_*` names on purpose.

```text
User-facing product vocabulary: Spitball, Notes, Connections, Tags, Sources,
                                Map, Reflect, Expeditions, Cycles, Leads
Internal implementation vocabulary: knowledge graph / kg_*
```

A **Spitball Expedition** is a deliberate autonomous research process: given a
**Seed** topic, an optional **Lens** (interpretive context), and an optional
**Intent**, Goobster researches the topic, extracts evidence, generates
connected atomic notes inside the user's existing Spitball, identifies
promising frontiers (**Leads**), and recursively continues until configured
stopping conditions are reached. The result is not a report — it is a growing,
sourced, connected knowledge structure available to all of Goobster's other
capabilities (retrieval, reflection, attention).

## The pipeline

```text
Seed + Lens + Intent + existing Spitball
        ↓ build context      (what do we already know?)
        ↓ plan               (structured research plan, strict JSON)
        ↓ search             (provider-agnostic source adapters)
        ↓ Sources            (normalized, deduped, ranked; research_sources)
        ↓ Claims             (structured evidence units; research_claims)
        ↓ atomic Notes       (+ Tags + typed Connections, proposals only)
        ↓ graph legalization (knowledgeGraphLegalizer — the only write path)
        ↓ coverage + Leads   (what's still unknown? where's the frontier?)
        ↓ next Cycle         (compact recursive state, never a transcript)
```

## Architecture rules (non-negotiable)

- **Models propose; deterministic code legalizes.** Research output is
  mutation proposals through `knowledgeGraphService.applyMutations` (the
  existing legalizer: caps, exact/semantic dedupe, merge, contradiction
  preservation, scope enforcement). No model response writes graph rows.
- **One personal Spitball, many Expeditions.** Expeditions are never isolated
  graphs: a personal expedition writes into the user's personal scope
  (`guildId = dm:<userId>` from the portal, `scopeKey = USER:<userId>`), so
  knowledge from different expeditions connects when justified. Which
  expedition produced a note is provenance metadata, not a database boundary.
- **Evidence before synthesis.** Sources and Claims are first-class persisted
  rows created before note generation. A generated note carries
  `kg_provenance` rows (`sourceKind = 'expedition'` → the run,
  `sourceKind = 'research_claim'` → the claim), and a claim resolves to its
  source through the research tables — "why does this note say this?" always
  has an answer.
- **Recursion is explicit code, not prompt-implied.** Cycle N+1 receives a
  compact frontier state (`buildFrontierInput`: original seed/lens/intent,
  previous Leads, unresolved questions, coverage summary, avoid-repeating
  list) — never the previous model transcript. The deterministic continuation
  policy (`decideContinuation`) owns whether work continues; models only
  estimate novelty/coverage inside a cycle.
- **Recursive research is bounded.** Hard budgets (maxCycles/maxSources/
  maxNotes, resolved from the depth preset at creation) plus
  information-quality stops (novelty saturation over consecutive cycles,
  coverage ceiling, no new sources, no usable Leads). `stopReason` is always
  recorded: `MAX_CYCLES`, `MAX_NOTES`, `MAX_SOURCES`, `NOVELTY_SATURATED`,
  `COVERAGE_SATURATED`, `NO_NEW_SOURCES`, `NO_LEADS`, `USER_PAUSED`,
  `USER_CANCELLED`, `FAILED`.
- **Events are hints, never the source of truth.** `research.*` domain events
  carry ids and small scalars; every decision is recomputable from the rows.

## Durable state

Tables (in `db/schema.sql`, both engines via the normal dual-engine rules):

| Table | Role |
|---|---|
| `spitball_expeditions` | One row per research run: immutable inputs (seed/lensId/lensText/intent/depth), status, budgets, rollup counters, summary, stopReason, lastError, heartbeat. |
| `spitball_expedition_cycles` | One row per Cycle: durable status, plan/frontier/coverage JSON, exact legalized counters (sources, claims, notes created/merged, edges, tags, conflicts), novelty/coverage scores. |
| `research_sources` | Normalized Sources (provider, canonical URL, title/author/publisher, content hash, bounded extracted text, relevance/quality/novelty scores, accepted + rejectionReason). `UNIQUE (expeditionId, canonicalUrl)`. User-scoped rows; cascade with the expedition. |
| `research_claims` | Structured evidence units per source (text, kind, confidence, sourceLocation). Cascade with the source/expedition. |

`kg_provenance.sourceKind` gained `research_claim`, `research_source`, and
`expedition`; `kg_nodes.source` gained `research` (constraint migrations on
both engines). `knowledgeGraphConfig.LIMITS.research` caps research mutations
per cycle — and forbids deletes: research proposes and connects, it never
erases existing knowledge.

## State machine

```text
DRAFT → QUEUED → RUNNING ⇄ PAUSED (→ QUEUED on Continue)
                    ├→ COMPLETED (stopReason from the continuation policy)
                    ├→ FAILED    (lastError recorded; cycles keep their results)
                    └→ CANCELLED (terminal; running cycle marked CANCELLED)
```

- `spitballExpeditionService` owns rows, transitions, budgets, the
  continuation policy, and the frontier contract. Errors follow the
  status+code contract (`SpitballError`).
- `spitballExpeditionRunner` is the durable orchestrator (the Observatory job
  pattern): claim-before-run via an atomic status UPDATE (a duplicated kick or
  a second process can never double-run a cycle), fire-and-forget `kick()`,
  and restart safety — at startup orphaned RUNNING expeditions are parked
  `PAUSED` (research spend never silently resumes; the owner presses
  Continue), their interrupted cycle is CANCELLED, and QUEUED expeditions are
  picked back up. Interrupted work restarts as a fresh cycle rather than
  resuming a checkpoint (the MVP idempotency choice).
- `spitballResearchPipeline` is the seam for the semantic work
  (`runCycle({ expedition, cycle, frontierInput, heartbeat })` → plan,
  counters, coverage, leads). The runner treats it as a black box, which is
  also what makes the recursive loop testable with mocked pipelines.

## Lenses

`config/spitballLensConfig.js` defines first-class Lens profiles (not prompt
strings): preferred source classes, relationship vocabulary priorities, note
archetypes, and epistemic policy (citations required, claim-vs-inference
distinction, primary-source preference). Presets: general, scientific
literature, mathematics, history, engineering, journalism, fictional
storytelling, philosophy. A free-text `lensText` can extend any preset. Note
archetypes are model guidance; committed notes are still clamped to the legal
`kg_nodes` types by the legalizer.

## Budgets and configuration

`config/spitballConfig.js`: depth presets (Focused 1 cycle / 8 sources / 20
notes; Standard 3/25/60; Deep 6/60/150 — resolved onto the row at creation so
retuning never changes a run underway), input caps, continuation thresholds,
pipeline shape caps (leads per cycle, claims per source, frontier size),
per-user active/open expedition caps, and the `spitball.enabled` switch
(default on; expeditions are user-initiated and bounded). Numbers are
operator-tunable through `config.json` with hard ceilings, the Observatory
pattern.

## Domain events, watches, attention

Topics: `research.expedition_started`, `research.cycle_started`,
`research.cycle_completed`, `research.lead_discovered` (high-value leads
only), `research.conflict_found`, `research.expedition_completed`,
`research.expedition_failed`, `research.expedition_cancelled`. All are
watchable (`attentionWatchService.WATCHABLE_TOPICS`, including `research.*`),
so a watch like "when this expedition finds a contradiction, bring it to me"
works with the existing exact-field condition model. A deterministic
`research` attention generator (surfacing only genuinely high-value outcomes,
never every completion) is the planned Phase 7 integration.

## Web surface

The Library room is now **Spitball** (`apps/web/src/rooms/SpitballRoom.tsx`,
route `/spitball`; `/library` and the `#library`/`#memory` hashes redirect).
Inside: **Map** (the constellation, unchanged), **Expeditions** (list, start
form with Topic/Lens/Intent/Depth, detail view with cycles, Leads, and
Sources, plus Pause/Continue/Cancel), and the existing About you / Facts /
Memories / Server graph tabs. Routes under `/api/app/spitball/*` follow the
portal conventions (plain `requireAuth` + service-level ownership checks;
`chatRoute` translates the status+code contract):

```text
GET    /api/app/spitball/lenses
GET    /api/app/spitball/expeditions
POST   /api/app/spitball/expeditions
GET    /api/app/spitball/expeditions/:id           (detail: cycles+sources+leads)
GET    /api/app/spitball/expeditions/:id/cycles
GET    /api/app/spitball/expeditions/:id/sources
POST   /api/app/spitball/expeditions/:id/pause
POST   /api/app/spitball/expeditions/:id/continue
POST   /api/app/spitball/expeditions/:id/cancel
```

The `spitball` feature flag rides `GET /api/app/me` like `observatory`.

## Privacy

Research state is user data. `/forget-me` deletes the user's expeditions
(cycles, sources, and claims cascade) inside the main erasure transaction;
`auditUser` counts all four tables; the transparency report includes
expedition/source counts. Research-generated `kg_*` knowledge is already
covered by the existing personal-graph deletion.

## Relationship to neighbors

```text
Expedition asks: "What should I go learn from external/internal sources?"
Reflection asks: "Given what I already know, how should I reorganize it?"
Observatory:     computation and experiments, not research.
Attention:       decides whether a research outcome is worth interrupting for.
```

A useful cycle boundary sequence is research ingest → weave → tidy (batched,
never per-write). Expeditions and the Observatory can feed each other
(disputed quantitative claim → simulation; surprising result → literature
research) but neither owns the other.

## Implementation status

- **Done (Phase 1–2 + skeleton of 3):** vocabulary/UI rename, all four
  tables + provenance constraint migrations on both engines, Lens profiles,
  expedition service + state machine + continuation policy + frontier
  contract, durable runner with restart safety, `research.*` events +
  watchable topics, portal API + Expeditions UI, privacy coverage, legalizer
  support for research source/provenance (`source: 'research'`,
  `provenance: { sourceKind: 'expedition' }`, per-note `claimIds`), and the
  regression suite (`tests/spitballExpeditionService.test.js`, both engines).
- **`spitballResearchPipeline` is currently the Phase 2 placeholder**: it
  performs no research and reports zero accepted sources, which the
  continuation policy turns into a clean `NO_NEW_SOURCES` stop after one
  cycle.
- **Next (Phase 3–5):** the single-cycle research MVP behind the pipeline
  seam — existing-knowledge context, plan generation, search via the existing
  provider abstractions (provider-native web search / Perplexity / Wikipedia
  adapter), source normalization + ranking, claim extraction, atomic
  note/tag/edge proposals through the legalizer, coverage + Lead extraction —
  then recursive Leads, then reflection/attention integration (Phases 6–7)
  and note revision history (Phase 8).
