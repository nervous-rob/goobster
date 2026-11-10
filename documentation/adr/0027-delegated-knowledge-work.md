# ADR 0027: Saved-note changes are proposals the person applies, and archiving, merging and connecting are reversible

## Status

Accepted for DA-11b of the
[delegated assistant plan](../delegated_assistant_implementation.md), with
the DA-3 leftovers of [architecture section 6](../delegated_assistant_architecture.md)
(change sets, claim status, source-retraction impact). It builds on
[ADR 0016](0016-delegated-responsibilities.md) (the grant),
[ADR 0018](0018-delegated-runs.md) (the run and its tool contract; amended for
this) and the gate registry of
[ADR 0021](0021-conversation-requests-and-steering.md). Behaviour is
documented in [delegated_knowledge.md](../delegated_knowledge.md). The code is
`services/knowledgeChangeSetService.js`, `services/knowledgeImpactService.js`,
`services/assistant/runTools/savedNotes.js` and the archive, edge and claim
primitives of `services/knowledgeGraphService.js`, all under `packages/core/`.

Outside connectors (DA-11d) and any permanent deletion by a run are not part
of this decision.

## Context

A run could read notes and add generated ones, but a note the person saved
was protected: nothing could change its words, and there was no way to say
"this connects to that" or "this is out of date" with a record of why. Three
things made a careless answer dangerous. A merge deleted the dropped note and
its edges. An edge had no author, evidence or history. And the graph had one
state for a claim, so a correction either overwrote text or did nothing.

## Decision

**A change to a saved note is a change set, and a proposal is the default.**
`kg_change_sets` records the run, the responsibility revision, the note and
the revision the run read, the proposed text, the rationale, the policy that
allowed it (`PROPOSAL` or `DIRECT_GRANT`) and the revision the change
produced. A proposal is published as a gate card with a bounded diff.
Applying it is a gate decision, which is reachable only from the signed-in
route: no run tool applies a proposal, so a run cannot approve its own work.
Direct editing exists only when the grant names `kg.saved.amend`.

**The revision is the guard.** A proposal and a direct change carry the
revision the run read. A note that moved since makes the proposal `STALE`
(committed, then reported as a conflict) and writes nothing; an undo is
refused once the note has moved on. A person's edit is never overwritten and
nothing is forced.

**Nothing is deleted.** Archiving sets `archivedAt` and removes the note from
retrieval, search and the graph views while keeping it in the overview,
export and erasure. A merge archives the dropped note as an alias
(`mergedIntoId`) and re-points its edges as merge-marked edges, which an undo
retracts. A retracted connection keeps its row, evidence and history and can be
restored; a connection the person removed cannot be re-made by a run.

**Claim status is separate from confidence and curation.** `claimStatus`
(`current`, `disputed`, `superseded`, `retracted`) says what the text claims;
a dispute keeps the person's words and labels retrieval output. Age never
lowers it.

**Evidence is counted once and cannot be circular.** `confirmNote` adds a
confirming provenance row per run, never twice, never from the responsibility
that wrote the finding, never for a saved note, and files no update.

**A withdrawn source is reviewed, not acted on.** The review finds the notes
that cite it and the active assumptions that rest on it, marks the citing
provenance withdrawn, and proposes `disputed` through the same gate. A missing
source is unverifiable, not false.

**Capacity protects saves.** The live cap counts live notes; archiving makes
room; saved notes are never evicted; the archive is bounded (oldest generated
first) and restore into a full scope is refused.

**The pilot gate.** Every operation (`kg.saved.propose`, `kg.saved.amend`,
`kg.edge`, `kg.archive`) maps to capability `reach` in
`assistantAccessService`; activation, tool availability and each call ask it.
Undo and restore are not gated, so a change stays reversible after the pilot
closes.

## Consequences

- The run tool contract gains two optional flags: `proposes` (a write that
  files something for the person, reported as "Waiting for you") and `quiet`
  (an effect that is evidence only, reported as no change).
- A gate card may carry a bounded `diff`, in addition to the 400-character
  detail.
- `kg_change_sets` is personal data: it holds note text, so it is in the
  erasure path, the export and the dormant-data audit, and decided rows are
  pruned after 180 days.
- Retrieval, the graph views, exports to other features and the Observatory
  must filter archived notes. Each reader was changed, and a new reader of
  `kg_nodes` must do the same.
- A saved-note change by a run needs the person to open the card; a person who
  never does gets a stale proposal after 30 days and an unchanged note.
