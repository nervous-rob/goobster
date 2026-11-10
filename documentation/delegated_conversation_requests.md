---
title: Requests made in conversation, and changing direction
kind: reference
summary: A responsibility can take requests you address to Goobster by name in a project's conversations or in your discussions (scopes.sources project_chat, parlor). A request is recognized by fixed text rules, with no model - his name plus a work verb such as compare, research or look into. It becomes proposed work that quotes your message, links back to the conversation and reports privately to you; it decides nothing and changes no plan. Saying "Goobster, never mind" or "... instead" withdraws your unfinished work from that conversation and one update says what was stopped and what rested on it. Plan-step work is withdrawn as soon as its plan moves on. Covers what counts and what does not, limits, stop codes, what is stored, the API and what is not built.
when: Asking Goobster for work from a project conversation or a discussion; understanding why a message did or did not become proposed work; turning conversation requests on for a responsibility; stopping or redirecting work you asked for; understanding STEERED, SOURCE_GONE, SOURCE_NOT_COVERED, OPEN_LIMIT or NO_STEP on a work item; checking that a collaborator's message or a remark in passing never starts work.
tags: [assistant, responsibilities, delegation, conversations, parlor, projects, steering, runs, privacy]
feature: assistant
---

# Requests made in conversation

You can ask Goobster for a piece of work in a project conversation or a
discussion, and a responsibility you delegated picks it up. This page says
what counts as a request, what happens to it, what a change of direction
does, and what is deliberately not done. It is the DA-4b part of the
[delegated assistant plan](delegated_assistant_implementation.md); the
decision record is [ADR 0021](adr/0021-conversation-requests-and-steering.md).

It builds on [responsibilities](delegated_responsibilities.md) (the grant and
its work items) and [delegated runs](delegated_runs.md) (how a piece of work
is carried out). Project boards, which this stage also changed, are described
in [assistant_home.md](assistant_home.md#project-boards).

## In short

- You say, in a conversation the responsibility covers:
  "Goobster, compare Fastify and Hono".
- It becomes a **proposed** piece of work under that responsibility, on the
  Assistant page. It quotes your message and links back to the conversation.
  It starts when you press *Start*, or by itself if the responsibility
  starts work automatically.
- The run works inside what the responsibility allows, exactly as any other
  delegated work. Your message does not add permissions.
- The result comes to **you** (Home, Inbox), with a link to the conversation
  (and, only if you granted it, to the project's members too).
  Nothing is posted into the conversation, no decision is recorded, and no
  plan is changed. Looking into a migration is not deciding to migrate.
- "Goobster, never mind" or "Goobster, compare Koa instead" in the same
  conversation withdraws what you asked for there and has not finished, and
  you get one update saying what was stopped and what rested on it.

Nothing happens unless you turned this on for a responsibility. Nobody
else's messages are ever read for it.

## Turning it on

A responsibility takes requests from the places named in its
`scopes.sources`:

| Source | What it covers |
| --- | --- |
| `project_chat` | The conversations of the project the responsibility is linked to (`projectId` is required) |
| `parlor` | Your own discussions (ones you own or were invited to) that belong to no project |

On the Assistant page the draft form offers both as checkboxes: *Take
requests you address to Goobster in this project's conversations* and *...in
your discussions*. The responsibility's row then says where it listens.
`personal_chat` is reserved for one-to-one chat with Goobster and is not
read yet (DA-8).

The source says where requests are read. What a run may then **do** is still
only the responsibility's operations: a responsibility that takes requests
from a project conversation but only grants "read the web" researches on the
web and cannot touch the project's files.

If two of your active responsibilities cover the same conversation, the
older one takes its requests. A request is never proposed twice.

## What counts as a request

The rule is fixed text matching. No model reads your conversations for this.
A message is a request when **both** are true:

1. **It addresses Goobster.** His name opens or closes the message
   ("Goobster, ...", "Hey Goobster ...", "..., Goobster?"), or the message
   mentions `@Goobster` anywhere. The name is the one this installation gives
   its assistant (`identity.assistantName`).
2. **What is left asks for work.** An optional polite form ("can you",
   "please", "I need you to", "could you" ...) followed by a work verb:
   look into, look at, look up, research, investigate, find, find out,
   figure out, compare, check, review, summarize, draft, write, analyze,
   evaluate, assess, test, verify, explore, survey, list, collect, gather,
   benchmark, document, outline, prepare, study, audit, measure, "see if"
   and a few close relatives. The full list is `WORK_VERBS` in
   `packages/core/services/assistant/conversationRequests.js`.

| Message | Result |
| --- | --- |
| "Goobster, compare Fastify and Hono" | A request |
| "@Goobster could you look into the flaky upload test?" | A request |
| "Can you research edge caching for us, Goobster?" | A request |
| "We should compare Fastify and Hono at some point" | Nothing: not addressed to him |
| "I asked Goobster about this yesterday" | Nothing: he is mentioned, not addressed |
| "Goobster, what do you think?" | Nothing: a question, not a piece of work |
| "Goobster, can you explain that again?" | Nothing: "explain" is conversation, answered in the conversation |

Only **your own** messages count: the person the responsibility acts for.
A collaborator's "Goobster, compare ..." in the same project conversation is
theirs; it becomes work only under a responsibility of their own. A
persona's reply is never a request.

Also not a request:

- anything said **before** the responsibility first looked. Its first look
  only notes where the conversation log ends;
- a message more than 7 days old when it is first read;
- chat history copied into a project when a chat was moved or shared there;
- the same words again while work from that conversation with those words is
  still open.

A responsibility holds at most 10 open pieces of work that came from
conversations. A request past that is recorded as *cancelled* with the note
that the limit was reached, so you can see it and press *Try again* later.

## What becomes of a request

The work item stores **where** the request was made (conversation and
message), not what it said. Its title is "Asked in" and the conversation's
name. Wherever the request is shown or used, the message is read again under
your access as it is at that moment:

- the Assistant page quotes the first 280 characters and links to the
  conversation (*Open the conversation*);
- the run reads the message when it starts. If the message or conversation
  is gone, or you can no longer read it, the work ends *superseded*
  (`SOURCE_GONE`) without calling a model. If the responsibility no longer
  covers that conversation, it ends *superseded* (`SOURCE_NOT_COVERED`).
  The same check withdraws proposed and queued work at the next look.

The run is given that one message. It does not read the rest of the
conversation or anything other people said there. It is told that the
request asks for work inside the responsibility and grants nothing more,
that looking into something is not deciding it, and that its report goes
only to you. Every tool call is still checked against the responsibility
([delegated_runs.md](delegated_runs.md)).

The result is a private update for you: a finding, a summary of what was
changed, or a note that nothing needed your attention. It carries two
links: the work item, and the conversation it was asked in (*Conversation*
on Home's "What changed"). The Conversations card on Home counts it.

What is **not** done, by design:

- no reply is posted into the conversation (see "Not built yet");
- no project decision is recorded and no plan or plan step is created,
  edited, approved or started;
- the request's text is not copied into the work item, the ledger or a
  notification.

## Changing direction

A message is **steering** when it addresses Goobster and what is left opens
with a change of direction: instead, actually, scratch that, scrap that,
never mind, forget that, forget it, stop, cancel that, drop that, hold off,
change of plan, on second thought, don't, do not, no need to. A request
that ends with "instead" is steering too.

Steering may carry the replacement: "Goobster, actually compare Koa and
Hono" withdraws the earlier work and proposes the new comparison.
"Goobster, don't research Fastify" only withdraws: the thing you called off
is never read as the new request.

When a responsibility reads a steering message of yours, in one transaction:

1. Every piece of work that **your earlier requests in that conversation**
   produced and that has not finished is ended *superseded* (`STEERED`):
   - proposed, queued and waiting work ends at once;
   - work in progress loses its lease. Its run stops before its next tool
     call, the same way a cancel stops it, and reports no result.
2. One update is recorded for you, "Changed direction: N requests stopped".
   It says how many had not started and how many were stopped mid-work, and
   names what rested on the earlier direction:
   - changes a stopped run had already made (from its journal). They are
     left as they are;
   - research expeditions it had started, which are cancelled;
   - results finished under the earlier direction in the last 7 days, by
     title, as worth another look. They are not withdrawn.

Nothing is undone or deleted. The superseded work keeps a reference to the
message that replaced it, stays listed on the Assistant page with its quote,
and has *Try again*.

Steering reaches only work that came from **that conversation** and belongs
to **you**. It does not touch other conversations' requests, other people's
work, or plan steps. A plan changes through the plan:

## When a plan moves on

Work proposed for a plan's assistant step
([delegated_plan_steps.md](delegated_plan_steps.md)) used to be checked only
when it started. It is now also checked on every look, so proposed, queued
and waiting plan-step work is withdrawn as soon as the plan it was proposed
under is no longer the plan:

| What changed | The work ends *superseded* with |
| --- | --- |
| The plan was edited or re-approved at another revision | `PLAN_REVISION_STALE` |
| The plan was cancelled, completed or is no longer running | `PLAN_NOT_ACTIVE` |
| A person completed or skipped the step, or it failed | `STEP_NOT_ELIGIBLE` |
| The step was removed or is no longer an assistant step | `NO_STEP` |

A step that the work's own run is holding is left to that run. Work in
progress is still stopped by the run's own checks (`PLAN_STEP_CLOSED`).

## Timing

Posting a message that addresses Goobster makes your responsibilities look
about two seconds later, in the process that runs the assistant's periodic
pass. That pass, every 5 minutes, finds anything that missed, including a
message posted through a separate web process in a split deployment. Both read the stored conversation, so a restart loses nothing.

## Privacy and what is stored

- `assistant_initiatives.originJson` holds references only: the kind, the
  surface (`project` or `parlor`), the conversation id, the message id, who
  said it, and who can read that conversation. `supersededBy` holds
  `parlor:<conversation>:<message>` or `plan:<plan id>`.
- No message text is stored outside the conversation. Excerpts are read live
  and only for the person who wrote the message.
- Erasing a person (`/forget-me`) removes their work items with the rest of
  their assistant data. Where a work item survives because someone else owns
  it, the erased person's origin reference is removed with their id.
- Ledger rows hold codes only (`STEERED`, `SOURCE_GONE` ...).

## API

- `POST /api/app/assistant/responsibilities` and `PATCH .../:id` accept
  `scopes: { sources: ["project_chat", "parlor"] }`.
  `GET /api/app/assistant/responsibilities` lists the accepted values under
  `vocabulary.sourceScopes`.
- `GET /api/app/assistant/initiatives` and `.../:id`: a piece of work that
  came from a conversation carries

  ```json
  {
    "origin": {
      "kind": "parlor_message", "surface": "project",
      "conversationId": 12, "messageId": 345,
      "available": true, "conversationTitle": "API design",
      "excerpt": "Goobster, compare Fastify and Hono",
      "link": "/discussions/12"
    },
    "supersededBy": null
  }
  ```

  `available` is `false`, with no excerpt or link, once the message is out
  of your reach. Other work has `origin: null`.
- An update's `actions` may include `{ "kind": "open_conversation", "id": "<conversation id>" }`.
- `POST /api/app/assistant/initiatives/:id/actions` with `retry` reopens a
  superseded or cancelled conversation request as a new attempt.

Stop codes introduced here:

| Code | Status | Meaning |
| --- | --- | --- |
| `STEERED` | superseded | You changed direction in that conversation |
| `SOURCE_GONE` | superseded | The message or conversation is gone or no longer readable by you |
| `SOURCE_NOT_COVERED` | superseded | The responsibility no longer takes requests from that conversation |
| `OPEN_LIMIT` | cancelled | The responsibility already had 10 open conversation requests |
| `NO_STEP` | superseded | The plan step no longer exists as an assistant step |

## Choices made where the plan left them open

Each is the most conservative reading; a later stage can widen it.

- **Explicit requests only, by fixed rules.** Owner decision 4: this stage
  acts only on requests addressed to Goobster. Reading a conversation for
  what people might want, and one-to-one chat, arrive with DA-8.
- **Only the asker's own messages**, under the asker's own responsibility.
  A responsibility never acts on another person's words.
- **The run reads the one message**, not the conversation around it. Other
  people's words do not enter a private run.
- **The result is private to the asker by default.** A responsibility that
  also grants `scopes.audience: "project"` shares the finding with the
  project's members when the request was made in that project's conversation
  ([delegated_project_findings.md](delegated_project_findings.md)).
- **Steering is scoped to the conversation and the person.** Ambiguous
  openers ("actually", "instead") are read as steering: withdrawing
  unfinished work costs a press of *Try again*; continuing work a person
  called off costs their trust.
- **Finished results are named, not withdrawn.**
- **References, not text**, in everything stored.

## Not built yet

- Requests in one-to-one chat with Goobster, and requests recognized by a
  model instead of by rule (DA-8).
- Matching a request against work that already exists under other words,
  and against plan steps (DA-8).
- A daily cap on proposals from conversations beyond the open limit (DA-8).
- A reply or hand-off posted into the conversation. (Findings shared with a
  project's members are built; see
  [delegated_project_findings.md](delegated_project_findings.md).)
- Responsibilities shared between people (deferred by owner decision 5).
