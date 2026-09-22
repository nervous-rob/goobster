# ADR 0010: Explicit transfers - a saved answer becomes a note, a note enters a project by reference or as a published copy

## Status

Accepted (shared-instance Increment E, package E4). Behaviour is documented in
[knowledge_and_memory.md](../knowledge_and_memory.md#moving-a-note-into-shared-work)
and [projects.md](../projects.md#knowledge-the-project-spitball).

## Context

The product spec's first journey is *ask a question → save a useful answer
as a note → add it to a project → run a small task → inspect the output*
(spec §3). Every hop is a button on the object the person already selected
and maps to a deterministic service action; no model call routes it. At the
E3 baseline three of those hops did not exist:

1. **A chat answer could not become a note.** Notes are created in the
   editor (`createUserNote`) or by automated writers; nothing carried an
   assistant reply into the personal graph with provenance back to the
   message.
2. **A note could not enter a project or discussion.** Project knowledge
   (`PROJECT:<id>` scope) is written only by the `observatory` tool's
   `note_knowledge` action, by consolidation of the `🔭` conversation and
   by expeditions. Spec §4 requires two explicit operations - *reference in
   my private project* and *publish a copy to a shared project/discussion* -
   with the rules that a project which becomes shared later must not expose
   a private reference, and that deleting the original must not silently
   delete a published copy.
3. **Save to project was execution-gated.** `StudyRoom` offered
   `onSaveToProject` only under `me.features.observatory` (running code),
   although adding an app to a project is organization (`me.features.projects`,
   ADR 0009 §4).

ADR 0008 fixed the picker's input: the note → project picker must call
`listUserNotes({ view: 'knowledge' })` and must not filter on the client.
ADR 0009 §3 deferred "Unfiled outputs" until a typed output listing exists,
and §6 deferred replacing the `🔭 <name>` title convention.

## Decision

### 1. One ledger for every explicit transfer: `knowledge_transfers`

Each transfer is a row that names **who** moved **what** **where**, **how**,
and **to whom**:

| Column | Meaning |
|---|---|
| `userId` | The actor. Erasure and the transparency report key on it. |
| `sourceKind` | `chat_message` (an assistant reply) or `note` (a personal `kg_nodes` row). |
| `sourceConversationId`, `sourceMessageId` | For `chat_message`: the `web_conversations.id` and `messages.id` the answer came from. |
| `sourceNodeId` | For `note`: the original node. `ON DELETE SET NULL` - the row survives the original. |
| `sourceLabel` | The note title at transfer time, so a copy can still say where it came from after the original is gone. |
| `targetKind`, `targetId` | `note` (the created node), `project` (`observatory_projects.id`) or `discussion` (`parlor_conversations.id`). |
| `mode` | `reference` or `copy`. |
| `copyNodeId` | The node created in the target scope (`ON DELETE SET NULL`); for `chat_message → note` this is the note itself. |
| `requestId`, `requestSourceNodeId` | Discussion retry receipt, unique per user; source identity remains after deletion so a retry cannot post again. |
| `copyMessageId` | The `parlor_messages` row a discussion copy became. |
| `audienceJson` | Who could read the destination at transfer time: `{ kind, ownerId, memberIds, shared }`. |

`kg_provenance` is untouched. Its `sourceKind` enum describes *evidence an
automated writer attached to a node*; a person's deliberate move is a
different fact with a different shape (audience, mode, two endpoints), and
extending the enum would rebuild a `CHECK` constraint on every existing
database for no gain. The Notes UI reads a note's outbound transfers
through the ledger; the project Knowledge view reads inbound ones.

### 2. Save an answer as a note (`chat_message → note`)

`POST /api/app/spitball/notes/from-message { conversationId, messageId,
label?, content?, tags? }` verifies the message is an **assistant** reply in
a conversation the caller owns, then calls the existing `createUserNote`
(`source = 'user'`, **`curation = 'saved'`** - ADR 0008: the person chose
to keep it) in the caller's personal scope (`guildId = dm:<userId>`,
`scopeKey = USER:<userId>`), and writes the ledger row. The default title
is the reply's first heading or sentence; the person may edit title, text
and tags before saving, and the text is capped at the note content limit
(`MAX_CONTENT_LENGTH`) - the dialog says so instead of silently trimming.
The note therefore appears in Knowledge → Notes and on the Map through the
unchanged `knowledge` projection, and never under Personal memory.
**Incognito chats do not offer the action**: nothing is persisted there to
point back to, and a note with no provenance would be a new kind of row.

### 3. Reference versus publish (`note → project`, `note → discussion`)

A personal note may enter a project in one of two modes, chosen by the
audience the project has **now**, and enforced server-side:

- **Reference** (`mode = 'reference'`) is allowed only when the caller owns
  the project **and** it is private: no accepted member and no share link.
  Nothing is written to the `PROJECT:` scope. The project's Knowledge view
  resolves the reference **at read time**: the
  source node must still exist in the reader's own `USER:` scope, and the
  reader must be the actor who created the reference. Any other reader -
  a collaborator invited later, a share-link visitor, an expedition, the
  graph, `recall_knowledge` - never sees it. So promoting a project to
  shared **cannot expose** a private reference: the owner's view lists each
  reference under *Referenced from your private notes* (badge *reference ·
  only you*) with **Stop referencing** beside it and points at Knowledge →
  Notes → **Add to project… → Publish a copy** for the day others should
  read it; collaborators see nothing of it, not even a count. References are
  excluded from project-chat manifests, including while the project is private:
  chat text and replies can later be consolidated into shared project knowledge.
  Publish a copy explicitly before using a note in project chat.
- **Copy** (`mode = 'copy'`, the UI's *Publish a copy*) is the only mode
  for a project with members or a share link, and the only mode for a
  discussion. The dialog shows exactly what will be shared (title, text,
  tags) and **names the audience** (owner, members, "anyone with the share
  link"). A project copy is a new `kg_nodes` row in `PROJECT:<id>`
  (`source = 'user'`, `curation = 'saved'`, tags copied, labelled with the
  publisher). A discussion copy is a `user` message in the transcript
  posted by the caller (`parlorService.postMessage` - a plain transcript
  write, **no persona turn**, so the action spends no model call), which is
  what every member and every seated persona reads. A copy is a snapshot:
  editing the original later does not change it, and republishing the same
  note to the same project updates that copy rather than creating a twin.

Refusals are typed: `NOT_KNOWLEDGE` (400) for a `memory` row - distilled
memory is managed from Personal memory and must be **Kept** first;
`PROJECT_SHARED` (409, with the audience) when a reference is requested for
a project that is no longer private; `CONFLICT` (409) when the project
already has an unrelated note with that title; `NO_SUCH_PROJECT` /
`NO_SUCH_CONVERSATION` (404) when the caller cannot see the destination.
The picker lists projects the caller can see, **owner-qualified** (two
owners may share a slug), and discussions they own or joined; it is fed by
`listUserNotes({ view: 'knowledge' })`, never a browser filter, so personal
memory and distilled notes are not offered.

### 4. Deletion names every scope

Deleting the original note (`deleteUserNote`) removes the node and its
cascade as before, deletes its **reference** rows (a pointer to nothing),
and **keeps every copy**: project copies stay in their `PROJECT:` scopes
and discussion copies stay in their transcripts, each with `sourceNodeId`
nulled and `sourceLabel` preserved. The deletion dialog lists each
destination the note went to and lets the person act on the ones they may:
a project copy they published, or one in a project they own, has a
*remove that copy too* checkbox (`DELETE /api/app/projects/:slug/knowledge/notes/:nodeId`,
owner or publisher - the same removal the project's Knowledge view offers);
a discussion copy is a message in a shared transcript and stays, and the
dialog says so. Deleting a project copy from the project
side never touches the original. Deleting the project or the discussion
takes its copies with it (cascade / explicit delete); the ledger row
becomes unreachable and is excluded from every listing by joining the
target.

### 5. What counts as an output - and the label stays "Unfiled apps"

An **output** is a result of work that has a home: a project asset
(`project_assets`, kinds `app` / `script` / `note`), a workspace file, a
run's render, or a generated mini-app discovered in Chat. The only kind that
exists **without** a project today is the generated app (`web_applets` pins
and discovered fences), and `WorkshopInbox` lists exactly those. Files
generated in Chat live with their conversation (`web_generated_files`) and
have no listing of their own yet. The section under the Projects list
therefore keeps the honest, narrower name **Unfiled apps**; it stays the
one place unfiled outputs are listed, with **Add to project** on each item,
and no second inbox is introduced. "Unfiled outputs" is allowed only when
the same section also lists files and reports.

### 6. Conversation identity is not needed for this package

A saved answer's provenance is `(sourceConversationId, sourceMessageId)`
on the ledger row - it does not depend on whether the chat belongs to a
project. Adding a note to a project is a transfer from the personal graph,
not a property of a conversation. So no column joins a `web_conversations`
row to a project here; `resolveKnowledgeScopeForChannel` keeps reading the
`🔭 <name>` title (ADR 0009 §6) and existing rows are not rescoped.

### 7. Organization, not execution, gates "Add to project"

`StudyRoom` offers *Save to project* when `me.features.projects` is on,
whether or not `me.features.observatory` is. Running a saved asset stays
behind the execution gate and the control that needs it explains why
(`EXECUTION_OFF`). Server-written links to a project use
`/projects/:ownerId/:slug/:view`; an invitation still links to the list,
because the invitee cannot open the project until they accept.

## Consequences

- One new per-user table; `privacyService.forgetUser` deletes the actor's
  rows, `auditUser` counts them under `knowledge_transfers`, and the
  transparency report shows how many notes were saved from chat, referenced
  and published. Copies the person published into **someone else's**
  project are project data (like `note_knowledge` rows) and stay when the
  publisher is forgotten, with the ledger row gone.
- Existing notes, apps and project rows are untouched: no backfill, no
  rescoping, `web_applets` and its promote route unchanged.
- Project retrieval that runs *as the project* (graph, `recall_knowledge`,
  expeditions, dashboards) reads only the `PROJECT:` scope, so it sees
  copies and never references - the same boundary the Knowledge view draws.
  Someone who wants Goobster to use a note inside a shared project
  publishes it.
- Tests must cover: a saved answer lands in `knowledge` and not `memory`;
  the picker input refuses a `memory` row; a reference is invisible to a
  collaborator and marked private for the owner once the project is
  shared; publish snapshots content and names the audience; deleting the
  original keeps copies and drops references; the project-side copy removal
  leaves the original; erasure and audit; both engines.

## Alternatives considered

- **Extend `kg_provenance.sourceKind`** with `chat_message` / `transfer` -
  rejected: a `CHECK` rebuild on every database, and provenance has no
  place for audience or mode.
- **Reference by writing a pointer node into `PROJECT:` scope** - rejected:
  every project reader (graph, retrieval, expeditions, dashboards) would
  need cross-scope authorization to avoid leaking the private note; a
  ledger row resolved by the two views that can check the reader is smaller
  and cannot be reached by an unaware reader.
- **Always copy** - rejected by the spec: a private project's owner should
  not have to maintain two versions of their own note.
- **Use in discussion writes to persona knowledge** - rejected: a
  discussion has no scope of its own; personas own `PARLOR:` scopes and a
  shared persona receives only what was published to that discussion. The
  transcript is what every member and persona reads, so that is the copy.


### Retry and concurrent-write guarantees

Discussion transfers require a client-generated `requestId` (1–128 letters,
digits, `_` or `-`). Retrying the same note and discussion with that ID returns
the original message; an intentional new post uses a new ID. The message and
receipt commit atomically. Replays still require current discussion access,
and reusing the ID for another source or destination returns `REQUEST_CONFLICT`.
The dialog retains the ID after a failed response. Project publication runs in
a transaction and edits an existing copy by ID, so a source rename or cleared
body cannot leave an orphaned copy. Audience lookup must succeed before the
dialog enables publication; failed lookups offer Retry.
