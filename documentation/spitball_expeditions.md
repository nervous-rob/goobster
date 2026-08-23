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
- **Pause/Cancel are cooperative and prompt.** `checkpoint(id)` renews the
  run lease and asserts the expedition is still RUNNING in one statement;
  zero touched rows throws `ExpeditionInterrupted`. The pipeline calls it
  between stages, around model calls, and inside source/query loops — always
  outside its local try/catch blocks — so a Pause/Cancel stops token and
  search spend at the next boundary instead of merely relabeling the row.
  The runner closes the interrupted cycle as CANCELLED (never FAILED) and
  publishes no failure event.
- **Run ownership is a durable lease**, not process-local inference:
  `claimForRun` records `runnerId` and the heartbeat is the lease clock.
  `reapOrphans` parks only RUNNING rows whose lease has expired
  (`staleRunMinutes`); a fresh heartbeat means another process legitimately
  owns the run and is never stolen — safe for bot/api/worker topologies.
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

## Reflection at the cycle boundary

After a cycle commits at least `spitballConfig.cycleReflection.minNotesForWeave`
notes, the runner runs a **weave/tidy** reflection pass over the expedition's
scope (`knowledgeReflectionService.runScope`, `requestedBy: 'spitball'`) so
fresh research gets connected into the existing graph before the next
frontier is built — batched per cycle, never per write (spec §21). A
reflection failure costs connectivity, never the expedition. Disable with
`spitball.cycleReflectionEnabled: false`.

## Note revision history

`kg_node_revisions` keeps a bounded (20 per node) trail of node-state
snapshots, written by `knowledgeGraphService` whenever a node is created or
**materially** changed (type or content — salience/confidence drift alone is
not a new representation). `changeKind` derives from the writer: `created`,
`human_edit` (a user write — the record of the preferred representation that
research must not casually overwrite, spec §26.4), `research_expand`
(expedition writes), `reflection_merge` (mergeNodes), `update` (other
automated writers). Rows cascade with the node, so privacy rides the existing
`kg_nodes` erasure. Read with `listNodeRevisions(nodeId)`; revert UX is
deliberately later work.

## Domain events, watches, attention

Topics: `research.expedition_started`, `research.cycle_started`,
`research.cycle_completed`, `research.lead_discovered` (high-value leads
only), `research.conflict_found`, `research.expedition_completed`,
`research.expedition_failed`, `research.expedition_cancelled`. All are
watchable (`attentionWatchService.WATCHABLE_TOPICS`, including `research.*`),
so a watch like "when this expedition finds a contradiction, bring it to me"
works with the existing exact-field condition model.

The **`research_outcome` attention generator** (in `attentionService`, the
`research` category, spec §34) reads durable expedition rows within
`CANDIDATES.researchLookbackHours` and deterministically proposes candidates:
a **failure is always news** (with the recorded error), a **completion only
when it carries something genuinely valuable** — source-backed conflicts or a
Lead at/above `CANDIDATES.researchLeadFloor` — and never merely "job done".
Idempotence comes from the notice dedupe key
(`research.expedition:<id>:<status>`); the `research` boundary
(`proactiveRead`) gates the whole thing, and LLM triage remains a narrow
loudness filter, as everywhere in the attention system.

## Web surface

The Library room is now **Spitball** (`apps/web/src/rooms/SpitballRoom.tsx`,
route `/spitball`; `/library` and the `#library`/`#memory` hashes redirect).
Inside: **Map** (the constellation, search/filter, every in-cap note), **Notes** (browse/edit personal `kg_nodes`), **Expeditions** (list, a
labeled start form with Topic / Lens-plus-blurb / Depth cards / Intent, a
detail view with a live researching animation while a run is queued or
in-flight, cycles, Leads, and Sources, plus Pause/Continue/Cancel), and the
existing About you / Facts / Memories / Server graph tabs. Routes under `/api/app/spitball/*` follow the
portal conventions (plain `requireAuth` + service-level ownership checks;
`chatRoute` translates the status+code contract):

```text
GET    /api/app/spitball/lenses
GET    /api/app/spitball/expeditions
POST   /api/app/spitball/expeditions
GET    /api/app/spitball/expeditions/:id           (detail: cycles+sources+leads)
GET    /api/app/spitball/expeditions/:id/cycles
GET    /api/app/spitball/expeditions/:id/sources
GET    /api/app/spitball/expeditions/:id/claims      (?sourceId= filter)
GET    /api/app/spitball/notes                       (?scope&q&type&tag&source)
POST   /api/app/spitball/notes                       (manual create)
PATCH  /api/app/spitball/notes/:nodeId
DELETE /api/app/spitball/notes/:nodeId
GET    /api/app/spitball/notes/:nodeId/evidence      (Note -> Claim -> Source)
POST   /api/app/spitball/expeditions/:id/pause
POST   /api/app/spitball/expeditions/:id/continue
POST   /api/app/spitball/expeditions/:id/cancel
```

The evidence layer is user-visible: each accepted source in the expedition
detail expands to the claims extracted from it, and selecting a note on the
Map shows **"Why Goobster believes this"** — the note's grounding claims,
each resolved to its research source, plus the expeditions that touched it
(`getNoteEvidence`; owner-only, same 404 as a missing note).

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

## The research pipeline internals

`spitballResearchPipeline` (every dependency injectable for tests) runs one
cycle:

- **Context** (stage 1): a bounded excerpt of related existing notes
  (`describeForPrompt` on the seed), the scope's existing tag vocabulary, and
  the frontier's avoid-repeating list — never the whole graph.
- **Plan** (stage 2): one strict-JSON model call producing questions, search
  queries, expected concepts, relationship targets, and exclude terms. Later
  cycles receive the previous Leads and unresolved questions and are told to
  expand the frontier, not re-research the seed. A failed/malformed plan
  degrades to deterministic queries (the frontier Leads' suggested queries,
  else the seed through the lens).
- **Search** (stage 3): `spitballSearchService`, a provider registry where a
  broken adapter is logged and skipped. Adapters: **wikipedia** (keyless
  MediaWiki search + intro extracts — real page text, honest provenance),
  **perplexity** (optional; emits one `search_synthesis` source per query
  with the citation list in metadata and a lower quality prior, and claim
  extraction is told to treat its statements as reported, not primary), and
  **arxiv** (keyless Atom API, title + abstract, AND-joined terms). The Lens
  influences source selection, not just prompt wording: providers marked
  `onlyWhenPreferred` (arXiv) run only when the Lens's `sourcePreferences`
  include their source classes, so a storytelling expedition never spends
  budget on preprints while a scientific-literature one does.
- **Normalize/select** (stages 4–5): canonical-URL + content-hash dedupe
  (in-batch and against every earlier cycle, so retries never duplicate),
  then the inspectable score `relevance × quality × novelty` — relevance by
  embedding cosine with a keyword-overlap fallback, quality a static prior
  per source type **plus a bonus when the type is one the Lens prefers**.
  **Novelty is semantic, not just byte-level**: candidates are selected
  greedily (strongest `relevance × quality` first) and each is scored
  against the evidence already accepted — previous cycles' sources plus
  earlier picks this cycle — using embedding cosine when vectors exist from
  the relevance pass, else lexical Jaccard, each mapped through its own
  fully-novel floor (`noveltyCosineFloor` / `noveltyLexicalFloor`). A
  same-topic rewording that survives the hash dedupe is rejected as
  `redundant with accepted sources` (novelty ≤ `minSourceNovelty`) **before**
  claim extraction spends tokens on it. Every candidate is persisted with
  its scores and an accept flag or explicit `rejectionReason`, bounded by
  `maxAcceptedSourcesPerCycle` and the expedition's remaining source budget.
- **Claims** (stage 6): per accepted source, one strict-JSON extraction call
  (bounded source text) → clamped rows persisted in `research_claims`. A
  failed extraction skips the source, never the cycle.
- **Knowledge** (stages 7–11): one strict-JSON call over the id-tagged
  claims, biased by the Lens vocabulary, offered the existing tag list and
  note excerpt (reuse, don't duplicate) — clamped
  (`clampKnowledgeProposals`: foreign claimIds dropped, self-loops dropped,
  unknown types coerced) and committed via `applyMutations` with
  `source: 'research'`, `LIMITS.research`, and expedition provenance.
  Contradictions are declared, never merged away.
  **The evidence invariant is enforced, not requested**: a research note that
  cites no valid claim is dropped (and links/contradictions referencing it
  are dropped too, so it cannot sneak in as an auto-upserted stub), and every
  note's confidence is capped deterministically by
  `noteConfidenceCeiling(claims)` — the best claim confidence weighted by its
  source's quality, plus a bounded corroboration boost for *distinct*
  sources, never exceeding 0.98. The model proposes confidence; the evidence
  decides what it may claim. The generator is also
  taught **how the graph is used downstream** rather than just what shape to
  output: the prompt carries `GRAPH_USE_CASES` (chat retrieval needs
  self-contained notes, the Map makes every edge a visual assertion, shared
  tags already cluster so tag-overlap edges are noise, reflection merges
  vague duplicates away, contradictions must survive, future expeditions
  reuse general labels) plus the Lens's `example` — a tiny well-formed note
  network for that research context (e.g. the history lens shows an event,
  an actor, a primary source, and an opinion-typed interpretation wired with
  `initiated`/`primary_source_for`/`interprets`; the scientific lens shows
  two disagreeing findings kept separate under a `contradicts` edge).
- **Coverage + Leads** (stages 13–14): one combined call → clamped coverage
  (score reflects the original purpose, not note count) and ranked Leads
  (`expectedValue = relevance × novelty × uncertainty` when the model omits
  it). The model's novelty estimate is bounded deterministically: a cycle
  that committed nothing new cannot claim novelty. Fallback on failure: an
  honest shell with no Leads, which the continuation policy turns into a
  clean stop.

All stage parsers live in `utils/researchSources.js` (pure, no I/O — the
`attentionScore` separation) and are unit-tested directly.

## Implementation status

- **Done (Phases 1–7 + revision history):** vocabulary/UI rename, all
  research tables + provenance constraint migrations on both engines, Lens
  profiles with example note networks and the shared graph use-case guidance,
  expedition service + state machine + continuation policy + frontier
  contract, durable runner with restart safety, the full single-cycle
  research pipeline with recursive frontier chaining (Wikipedia / Perplexity
  / arXiv adapters, lens-driven source selection), cycle-boundary weave/tidy
  reflection, `research.*` events + watchable topics, the `research_outcome`
  attention generator, portal API + Expeditions UI, privacy coverage,
  legalizer research provenance, `kg_node_revisions` history, and the
  regression suites (`tests/spitballExpeditionService.test.js`,
  `tests/spitballResearchPipeline.test.js`, `tests/spitballAttention.test.js`
  — both engines).
- **Later:** more source adapters (Crossref / PubMed / user artifacts /
  uploaded PDFs), note-detail provenance and revision UX in the portal
  (including revert), saved Map views filtered by expedition, and guild-scope
  shared expeditions (needs explicit product design + permission checks).
