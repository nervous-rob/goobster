---
title: Knowledge work done for you
kind: reference
summary: A responsibility can propose changes to notes you saved (shown as a diff you apply yourself), edit one directly only when its grant names direct editing, connect notes with evidence, archive notes it generated, confirm a finding, and review what rests on a source that has been withdrawn. Everything is reversible - an archived note and a retracted connection are restorable, a merge can be undone, an applied change is reverted while the note is unchanged since - and a concurrent edit of yours is never overwritten. Covers the tools and grants, the proposal and its card, direct changes, connections and their evidence, archiving and merging, claim status, confirmation, source-retraction review, the owner-only pilot gate, limits, retention and erasure, the API, the stored rows and what is not built.
when: Letting a responsibility suggest or make changes to your notes; applying, dismissing or undoing a suggested change; understanding why a proposal went stale; restoring an archived note or a retracted connection; seeing why a note says disputed; reviewing what a withdrawn source touched; understanding PILOT_ONLY on a grant that names note operations; checking that saved notes are never overwritten, archived or evicted by a run.
tags: [assistant, responsibilities, delegation, knowledge, notes, change-sets, archive, merge, claim-status, privacy, pilot]
feature: assistant
---

# Knowledge work done for you

A responsibility you have granted knowledge access to can do more than read
your notes and add generated ones (see
[delegated runs](delegated_runs.md)). This page covers the rest: suggesting
changes to notes you saved, connecting and archiving notes, confirming a
finding, and reviewing what rests on a source that was withdrawn. It is the
DA-11b part of the [delegated assistant plan](delegated_assistant_implementation.md)
and the "knowledge change sets" of the
[architecture](delegated_assistant_architecture.md) (section 6). The reasons
for the design are in [ADR 0027](adr/0027-delegated-knowledge-work.md).

## In short

- A note **you saved is yours.** A run never changes its words unless you
  apply the change yourself or the grant names direct editing; it never
  archives it, never confirms it, and never merges it.
- A **proposal** changes nothing. It is one card on Home and in your Inbox
  that shows what would change as a diff. **Apply change** and **Dismiss** are
  decisions only you can make; the assistant has no tool that applies a
  proposal.
- If the note changed after the run read it, the proposal goes **stale**
  instead of overwriting your edit.
- **Archiving, connecting and merging are reversible**: nothing is deleted.
- Every capability here starts with the installation's owner only
  ([the pilot gate](delegated_operations.md#the-pilot-gate), capability
  `reach`).

## What a responsibility can be given

Knowledge grants live on the draft form under the assistant's knowledge
choices. Each is a grant operation on the resource `knowledge` / `personal`,
and each needs the read grant too.

| Grant | Tools it offers | What they may do |
| --- | --- | --- |
| `read` | `findNotes`, `listNoteLinks` | Look up your notes and their connections |
| `kg.saved.propose` | `proposeNoteChange` | Suggest new wording for a saved note, or mark its claim as disputed. Nothing changes until you apply it |
| `kg.saved.amend` | `amendSavedNote` | Change a saved note directly. Offered only when the grant names it; the change is recorded with before and after and can be reverted |
| `kg.edge` | `linkNotes`, `retractNoteLink` | Connect two notes with a relation, and retract a connection a run made |
| `kg.archive` | `archiveNote` | Archive a note a run or the machine generated |
| `kg.generated.amend` | `confirmNote` | Add confirming evidence to a generated finding |

A tool the grant does not name is not offered to the model at all, and a call
to it anyway is refused as unknown. Each call is also checked again against
the grant and the pilot gate when it runs.

## A suggested change

`proposeNoteChange` takes the note id and the revision the run read, new
content (or a reason to dispute the claim) and a short rationale. It files a
**change set** with status `PROPOSED` and publishes a gate card. The run's
report says "Waiting for you: ..." and never "Changed: ...", because nothing
changed.

The card shows:

- the note's label and the rationale;
- the change as a **diff** - added text, removed text and the unchanged
  passages folded to "N unchanged passages";
- two options, **Apply change** and **Dismiss**.

Apply writes the note at the next revision, keeps it saved, and records the
revision it produced. Dismiss leaves the note exactly as it was. Both are
available only to you, from the signed-in portal; the same card appears in the
Inbox.

### When the note moved

- A proposal for a revision that is already out of date is **not filed**; the
  tool says the note changed since the run read it.
- If you edit the note after the proposal is filed, the card says so and
  offers only Dismiss. Pressing an old copy of the card is refused as stale
  (409). Applying past the card finds the revision moved, writes nothing, and
  marks the proposal `STALE`.
- Proposing the same change again does not make a second card. A newer
  proposal for the same note replaces the older one (the older goes `STALE`,
  code `SUPERSEDED`).
- A proposal nobody decides goes `STALE` after 30 days (`EXPIRED`).

### Limits

A run files at most 5 proposals or changes. A responsibility may have at most
10 proposals waiting. A note you did not save needs no proposal, and a change
that would not alter the text is not proposed.

## A direct change

Under `kg.saved.amend` the run changes the note itself. The change set is
`APPLIED` at once with policy `DIRECT_GRANT`, holds the before and after
text, and the report says "Changed: ...". It is checked against the revision
the run read, like a proposal. You can **Undo** it from *Changes to your notes* in the Assistant room.

## Undoing an applied change

Undo puts back exactly what was replaced, and only while the note is still at
the revision the change produced. If you edited the note since, undo is
refused (`REVISION_CONFLICT`) rather than overwriting you; if the note was
archived, restore it first (`NOTE_ARCHIVED`).

## Disputing a claim

A proposal can carry a **dispute** instead of new wording. Applying it marks
the note's claim status `disputed` and **keeps your words**. Retrieval shows a
disputed note with a `[disputed]` label so a later answer does not present it
as settled. Undo returns it to `current`. The claim statuses are `current`,
`disputed`, `superseded` and `retracted`; a retracted note is never presented
as current.

## Changes made by your feedback

Answering a finding with **This is wrong** or **Keep this wording**
([delegated_feedback.md](delegated_feedback.md)) changes the notes that
finding's run wrote, and is recorded here like any other change:

- *You said this was wrong* (`APPLIED`, policy `FEEDBACK_WRONG`): the note's
  claim status becomes `disputed`. The note, its history and its sources
  stay. Undo returns it to `current`.
- *You kept this wording* (`APPLIED`, policy `FEEDBACK_KEEP`): the generated
  note becomes a saved note of yours ("kept as yours"), which a run may then
  change only as it may change any saved note. Undo makes it a generated
  note again.

Both are your own change, made by you, so neither needs a grant and neither
is made by a run.

## Connecting notes

`linkNotes` connects two live notes with a short relation. The connection
records its **evidence** (the run that made it) and is revision-checked on both
notes. A connection that already exists is reported, not duplicated.
`retractNoteLink` retracts a connection a run made; nothing is deleted, the
connection keeps its history and stays in the overview where you can **Restore**
it. If you removed a connection yourself, a run cannot bring it back.

## Archiving and merging

`archiveNote` archives a generated note. A saved note is refused ("the person
saved that note, so it is theirs"), so the run suggests it in its report
instead. An archived note leaves normal retrieval, search, the graph views and
the Observatory but stays in your overview and in your export, and **Restore**
brings it back with its connections.

Merging two notes in the graph no longer deletes the dropped one: it is
archived as an alias of the kept one, and its connections move over marked as
merge edges, so the merge can be undone and a reference to the old note still
explains itself.

Capacity protects what you saved. A full scope refuses a new generated note
until one is archived; saved notes are never evicted; the archive itself keeps
at most 500 notes, dropping the oldest generated ones first; and restoring into
a full scope is refused (`CAPACITY`) rather than forced.

## Confirming a finding

`confirmNote` adds one confirming source to a generated finding, which
strengthens its confidence a little. It is evidence only: it adds no note,
changes no wording, and files **no update** - a run that only confirms reports
no change. Each run confirms a note once; a responsibility cannot confirm
what it wrote itself, so a finding cannot corroborate itself; a saved note is
never confirmed.

## When a source is withdrawn

If a source you relied on is retracted, a review can be asked for through
`POST /api/app/assistant/knowledge/retractions` (owner-only during the pilot;
the portal has no form for it yet, but a review's card and its undo appear
like any other). The
review finds the notes whose provenance cites the source and the active
project assumptions that rest on it, and files one **source retraction**
proposal. **Nothing is deleted or changed.** A missing source means the claim
is *unverifiable, not false*, and the card says so. Citing rows are marked
withdrawn; applying the proposal marks the cited notes `disputed` (their text
stays), and undo returns them. Reviewing the same source again returns the same
review.

## The pilot gate

Every capability on this page asks
`assistantAccessService.allows(userId, 'reach')`. Until the host records the
pilot decision, only the owner can activate a grant that names a note
operation (`PILOT_ONLY`), the tools are not offered to anyone else's runs, and
each tool asks again when called. Undoing and restoring stay available after the
pilot closes, so a run's change is always reversible.

Applying or dismissing a suggestion, and answering a withdrawn-source review,
is a decision from a card, so it also asks for `conversation`
([assistant_home.md](assistant_home.md#who-is-offered-a-card-the-pilot-gate)).
A suggestion is only ever filed for someone inside the pilot, so the two differ
only for a person who has since left it: their suggestion stays listed here and
under Needs you, carries no card, cannot be applied, and lapses after a month
like any undecided one. Nothing is changed in their notes meanwhile, and they
decide it as before if they return.

From a card in portal chat the decision also needs the confirmation receipt
minted for that card
([delegated_conversation.md](delegated_conversation.md)): the receipt covers
the lines of the diff the person was shown, is spent once, and a model's tool
call can neither mint nor spend one, so no run and no chat tool applies a
suggestion.

## Retention and erasure

A change set holds the text of a note, so it is personal data. Decided change
sets are deleted 180 days after they were decided. `/forget-me` removes all of
a person's change sets, the export includes them, and the archive and the
provenance rows follow the notes (erasure and export work by the note's scope,
so archived notes are included).

## Where it lives

- Stored rows: `kg_change_sets`; added columns on `kg_nodes` (`archivedAt`,
  `archivedBy`, `archiveCode`, `mergedIntoId`, `claimStatus`), `kg_edges`
  (`revision`, `evidenceKind`, `evidenceId`, `originRunId`, `retractedAt`,
  `retractionCode`) and `kg_provenance` (`retractedAt`).
- Services: `knowledgeChangeSetService`, `knowledgeImpactService`,
  `knowledgeGraphService`; the tools are `assistant/runTools/savedNotes.js`.
- Card kinds: `note_proposal` and `source_retraction`.
- API (signed in, under `/api/app/assistant/knowledge`): `GET` overview,
  `POST changes/:id/revert`, `POST notes/:id/restore`,
  `POST connections/:id/restore` and `POST retractions`.
  Applying and dismissing a proposal go through the gate decision route, like
  every card.

## Not built

A portal form that asks for a source review, merging or superseding notes by a run, deleting a note, proposing changes in
bulk, valid-time and last-verified fields, and a model that judges whether two
sources are independent. A run cannot permanently delete anything.
