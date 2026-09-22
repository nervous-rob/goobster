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
| **Notes** (landing) | `/knowledge/notes` | The list: search, type / tag / source filters, sort, New note, edit, delete, **Keep**, and on each note you kept **Add to project…** / **Use in discussion…** ([below](#moving-a-note-into-shared-work)). `/knowledge`, `/spitball` and `/library` land here. |
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
list, the Map, the facet counts and the note → project picker can never
disagree. The browser has no filter of its own for this boundary: the
transfer actions are drawn on the rows the `knowledge` projection returns,
and the server refuses a `memory` row (`NOT_KNOWLEDGE`) even when asked
directly.

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

## Moving a note into shared work

The first journey in the product spec is *ask → save the answer as a note →
add it to a project → run → inspect the output*. Each hop is a button on
the thing you already selected; none of them routes through a model. The
contract is [ADR 0010](adr/0010-explicit-transfers.md); the project side is
in [projects.md](projects.md#moving-knowledge-into-a-project).

**Save as note** (Chat). Every assistant answer in a saved chat has a
📝 **Save as note** action. The dialog prefills the title from the
answer's first heading or sentence and the body from the answer (capped at
the note content limit - the dialog says when it trimmed), lets you edit
both and add tags, and calls
`POST /api/app/spitball/notes/from-message { conversationId, messageId,
label?, content?, tags? }`. The note is created in your private space with
`curation = 'saved'` and `source = 'user'`, with a `knowledge_transfers`
row pointing back at the message, so it appears under **Your notes** and on
the Map through the unchanged `knowledge` projection and never under
Personal memory. Incognito chats do not offer it: nothing is persisted
there to point back to. The success state offers the next hop, **Add to
project…**, on the note just made.

**Add to project…** and **Use in discussion…** (Notes). Both open the same
dialog on a note you kept (`saved` or *unsorted*; a **memory** row has no
transfer actions and is refused server-side until you **Keep** it). The
project picker lists every project you can see, **owner-qualified** - two
owners may share a slug, so each option says *private*, *shared* or whose
it is - and the discussion picker lists the discussions you own or joined.
How the note travels depends on who reads the destination **now**:

| Mode | When | What happens |
|---|---|---|
| **Reference** | Only a private project you own (no members, no share link). | Nothing is written into the project. Its Knowledge view resolves the reference at read time, for you alone (*Referenced from your private notes*, badge *reference · only you*). If the project is shared later the reference stays yours: collaborators, share-link visitors, the graph and `recall_knowledge` never see it. Project chat excludes private references because transcripts can be consolidated into shared knowledge; publish a copy to use the note there. **Stop referencing** drops it; the note is untouched. |
| **Publish a copy** | A project with other readers, or any discussion. | The dialog shows exactly what will be shared (title, text, tags) and **names the audience** (*you and Frieda*, *… plus anyone holding the project share link*). A project copy is a new note in the project's knowledge, badged *copy · published by you / by \<name\>*; a discussion copy is a message from you in the transcript (no persona turn, no model call). A copy is a snapshot: editing the original later does not change it; republishing the same note to the same project updates that copy instead of adding a twin. |

Every transfer lands on the destination the dialog opened - **Open
project** goes to `/projects/:ownerId/:slug/knowledge`, **Open discussion**
to `/discussions/:id` - so refresh and Back behave. The transfer needs only
`features.projects` (organizing); whether the host can run code is a
separate switch, explained on the Run controls that need it.

API: `GET /api/app/spitball/notes/:nodeId/transfers` (where a note has
gone, with each destination's audience and whether you may remove that
copy), `POST /api/app/spitball/notes/:nodeId/transfers { target: 'project',
project, owner?, mode }` or `{ target: 'discussion', conversationId }`,
`DELETE /api/app/spitball/transfers/:transferId` (a reference),
`GET /api/app/projects/:slug/audience?owner=…`, and on the project side
`GET /api/app/projects/:slug/knowledge/notes` (copies with `publishedBy`,
your references, the audience) and
`DELETE /api/app/projects/:slug/knowledge/notes/:nodeId` (owner or
publisher removes a copy; the original is untouched).

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
| **Delete a note** (Knowledge) | The node and everything that cascades: connections, tags, provenance, revisions, its embedding, its artifact file. If it mirrored a fact, that `facts` row too, so the fact does not resurface on the next sync. Its **references** into private projects (a pointer to nothing). | Raw memories and chat transcripts it came from. **Published copies** in projects and messages in discussions - the dialog names each destination the note reached; a project copy you may remove has a checkbox, a transcript message stays and the dialog says so ([ADR 0010 §4](adr/0010-explicit-transfers.md)). |
| **Chat-history retention** | Study transcripts (and their attachments and shares). | Memories and notes. |
| **Forget me** / `/forget-me` | Every row: the `USER:` scope, the whole `dm:<userId>` guild, facts, memories, chats, settings, sessions. | Nothing. |

Curation itself needed no new erasure path (a column on an existing per-user
table); the transparency report gained the `saved` / `distilled` /
`unclassified` breakdown. The transfer ledger (`knowledge_transfers`) is
per-user: **Forget me** deletes every transfer you made, `auditUser` counts
them, and the report lists `knowledgeGraph.transfers` (answers saved from
chat, references, copies published to projects and discussions). Copies you
published into someone else's project are project data and stay when you
are forgotten, like `note_knowledge` rows.

## Tests

- `tests/knowledgeCuration.test.js` - writers declare intent, updates do
  not reclassify, Notes and Map agree under every view, conservative
  backfill leaves ambiguous rows alone, deletion semantics, the PATCH
  curation route, the report breakdown.
- `tests/knowledgeTransfers.test.js` - ADR 0010 with execution off: a saved
  answer lands in `knowledge` and not `memory` with provenance; a memory
  row is refused; reference only into a private owned project, invisible to
  a collaborator added later; a copy snapshots into the project scope,
  names its audience, is removable by owner or publisher and republishes in
  place; Use in discussion posts without a persona turn; deleting the
  original drops references and keeps copies; report, audit and erasure.
- `tests/portalRooms.test.js` - the Knowledge views in the registry, path
  resolution, display names, the `#expeditions` hash.
- `e2e/transfers.spec.js` - the hops clicked: Save as note from a chat
  answer, the note under Your notes and absent from the memory view; the
  owner-qualified picker with no actions on a memory row; a reference the
  owner alone sees; a published copy with the audience named first and the
  original untouched (checked as the collaborator too); refresh and Back on
  the project the transfer opened; Use in discussion; the delete dialog
  naming every scope.
- `e2e/knowledge.spec.js` - Knowledge opens on Notes; the view strip; the
  bare path and aliases redirect with query and hash intact; distilled rows
  are out of the default projection and counted, legacy rows are listed
  with the *unsorted* badge; Notes and Map counts agree; **Keep** moves a
  row without changing its source; deleting a note leaves the raw memory;
  Personal memory reachable from Chat and Knowledge; forgetting a fact
  removes its Map copy and leaves memories.
