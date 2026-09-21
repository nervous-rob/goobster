# ADR 0008: Saved knowledge is a curation state, not a provenance value

## Status

Accepted (shared-instance Increment E, package E2). Behaviour is documented in
[knowledge_and_memory.md](../knowledge_and_memory.md).

## Context

The portal's Knowledge room (Spitball) and its personal-memory views read the
same storage: every node in the caller's `USER:<id>` graph (`kg_nodes`,
scoped by `guildId` + `scopeKey`). `knowledgeGraphService.listUserNotes`
and `getPersonalGraphView` return that whole scope, and only filter on
`source` when the browser asks. Four kinds of writer land there:

| Writer | `source` | What it means |
|---|---|---|
| Notes editor (`createUserNote` / `updateUserNote`) | `user` | A person wrote or edited this. |
| Spitball Expeditions (legalizer, `LIMITS.research`) | `research` | Research the person launched on purpose; evidence in `kg_provenance` (`expedition`, `research_claim`). |
| Memory consolidation and the reflection *distill* pass | `consolidation` | Goobster distilled raw `memory_embeddings` into notes (`memory` / `consolidation` provenance). |
| Fact mirror (`syncFactNode` from `rememberFact`, `/fact`, consolidation, legacy `facts` rows) | `tool` / `consolidation` / `user` | The "what Goobster knows about you" facts, mirrored as `type = 'fact'` nodes with `fact` provenance. |
| Parlor write-back | `conversation` | Persona notes distilled from a discussion (`parlor_conversation` provenance). |
| Saved files (`kgArtifactService.saveArtifact`) | `tool` | Files fetched at the person's request (`artifact` provenance, `kg_artifacts` row). |

So manual notes, research output, tool-written facts and distilled memory
share one scope, and "Notes" cannot mean *what I chose to keep* without a
second signal. `source` is the wrong signal: it records **who wrote** the
row (creation provenance), and a research write may later touch a note a
person typed, or a person may edit a distilled fact. The handoff was explicit
that source provenance alone is not a reliable statement of user intent, that
no working `curated` field exists, and that the schema is a new decision.

## Decision

1. **One new column**, `kg_nodes.curation`, with three values:

   | Value | Meaning | Who sets it |
   |---|---|---|
   | `saved` | The person chose to keep this as reusable knowledge. | Notes editor create/edit, the **Keep** action, research the person launched, files saved at their request. |
   | `memory` | Goobster distilled it from conversation; it is what he *knows about you*, managed from Personal memory. | Consolidation, the reflection distill pass, the fact mirror, Parlor write-back. |
   | `unclassified` | Intent unknown - legacy rows written before this column, and any writer that does not declare intent. | The default. Never assigned deliberately by new code paths that know better. |

   `source`, `kg_provenance` and `kg_node_revisions` are untouched and keep
   answering "where did this come from". `curation` answers "did the person
   decide to keep it". They are independent: a `saved` note can carry
   `source = 'research'`; a `memory` fact can carry `source = 'user'`.

2. **Writers declare intent at creation.** `upsertNode` takes `curation`;
   when the writer does not pass one, `DEFAULT_CURATION_BY_SOURCE` in
   `config/knowledgeGraphConfig.js` derives it from the declared `source`
   (`user`, `research` → `saved`; `consolidation`, `conversation` →
   `memory`; `tool`, `monologue`, `migration` → `unclassified`). Writers
   with a more specific intent override it: `syncFactNode` always writes
   `memory`, `saveArtifact` always writes `saved`.

3. **Updates never reclassify silently.** A structural touch (link
   endpoint upsert, weave, tag attach) or a content-bearing write from an
   automated writer leaves `curation` alone. The only moves are explicit:
   a human edit (`updateUserNote`) or **Keep** sets `saved`; **Treat as
   memory** sets `memory`; a reflection merge keeps `saved` if either side
   was saved, otherwise the kept node's value.

4. **One server-side projection.** `listUserNotes` and `getPersonalGraphView`
   take the same `view` argument and apply the same predicate from
   `curationPredicate(view)`:

   | `view` | Rows | Used by |
   |---|---|---|
   | `knowledge` (default) | `curation IN ('saved', 'unclassified')` | Knowledge → Notes, Knowledge → Map, note search counts, the future note → project picker (E4). |
   | `memory` | `curation = 'memory'` | Personal memory's distilled-notes count and link. |
   | `all` | every row in the scope | "All retained knowledge" - the inspection path for legacy material. Accepts a `curation` filter on top. |

   Facet counts (`types`, `sources`, `tags`) and `total` are computed inside
   the same predicate so the list, the map legend and the search count
   always agree. Browser-only filters are not allowed to define the
   boundary. Retrieval (`lookupNotes`, `searchNodes`, the prompt pack) is
   **not** filtered by curation: what Goobster may recall is governed by the
   memory read preference and scope access, not by how a note is shelved.

5. **Conservative backfill, inventory first.** `backfillCuration` runs once
   per process per personal scope on the first projection read
   (`inventoryCuration` is logged beforehand and returned to the client as
   `curation.inventory`). It updates **only** `unclassified` rows that carry
   decisive evidence:

   - `fact` provenance, or `consolidation` / `memory` / `parlor_conversation`
     provenance, or `source = 'consolidation'` → `memory`;
   - a `human_edit` revision or `source = 'user'`, `expedition` /
     `research_claim` provenance or `source = 'research'`, or an `artifact`
     row → `saved`.

   Everything else - notably `tool` and `conversation` rows without
   provenance, and `monologue` / `migration` rows - stays `unclassified`
   and **remains visible in Notes** with a badge and a Keep action. No row
   is deleted, rescoped or relabelled by the backfill; `source` is never
   rewritten.

6. **Deletion stays distinct per representation.** Deleting a note removes
   the node and everything that cascades from it (connections, tags,
   provenance, revisions, its embedding, its artifact file); if the node
   mirrored a `facts` row, that row goes too so the fact does not
   resurface on the next sync. It does **not** delete the raw memories it
   was distilled from, nor any transcript. Deleting a memory removes the
   `memory_embeddings` row and its vector (`cleanupVecIndex`) and leaves
   derived notes in place with a dangling provenance pointer. Deleting a
   transcript touches neither. The UI says so instead of promising that one
   deletion erases every copy.

## Consequences

- Existing databases keep every row; the column lands through
  `COLUMN_MIGRATIONS` with `DEFAULT 'unclassified'` and the backfill moves
  only evidenced rows. Distilled memory leaves the default Notes list by
  design (that is the boundary the package exists to draw) and is still one
  click away under All retained knowledge and in Personal memory.
- No new per-user store: `/forget-me` already deletes the `USER:` scope and
  the whole `dm:<userId>` guild, so erasure is unchanged. The transparency
  report gains a `saved` / `memory` / `unclassified` breakdown under
  `knowledgeGraph`.
- Project (`PROJECT:`) and Parlor (`PARLOR:`) scopes get the column too but
  no projection reads it there; their listings are unchanged.
- The E4 transfer picker must call `listUserNotes({ view: 'knowledge' })`
  rather than inventing a client-side filter.
- A future "what did I keep versus what did he infer" tutorial step has a
  stable field to anchor on.

## Alternatives considered

- **Classify by `source` alone** - rejected: research and consolidation both
  write content, and a person's edit rebrands `source` to `user`, so the
  history of who wrote it and the person's intent would keep overwriting
  each other.
- **Mark every `USER:` node `saved`** - rejected by the handoff: it would
  declare distilled memory to be deliberate knowledge.
- **Hide `tool` / `conversation` rows** - rejected by the handoff: legacy
  material must stay reachable while classifications are introduced.
- **A separate `kg_curation` table** - rejected: one nullable-style column
  with a default is enough state, cascades for free, and keeps the
  predicate a single `WHERE` clause on the existing scope index.
