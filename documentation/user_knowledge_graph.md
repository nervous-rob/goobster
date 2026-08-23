# User Knowledge Graph

Goobster stores conversational memory at three layers. This document specifies how those layers consolidate into one **user knowledge graph** — nodes (distilled notes), typed edges (semantic relationships), tags (concept clusters), and provenance (traceability back to raw memories and legacy facts).

## Layers (before consolidation)

| Layer | Table | Role |
|-------|-------|------|
| Raw memory | `memory_embeddings` | Message snippets + vectors for similarity recall |
| Distilled fact | `facts` | Short declarative statements (compatibility mirror; canonical data lives in `kg_nodes`) |
| Knowledge graph | `kg_nodes`, `kg_edges`, `kg_tags`, `kg_node_tags`, `kg_provenance` | Connected semantic network |

## Scope model

Everything is keyed on a **conversation scope** (`guildId` column — the same rule as facts and memory):

- **Guild channel**: real Discord guild snowflake.
- **DM / web chat**: synthetic `dm:<userId>` from `utils/dmScope.js`.

Within a scope, nodes are partitioned by **`scopeKey`**:

| scopeKey | Meaning | Example |
|----------|---------|---------|
| `''` (empty) | Guild-wide inner life (internal monologue) | Server culture nodes |
| `USER:<userId>` | Personal graph for one member | Preferences, projects |
| `PARLOR:<personaId>` | One Parlor persona workspace (same tables, conversation workflow) | Persona notes |
| `GUILD` | Explicit server-wide distilled notes | Server conventions |

**Unique identity**: `(guildId, scopeKey, label)` — labels are case-insensitive.

Monologue continues writing guild-wide nodes (`scopeKey = ''`). Consolidation and `rememberFact` write user-scoped nodes (`scopeKey = USER:<userId>`) or `GUILD` for server facts.

## Node schema (`kg_nodes`)

| Column | Type | Notes |
|--------|------|-------|
| `guildId` | TEXT | Conversation scope |
| `scopeKey` | TEXT | `''`, `GUILD`, or `USER:<id>` |
| `label` | TEXT | Short unique title (≤120 chars) |
| `type` | TEXT | `concept`, `fact`, `opinion`, `experience`, `person`, `place`, `event`, `thing`, **`artifact`** |
| `content` | TEXT | Optional detail (≤1000 chars) |
| `salience` | REAL 0–1 | Centrality; used for pruning |
| `confidence` | REAL 0–1 | Extraction quality; low-confidence nodes prune first |
| `source` | TEXT | `monologue`, `consolidation`, `tool`, `migration`, `user`, `research`, `conversation` |

## Edge schema (`kg_edges`)

| Column | Type | Notes |
|--------|------|-------|
| `relation` | TEXT | Free-text verb phrase (≤60 chars), e.g. `caused_by`, `part_of` |
| `relationKind` | TEXT | Optional classifier: `causal`, `logical`, `associative`, `temporal`, `social` |
| `weight` | REAL 0–1 | Strength |

Self-loops are rejected. Duplicate `(source, target, relation)` upserts weight.

### Relation kinds (recommended)

- **causal**: `caused_by`, `leads_to`, `because_of`
- **logical**: `implies`, `contradicts`, `depends_on`
- **associative**: `relates_to`, `example_of`, `similar_to`, `knows`, `remembers`
- **temporal**: `before`, `after`, `during`
- **social**: `member_of`, `works_with`, `knows`

## Tags

Tags cluster nodes without hand-maintaining every edge. Notes sharing a tag are implicitly related; explicit edges capture stronger claims.

- `kg_tags`: `(guildId, scopeKey, name)` unique, normalized lowercase.
- `kg_node_tags`: many-to-many, cascade on delete.
- Max **8 tags per node**, **80 tags per scope**, names ≤40 chars.

## Provenance (`kg_provenance`)

Links distilled nodes back to sources for transparency and deletion cascades.

| `sourceKind` | `sourceId` |
|--------------|------------|
| `memory` | `memory_embeddings.id` |
| `fact` | `facts.id` |
| `consolidation` | null |
| `monologue` | null |
| `tool` | null |
| `user` | null |
| `artifact` | `kg_artifacts.id` |

When a memory row is deleted, provenance rows cascade; if a node loses all provenance and `confidence < 0.35`, it is eligible for orphan pruning.

## Artifacts (saved files)

Files the user shares — code, markdown, PDFs, configs, images — can be stored as **`artifact` nodes** with on-disk payloads and searchable excerpts.

| Piece | Role |
|-------|------|
| `kg_nodes` (`type = artifact`) | Short label + contextual summary (what it is, why it matters) |
| `kg_artifacts` | File metadata + `relativePath` under `data/kg-artifacts/<guildId>/<userId>/` |
| `saveArtifact` tool | Model saves when clearly requested or after asking; requires `confirm=true` |
| `lookupNotes` | Recalls artifact summaries and extracted text when the user refers back |

Incoming attachments are listed in the prompt as `ATTACHMENTS THIS TURN` with indices for `saveArtifact(attachmentIndex=…)`. Text/PDF content is extracted for search (`extractedText`); images keep the summary only.

Privacy: `/forget-me` deletes the user's artifact rows (cascade with nodes) and removes their files from disk.

## Storage caps (per scopeKey within a guildId)

| Resource | Cap | Prune order |
|----------|-----|-------------|
| Nodes | 2500 (user), 1000 (guild-wide) | Lowest `salience × confidence`, then oldest `updatedAt` |
| Edges | 8000 | Lowest `weight`, then oldest |
| Tags | 200 | Least recently linked |

Constants live in `config/knowledgeGraphConfig.js`.

## Consolidation pipeline ("sleep cycle")

`memoryConsolidationService` runs daily per scope with fresh memories:

1. **Gather** — recent memories (24h), existing graph excerpt, legacy facts list.
2. **Extract** — LLM returns JSON mutations (see below).
3. **Legalize** — `knowledgeGraphLegalizer.applyMutations()` enforces caps, dedupe, validation. The model proposes; code decides.
4. **Sync facts** — each new/updated fact node mirrors to `facts` for backward compatibility (Phase 4 retires this mirror).
5. **Mark distilled** — memories referenced in provenance get `memory_embeddings.distilledAt`.
6. **Purge** — optional retirement of distilled memories older than 7 days (configurable); retention days still apply to undistilled rows.

### Extraction JSON shape

```json
{
  "mutations": {
    "upsert": [{ "type": "fact", "label": "...", "content": "...", "salience": 0.7, "confidence": 0.8, "tags": ["work"] }],
    "link": [{ "source": "...", "target": "...", "relation": "part_of", "relationKind": "associative", "weight": 0.8 }],
    "tag": [{ "label": "...", "tags": ["existing-tag"] }],
    "merge": [{ "keep": "label-a", "drop": "label-b" }],
    "delete": ["stale-label"],
    "contradict": [{ "source": "...", "target": "..." }]
  },
  "facts": [{ "fact": "...", "about": "user", "userName": "..." }]
}
```

Legacy `facts`-only arrays are still accepted for one release.

## Reflection (on-demand + scheduled enrichment)

`knowledgeReflectionService` generalizes consolidation into a **pass framework**: a run executes an ordered list of registered passes against one graph scope, every pass proposes mutations, and the legalizer decides. Runs are recorded in `kg_reflection_runs` (status, passes, per-pass summary JSON) so the web app can poll progress across processes and restarts; stale `running` rows are failed lazily.

| Pass | Model call | What it does |
|------|-----------|--------------|
| `distill` | yes | On-demand sleep cycle: reviews **all undistilled** memories for the scope (not just 24h), presents each with its id so the model cites `memoryIds` provenance per upsert, marks reviewed rows distilled |
| `weave` | yes | Reviews existing nodes (least connected first, legacy facts synced in first) and proposes typed edges, tags, merges, contradictions **between them** — labels outside the reviewed inventory are dropped before the legalizer so weave can never invent nodes |
| `tidy` | no | Deterministic cap + orphan pruning (`pruneScope`) |

New routines register via `registerPass(name, { description, run })` and are immediately runnable manually or on the schedule.

**Ways in:**

- **Manual** — the Library **Reflect button** (`POST /api/app/memory/reflection`, poll with GET). `target=personal` runs `distill + weave + tidy` on the caller's `USER:<id>` scope (guild personal reflections only read the user's own memories, the same boundary as browsing); `target=guild` runs `weave + tidy` on the guild-wide `''` scope and requires Manage Server. One live run per scope (`REFLECTION_BUSY` otherwise).
- **Scheduled** — `start()` in the bot process ticks every 12h under `withSingletonLock('knowledge_reflection')` and weaves **under-connected scopes** (≥10 nodes, edges < nodes × 0.6, no run in the last 72h), capped per tick. Scheduled runs skip `distill` — nightly consolidation owns fresh memories.

Caps live in `config/knowledgeGraphConfig.js` (`LIMITS.reflection`, `REFLECTION`).

## Semantic dedupe rules (legalizer)

1. **Exact label** — upsert updates in place (case-insensitive).
2. **Exact content** — same scope + identical trimmed `content` → merge into existing node.
3. **Embedding similarity** — when an embedding backend is available, cosine ≥ `0.88` on `label + content` → merge; salience becomes `max(a,b)`, confidence becomes weighted average.
4. **Contradictions** — `contradict` mutations create `contradicts` edges (`relationKind = logical`); both nodes kept but lower salience on the older one.

## Chat retrieval (ranked pack + lookup)

Order is owned by `utils/chat/promptContext.js` (text, web, automations, and voice):

1. **Stable identity** — clock, where, names, a short “talk like a person” contract. No guild census.
2. **Depth-aware retrieval** — `light` (greetings): nothing retrieved, no embedding call. `medium`: keyword graph hits only. `rich` (remember / last time / long turns): graph + undistilled memories.
3. **`lookupNotes` tool** — if the first slice missed a personal or server detail, the agent fetches more instead of guessing. Saved **artifacts** (code, docs, PDFs) return summaries and extracted text here too. `about=me` is the speaker; `about=server` is shared guild graph (never another user’s private dossier).
4. **`saveArtifact` tool** — when the user shares a file worth keeping, save it into the graph (ask first if unsure; `confirm=true` to write).
5. Inner life / mood / screen / prior tools only on medium/rich turns.

The legacy flat facts dossier and the always-on memory block are gone from the default prompt.

## Web portal (Library)

- **Map tab** (`GET /api/app/memory/constellation`) renders the **real** user-scoped graph: `kg_nodes` + `kg_edges` + tags, up to the storage cap (2500 personal). A `person` anchor node represents the user. Search, type, tag, and source filters hide nodes client-side so a dense graph stays navigable; a hit list pans to the chosen note. **Link by tag** (off by default, remembered in `localStorage`) overlays each tag as a `type: 'tag'` hub node with standard `tagged` edges from the notes that carry it — the Parlor tag-first shape — without writing `kg_nodes` or `kg_edges`.
- **Notes tab** — browse, search, filter, create, edit, and delete personal notes. Manual edits set `source = 'user'` and record a `human_edit` revision so research will not casually overwrite the preferred text. Routes: `GET/POST /api/app/spitball/notes`, `PATCH/DELETE /api/app/spitball/notes/:nodeId`.
- **Reflect button** (Map + Server graph tabs) — starts a reflection run for the visible scope and polls it to completion (see Reflection above).
- **Graph tab** (Manage Server) — guild-wide monologue graph (up to 1000 nodes) with the same search/filter chrome.
- **Facts / Memories tabs** — filter views over provenance (`sourceKind = fact|memory`) with links to graph nodes.

## Privacy

`/forget-me` deletes user-scoped graph rows (`scopeKey = USER:<userId>` or entire `dm:<userId>` scope), provenance, tags, and legacy facts. Guild-wide nodes mentioning the user are review-pass scanned (label + content + tags).

## Implementation phases

| Phase | Deliverable |
|-------|-------------|
| 1 | Schema + legalizer + consolidation → graph; facts dual-write; constellation uses real edges |
| 2 | Graph-first chat retrieval; semantic dedupe in legalizer |
| 3 | Web UI filters, tag legend, node detail with provenance |
| 4 | Facts table read-through from KG; distilled memory retirement |
