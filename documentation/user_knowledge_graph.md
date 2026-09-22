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

Tags cluster nodes without hand-maintaining every edge. Notes sharing a tag are implicitly related; explicit edges capture stronger claims. On the Map, those tags become visual hubs (stronger springs, diamond nodes, cluster hulls) and a parent/child grouping is derived from co-occurrence so a large graph clumps instead of tangling — the hierarchy is view-time, never written to `kg_tags`.

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
| `findImages` / `fetchWebFile` tools | Files Goobster finds on the web for the user (pictures of a thing, a CSV/JSON/Markdown/PDF at a URL); saved automatically with the model's notes, origin in `kg_artifacts.metadataJson` (source URL, credit, license, provider) |
| `showSavedFiles` tool | Re-displays saved files in the chat (images with captions, CSV as a table, text previews) |
| `lookupNotes` | Recalls artifact summaries and extracted text when the user refers back |

Incoming attachments are listed in the prompt as `ATTACHMENTS THIS TURN` with indices for `saveArtifact(attachmentIndex=…)`. Text/PDF content is extracted for search (`extractedText`); uploaded images keep the summary only, while found images store their title, description, notes, and attribution as the searchable text so "that jacket photo" resolves by words. Identical bytes already in the scope (content hash) are re-shown rather than saved twice.

### How `lookupNotes` finds an artifact

Artifact retrieval is **lexical** (`kgArtifactService.searchArtifacts` + `utils/lookupRelevance.js`): it needs no embedding backend, no consolidation or reflection pass, and sees a file the moment `saveArtifact` / `fetchWebFile` / `findImages` returns. Searchable fields, as available:

| Field | Source |
|-------|--------|
| Label | `kg_nodes.label` |
| Notes / summary | `kg_nodes.content` |
| Original file name | `kg_artifacts.originalName` |
| Extracted text | `kg_artifacts.extractedText` (text, code, Markdown, PDF; for found images the title + description + notes + attribution) |
| Origin metadata | `kg_artifacts.metadataJson` — `title`, `description`, `credit`, `license`, `provider` only (URLs, paths, and timestamps are never matched or shown) |

Ranking is relevance first, salience second: exact normalized label or file name → strong label/file-name match → the whole query phrase (or every term) in the text → partial term coverage; salience, confidence, and recency only order otherwise-equal hits. Ordinary graph nodes are ranked the same way (`knowledgeGraphService.searchNodes`), so an unrelated 0.99-salience concept sharing one word no longer outranks the file the user named.

`retrieveNotes` merges artifacts into the pack as their own `ARTIFACTS (saved files)` block with a separate character budget (a long graph slice cannot truncate it; it leads the pack on a phrase-or-better match). Each line is bounded: `[saved artifact/<kind>] "label" (kind, file name, id)`, the notes, an excerpt of the extracted text centred on the matching terms (never the whole document), and the `showSavedFiles(query="label")` call that re-displays it. `lookupNotes` runs that one pass with the top-nodes fallback disabled, so a query that matches nothing says so.

Scope is the same as `showSavedFiles` and the graph: artifacts live only under the author's `USER:<id>` scope in the guild or `dm:<userId>` where they were saved, `about="server"` searches the (artifact-free) guild scope, another user's lookup never sees them, and deleting the node (`/forget-me`, orphan pruning, `deleteNode`) cascades to `kg_artifacts` so a deleted file cannot be recalled. No reindexing is needed for existing rows - lookup reads the stored label, content, `extractedText`, and metadata directly.

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
3. **`lookupNotes` tool** — if the first slice missed a personal or server detail, the agent fetches more instead of guessing. Saved **artifacts** (code, docs, PDFs, found images) are searched in the same ranked pass and return bounded, match-centred excerpts (see *How `lookupNotes` finds an artifact*). `about=me` is the speaker; `about=server` is shared guild graph (never another user’s private dossier).
4. **`saveArtifact` tool** — when the user shares a file worth keeping, save it into the graph (ask first if unsure; `confirm=true` to write).
5. Inner life / mood / screen / prior tools only on medium/rich turns.

The legacy flat facts dossier and the always-on memory block are gone from the default prompt.

## Curation: saved knowledge versus distilled memory

`kg_nodes.curation` (`saved` / `memory` / `unclassified`, default
`unclassified`) records whether the *person* decided to keep a node. It is
independent of `source` (who wrote it) and of provenance (where it came
from), and no code path rewrites `source` when curation changes.
`upsertNode` takes `curation`; when a writer passes none,
`DEFAULT_CURATION_BY_SOURCE` in `config/knowledgeGraphConfig.js` derives it
(`user`, `research` → `saved`; `consolidation`, `conversation` → `memory`;
`tool`, `monologue`, `migration` → `unclassified`). `syncFactNode` always
writes `memory`, `saveArtifact` always `saved`; `createUserNote` and a
human edit set `saved`; `setUserNoteCuration` is the explicit
reclassification (the portal's **Keep**). Merges keep `saved` if either
side had it. `listUserNotes` and `getPersonalGraphView` share one
projection (`view = knowledge | memory | all`, `curationPredicate`), and a
conservative once-per-process backfill (`inventoryCuration` then
`backfillCuration`) classifies only evidenced legacy rows. Retrieval
(`lookupNotes`, `searchNodes`, the prompt pack) ignores curation. Contract
and UI: [knowledge_and_memory.md](knowledge_and_memory.md), decision:
[ADR 0008](adr/0008-knowledge-curation-contract.md).

## Web portal (Knowledge, and Settings → Memory & privacy)

- **Knowledge → Map** (`GET /api/app/memory/constellation?scope&view`) renders the **real** user-scoped graph under the chosen curation projection: `kg_nodes` + `kg_edges` + tags, up to the storage cap (2500 personal). A `person` anchor node represents the user. Search plus multi-select type/tag/source slicers hide nodes client-side so a dense graph stays navigable; a hit list pans to the chosen note. **Group by tag** (on by default, remembered in `localStorage`) overlays tag hubs. A small map keeps every tag as a diamond; a dense map parks each note in one primary group (`utils/graphClusters.js`), keeps smaller satellite groups, and interconnects hubs with parent/child and shared-tag overlap edges — never a second spring that drags notes into the middle. Cluster hulls, a soft third axis, label collision, and zoom LOD keep titles readable. The overlay is view-time only — never written to `kg_nodes` or `kg_edges`. The legend carries the scope-wide `curation` breakdown and how many rows the projection left out.
- **Knowledge → Notes** (the landing view) — browse, search, filter, create, edit, delete and **Keep** personal notes under the same projection as the Map. Manual edits set `source = 'user'`, `curation = 'saved'` and record a `human_edit` revision so research will not casually overwrite the preferred text. Routes: `GET/POST /api/app/spitball/notes` (`view`, `curation` filters), `PATCH/DELETE /api/app/spitball/notes/:nodeId` (a PATCH with only `curation` reclassifies; a DELETE also removes a mirrored `facts` row).
- **Reflect button** (Map, and the server graph mode) — starts a reflection run for the visible scope and polls it to completion (see Reflection above).
- **Server's shared graph** (Knowledge → Map, Manage Server, explicitly labelled) — guild-wide monologue graph (up to 1000 nodes) with the same search/filter chrome.
- **Facts / Memories** — in **Settings → Memory & privacy** (*What Goobster knows about you*), for the private scope and, under *Inspect a server scope*, for one server at a time. Facts are read through the `type = 'fact'` mirror; forgetting one removes the mirror (`deleteMirroredFact`).

## Privacy

`/forget-me` deletes user-scoped graph rows (`scopeKey = USER:<userId>` or entire `dm:<userId>` scope), provenance, tags, and legacy facts. Guild-wide nodes mentioning the user are review-pass scanned (label + content + tags).

## Implementation phases

| Phase | Deliverable |
|-------|-------------|
| 1 | Schema + legalizer + consolidation → graph; facts dual-write; constellation uses real edges |
| 2 | Graph-first chat retrieval; semantic dedupe in legalizer |
| 3 | Web UI filters, tag legend, node detail with provenance |
| 4 | Facts table read-through from KG; distilled memory retirement |
