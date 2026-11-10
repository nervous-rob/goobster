---
title: Findings shared with a project's members
kind: reference
summary: A responsibility linked to a project can share what it finds with every member of that project instead of only with you (scopes.audience "project"). A finding is shared only when the grant asks for it, the pilot gate allows it, what prompted the work is the project's own (its plan, or a request made in its conversation), you still read the project, and the run read none of your private notes; otherwise it comes to you alone and says why. The member sees whose assistant found it, with no link into your records. A member who leaves stops receiving it at once and the receipt they held is deleted. Covers what is shared and what never is, the pilot gate, who sees what, leaving and erasure, the stored rows, the API and what is not built.
when: Letting a responsibility share a finding with a project's collaborators; understanding why a finding came only to you ("Kept private"); seeing a finding shared by another member's assistant; checking what happens to shared findings when someone leaves, is removed or is erased, or when the project is deleted; understanding PILOT_ONLY on a draft that shares; checking that private notes never reach a project through the assistant.
tags: [assistant, responsibilities, delegation, projects, audience, privacy, collaborators, runs, pilot]
feature: assistant
---

# Findings shared with a project's members

By default a delegated run's finding comes to the person who delegated the
work and nobody else. A responsibility that is linked to a project can
instead share what it finds with **every member of that project**: the
owner and the accepted collaborators. This page says when a finding is
shared, what is kept out of it, who sees it, and what happens when people
leave. It is the DA-11c part of the
[delegated assistant plan](delegated_assistant_implementation.md); the
architecture is [section 13.5](delegated_assistant_architecture.md) ("Project
audiences").

It builds on [responsibilities](delegated_responsibilities.md) (the grant),
[delegated runs](delegated_runs.md) (how work is carried out) and
[requests made in conversation](delegated_conversation_requests.md) (where
most project work comes from).

## In short

- You tick **Share what it finds with this project's members** when you draft
  a responsibility that takes requests from a project's conversations. It is
  part of the grant (`scopes.audience: "project"`), shown on the
  responsibility's row, and an authority change like any other: pause to edit.
- A teammate asks "Goobster, compare Fastify and Hono" in the project's
  conversation (or you do). When the work is done the members see the
  finding on Home, with *Shared with this project by Ada's assistant*, a link
  to the project and a link back to the conversation.
- **You** get your own notice as always (Inbox and Home), which now says
  *Shared with the members of "Lab"*. The shared copy does not also count as
  something for you to review.
- Whatever does not qualify is **not shared**. It comes to you alone and the
  notice says *Kept private:* and why. Nothing fails and nothing is lost.
- Members read it as long as they are members. Leaving, or being removed,
  ends it at once and deletes the receipt they held.

## What is shared

A finding is shared with the project when **all** of these hold at the moment
it is published:

| Condition | If it does not hold, the notice says |
| --- | --- |
| The grant asks for it (`scopes.audience: "project"`, with a linked project) and the work was proposed under that grant | Nothing: it was never asked for |
| The pilot gate allows you the `reach` capability (see below) | Sharing findings with a project is limited to the host until the pilot decision is recorded. |
| You still read the project (owner or accepted collaborator) | You no longer have access to that project. |
| What prompted the work belongs to the project: its plan, or a request made in **that project's** conversation | What prompted it is private to you (your own goal, or a discussion outside this project). |
| The run read none of your private notes | It used your private notes, which are never quoted into a project. |
| Filing it for the project worked | Sharing it with the project did not work. |

Work from your own Attention goal, or from a request you made in one of your
discussions outside the project, is yours even when the responsibility says
"share": the project did not ask for it and its members were not in the
conversation.

## What is kept out

- **Private knowledge is not read.** A run that is going to share is not
  offered the tools that read your own notes, memories and generated notes
  (`lookupNotes`, `listGeneratedNotes`) at all, and is told that its report goes
  to every member. A run that did read them anyway (a resumed run that had)
  publishes to you alone.
- **What the run changed in your own knowledge is not named to the project.**
  The shared finding lists only changes to the project itself (its files and
  sandbox runs) after the run's own report. Your private notice lists
  everything, as it always did.
- **No link into your records.** Another member sees the finding's title and
  summary, the project, the conversation it came from, and whose assistant
  found it. They do not get your responsibility or work item, and the portal
  gives them no way to open either.
- **No conversation context is added.** As before, the run reads only the one
  message it was asked about, never the conversation around it.
- **Nothing is posted into the conversation.** The finding appears on Home
  with a link back; no reply is written into the chat (see "Not built yet").

## The pilot gate

Sharing findings is a DA-11 capability, so it is covered by the owner-only
`reach` capability of the pilot gate
(`assistantAccessService.allows(userId, 'reach')`). Until the host records the
pilot decision, only the installation's owner (an active operator account)
has it. It is checked twice:

- **On entry.** Creating a responsibility, editing its scopes, or activating or
  resuming one with `scopes.audience: "project"` is refused with `PILOT_ONLY`
  (HTTP 409, `capability: "reach"`) for anyone else. Saved drafts stay.
- **When the finding is published.** If the pilot closed after the work was
  proposed, the finding comes to the person alone with the reason above.

The pilot decision itself, and what else it covers, is in the host's
controls. Responsibilities that do not share are not gated.

## Who sees what

| | The producer (whose responsibility it is) | Another member | Someone outside the project |
| --- | --- | --- | --- |
| The shared finding | Yes, already reviewed | Yes, as a new update, with the producer named | No |
| Your private notice | Yes (Inbox and Home) | No | No |
| Where it came from | The work item, the responsibility | Only the project and the conversation | Nothing |
| An Inbox envelope | Yes, on the private notice | No: the finding is on Home | No |

The producer's name is the one the project knows them by, then their
nickname, then their account name. If the producer has since been erased the
finding stays and says *a member's assistant*.

A member joins a project and sees the findings already shared with it, the way
they see its files: findings follow current membership, not the time they
were published.

## Leaving, removal, deletion and erasure

- **A member leaves, or the owner removes them.** What they can read follows
  membership, so the findings are gone for them at once; the same call
  deletes the receipts they held for the project's findings (read, delivered,
  snoozed). If they come back, those findings are new to them again.
- **A missed path.** A membership that ended some other way is caught by the
  retention pass, which deletes receipts of anyone who no longer reads the
  project and findings whose project no longer exists.
- **The project is deleted, or its owner is erased.** The findings shared
  with it and everyone's receipts for them go with it.
- **The producer is erased** (`/forget-me`). The finding stays with the
  project, as other shared project data does; it loses the producer
  (`producerUserId`) and its links to the producer's records, and their own
  receipts and notices are deleted.
- **A member is erased.** Their receipts go with the rest of their assistant
  data; the findings stay for the others.
- **Retention.** Shared findings follow the same 180-day window as any update
  without an open request.

## Stored

Nothing new is stored. A shared finding is an ordinary row in
`assistant_updates` with `audienceKind = 'project'`, `projectId`,
`producerUserId`, and the producer's `responsibilityId` and `initiativeId`
(kept so erasure can detach them; never shown to another member). Read state
is `assistant_update_receipts`, per member. The work ledger holds a
`SHARE_FAILED` code (never text) if filing the shared copy failed.

## API

- `POST /api/app/assistant/responsibilities` and `PATCH .../:id` accept
  `scopes: { sources: ["project_chat"], audience: "project" }` (`audience`
  was already accepted; it needs `projectId`). Without the pilot gate:
  `409 PILOT_ONLY`.
- `GET /api/app/assistant/updates` and the `brief` of `GET /api/app/home` carry,
  for a shared finding:

  ```json
  {
    "audience": { "kind": "project", "projectId": 12 },
    "producer": { "name": "Ada", "you": false },
    "responsibilityId": null,
    "initiativeId": null,
    "actions": [
      { "kind": "open_project", "id": "<owner>/<slug>" },
      { "kind": "open_conversation", "id": "345" }
    ]
  }
  ```

  `you` is true on the producer's own view, which also keeps the
  responsibility and work item ids. A finding that is not shared has
  `audience: { "kind": "private" }` and `producer: null`.

## Choices made where the plan left them open

Each is the most conservative reading; a later stage can widen it.

- **The project's own sources only.** Sharing needs the plan or a request
  made in the project's own conversation. A request in a discussion outside
  the project, or the person's own goal, stays private even when the grant
  says "share".
- **No private tools at all** for a run that will share, rather than reading
  them and filtering the report afterwards.
- **Kept private, with the reason,** rather than refused: the work is done and
  the person is told; they can share what they choose from the project
  themselves.
- **Plan-step runs report privately.** An `agent` step's outcome is already
  visible on the plan; its run's progress notice still goes to the person
  only ([delegated_plan_steps.md](delegated_plan_steps.md)).
- **The producer keeps one thing to review.** The shared copy is marked
  reviewed for the producer, who has their private notice.
- **Members who join later see earlier findings** (findings follow current
  membership, like the project's files).
- **Board gates belong to the project owner.** A request on the project board
  still waits on the owner for everyone else ([assistant_home.md](assistant_home.md#project-boards));
  a finding is information, not a request, and has no gate.
- **No new ADR.** This applies the architecture's "project audiences" rule
  (ARCH 13.5) over the existing `assistant_updates` visibility; it changes no
  contract.

## Not built yet

- **A reply posted into the conversation.** Findings are shared on Home and in
  the project, not written into the chat. A message from Goobster in a
  conversation changes what other people see there and needs its own decision.
- **Findings from plan-step runs** for the project's members.
- **A producer's findings per member**, such as muting one source, are
  feedback (DA-10).
- **Responsibilities shared between people** (deferred by owner decision 5).
- **An opt-in to hide earlier findings from members who join later.**
