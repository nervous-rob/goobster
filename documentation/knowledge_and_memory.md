---
title: "Knowledge and Memory: saved notes versus what Goobster knows about you"
kind: reference
summary: How the portal separates the knowledge a person keeps on purpose (Knowledge → Notes, Map, Research) from the personal memory Goobster distils (Settings → Memory & privacy - About you, Facts, Memories). The saved-knowledge curation contract (kg_nodes.curation - saved / memory / unclassified), the one server-side projection Notes and Map share, the All retained knowledge inspection path, the Keep action, the conservative backfill, the explicitly scoped server inspector, and the deletion rules for memories, facts, notes and transcripts. Shipped behaviour (shared-instance Increment E, package E2).
tags: [portal, knowledge, memory, spitball, notes, curation, privacy, deletion, web, shared-instance]
---

# Knowledge and Memory

Two different things used to live in one room. **Knowledge** is what a
person chose to keep: notes they wrote, research they launched, files they
asked to save. **Personal memory** is what Goobster inferred about them:
raw memories from conversation, the facts he distilled from those, and the
notes his consolidation passes wrote. Both are stored as personal graph
nodes (`kg_nodes`, scope `USER:<id>`), but they answer different questions
and are managed in different places.

| Question | Where | What you see |
|---|---|---|
| What have I kept? | **Knowledge** (`/knowledge`, Spitball) - opens on **Notes**; **Map** and **Research** are its other views | Notes you wrote, research output, saved files, plus legacy rows nothing has sorted yet |
| What does Goobster know about me? | **Settings → Memory & privacy** → *What Goobster knows about you* | About you (the transparency report), Facts, Memories, one-by-one deletion, retention, Forget me |
| What does he know about me *in a server*? | Settings → Memory & privacy → *Inspect a server scope* (advanced) | The same three views for the server you pick, always labelled with its name |
| What does a server keep for itself? | Knowledge → Map → *<Server>'s shared graph* (advanced, Manage Server) | The guild graph, private thoughts and scratch pad |

Chat, Knowledge and Home each carry a **Personal memory** shortcut to the
Settings section; the section's "Open Knowledge →" goes back the other way.
Decision record: [ADR 0008](adr/0008-knowledge-curation-contract.md).

## The Knowledge room

Registered in `apps/web/src/lib/rooms.cjs` as the `knowledge` room with
three `views` (see [portal_navigation.md](portal_navigation.md)):

| View | Path | What it is |
|---|---|---|
| **Notes** (landing) | `/knowledge/notes` | The list: search, type / tag / source filters, sort, New note, edit, delete, **Keep**. `/knowledge`, `/spitball` and `/library` land here. |
| **Map** | `/knowledge/map` | The same notes drawn as a graph: typed **Connections** (`kg_edges`) are edges, shared **Tags** are hubs (Group by tag). Two relationships, kept distinct - no new untyped link model. Node detail shows provenance and the research evidence trail (Note → Claim → Source). |
| **Research** (Expeditions) | `/knowledge/research` | Autonomous research runs ([spitball_expeditions.md](spitball_expeditions.md)). Hidden when the `spitball` feature is off. Notes it produces appear in Notes and on the Map as *kept*. |

The scope select (your private space, or a server you share with Goobster)
is in the room header and applies to every view. Older bookmarks keep
working: `/spitball/map` → `/knowledge/map`, the `#expeditions` hash →
Research.

## The curation contract

`kg_nodes.curation` says whether the person decided to keep a row. It is
**independent of `source`**, which records who wrote it (`user`, `research`,
`consolidation`, `conversation`, `tool`, …) and is never rewritten by
curation changes.

| `curation` | Badge | Meaning | Set by |
|---|---|---|---|
| `saved` | *(none in Notes; "kept" under All retained knowledge)* | The person chose to keep this. | Notes editor (create / edit), **Keep**, research the person launched (`source = 'research'`), files saved on request (`saveArtifact`). |
| `memory` | **memory** | Goobster distilled it from conversation. Managed from Personal memory. | Consolidation and the reflection *distill* pass, the fact mirror (`syncFactNode`), Parlor write-back. |
| `unclassified` | **unsorted** | Intent unknown - legacy rows and writers that do not declare intent (`tool`, `monologue`, `migration`). | The default. |

Rules that follow from it:

- **Writers declare intent at creation.** `knowledgeGraphService.upsertNode`
  takes `curation`; without it, `DEFAULT_CURATION_BY_SOURCE`
  (`config/knowledgeGraphConfig.js`) derives one from `source`. Writers with
  a sharper signal override it (`syncFactNode` → `memory`, `saveArtifact` →
  `saved`).
- **Updates never reclassify silently.** Structural touches (link
  endpoints, weave, tags) and automated content writes leave `curation`
  alone. A human edit sets `saved`; **Keep** sets `saved`; a reflection
  merge keeps `saved` if either side was saved.
- **Retrieval is not filtered by curation.** What Goobster may recall in
  chat is governed by the memory read preference and scope access, not by
  how a note is shelved.

### One projection for Notes, Map and counts

`listUserNotes` and `getPersonalGraphView` take the same `view` argument and
apply the same SQL predicate (`curationPredicate(view)`), so the Notes
list, the Map, the facet counts and the future note → project picker (E4)
can never disagree. The browser has no filter of its own for this boundary.

| `view` | Rows | In the UI |
|---|---|---|
| `knowledge` (default) | `saved` + `unclassified` | **Your notes** - Notes and Map open here |
| `all` | every row in the scope (accepts a `curation` filter) | **All retained knowledge** - the inspection path; kept, memory and unsorted rows side by side with badges and a curation chip row |
| `memory` | `memory` only | Personal memory's counts |

Every payload carries the scope-wide breakdown (`curation: { saved, memory,
unclassified }`) and the Map adds `hidden`, so the default view can say
"2 distilled notes … are not shown here" instead of hiding them silently.

API: `GET /api/app/spitball/notes?scope=…&view=knowledge|all|memory[&curation=…]`,
`GET /api/app/memory/constellation?scope=…&view=…`,
`PATCH /api/app/spitball/notes/:nodeId` with `{ scope, curation }` (and no
content fields) reclassifies explicitly - `saved` is the portal's **Keep**
button, `memory` is accepted for tools and a future *Treat as memory*
action. It changes `curation` only: no source rebrand, no revision, no
content touch.

### Legacy rows and the backfill

Existing databases receive the column with `DEFAULT 'unclassified'`. On the
first projection read of a personal scope (once per process),
`inventoryCuration` is logged and `backfillCuration` updates **only**
`unclassified` rows with decisive evidence: `fact` / `consolidation` /
`memory` / `parlor_conversation` provenance or `source = 'consolidation'` →
`memory`; a `human_edit` revision, `source = 'user'`, `expedition` /
`research_claim` provenance, `source = 'research'` or an artifact row →
`saved`. `tool` and `conversation` rows without provenance stay
`unclassified` and **remain listed** in Notes with the *unsorted* badge and
a **Keep** button. Nothing is deleted, rescoped or relabelled for
navigation reasons.

## Personal memory (Settings → Memory & privacy)

*What Goobster knows about you* embeds the `PersonalMemoryPanel`
(`apps/web/src/components/memory/PersonalMemoryPanel.tsx`) for the private
scope `dm:<userId>`:

- **About you** - the transparency report (`GET /api/app/memory/report`),
  the same data as `/what-do-you-know-about-me`: facts, memories with their
  date range, distilled notes (with the kept / unsorted split from
  `knowledgeGraph.saved` / `.distilled` / `.unclassified`), chat counts,
  follow-ups, applets, AI calls, wallet, nickname, and **Forget me**.
- **Facts** - distilled facts with *Forget this fact*.
- **Memories** - raw memories with *Delete this memory*.

The section keeps its existing controls around it: retention windows for
memories and chat history, learn / recall toggles, export, shares, applet
grants and Forget me ([user_settings.md](user_settings.md)).

**Inspect a server scope** (advanced) appears only when the person shares a
server with Goobster. Picking one renders the same three views for that
server, headed "What Goobster knows about you in *Server*". Guild scope is
never folded into the private-space report, and the guild's own graph
stays in Knowledge → Map behind an explicit *shared graph* switch.

## Deletion: four representations, four controls

Memories, facts, notes and transcripts are separate copies linked by
provenance. Each control deletes its own kind and the UI says what stays;
nothing but Forget me claims to erase every copy.

| Action | Removes | Leaves |
|---|---|---|
| **Delete a memory** (Memories) | The `memory_embeddings` row and its vector (`memoryService.cleanupVecIndex`). | Notes distilled from it (their `kg_provenance` row now points at a source that is gone). |
| **Forget a fact** (Facts) | The `facts` row and its mirrored `type = 'fact'` node (`deleteMirroredFact`). | The memories it was distilled from. |
| **Delete a note** (Knowledge) | The node and everything that cascades: connections, tags, provenance, revisions, its embedding, its artifact file. If it mirrored a fact, that `facts` row too, so the fact does not resurface on the next sync. | Raw memories and chat transcripts it came from. |
| **Chat-history retention** | Study transcripts (and their attachments and shares). | Memories and notes. |
| **Forget me** / `/forget-me` | Every row: the `USER:` scope, the whole `dm:<userId>` guild, facts, memories, chats, settings, sessions. | Nothing. |

`privacyService` needs no new erasure path: curation is a column on an
existing per-user table, and the transparency report gains the
`saved` / `distilled` / `unclassified` breakdown.

## Tests

- `tests/knowledgeCuration.test.js` - writers declare intent, updates do
  not reclassify, Notes and Map agree under every view, conservative
  backfill leaves ambiguous rows alone, deletion semantics, the PATCH
  curation route, the report breakdown.
- `tests/portalRooms.test.js` - the Knowledge views in the registry, path
  resolution, display names, the `#expeditions` hash.
- `e2e/knowledge.spec.js` - Knowledge opens on Notes; the view strip; the
  bare path and aliases redirect with query and hash intact; distilled rows
  are out of the default projection and counted, legacy rows are listed
  with the *unsorted* badge; Notes and Map counts agree; **Keep** moves a
  row without changing its source; deleting a note leaves the raw memory;
  Personal memory reachable from Chat and Knowledge; forgetting a fact
  removes its Map copy and leaves memories.
