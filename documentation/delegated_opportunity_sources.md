---
title: Wider opportunity sources - requests in your own chats, kept items, failed runs, CI verdicts
kind: reference
summary: A responsibility can notice work by itself from four more places, each opt-in in its scopes.sources and each a pilot capability that only the installation's owner has until the pilot decision is recorded - personal_chat (a request or commitment you make in your own portal chat, with no name needed), followed_source (an item you kept from a source you follow), job_failure (a failed run in the linked project, once per failure cause) and ci_verdict (a settled CI verdict on a watched branch). Everything before you activate is history. Each source proposes at most 3 pieces of work a day; the rest is counted, not queued. Covers what counts, what is never read, the one model call and its budget, the cap, the lookback preview, stop codes, what is stored and what is not built.
when: Letting the assistant notice work without being told; understanding why a chat message, a kept item, a failed run or a CI result did or did not become proposed work; turning personal_chat, followed_source, job_failure or ci_verdict on for a responsibility; the daily cap of 3 and the "not proposed" count; the preview of what activation treats as history; understanding SOURCE_GONE, SOURCE_NOT_COVERED, SOURCE_MOVED or PILOT_ONLY on a work item; checking that incognito chats, chats excluded from memory, other people's runs and a skipped CI check never start work.
tags: [assistant, responsibilities, delegation, sources, chat, followed-sources, jobs, ci, caps, classification, privacy, pilot]
feature: assistant
---

# Wider opportunity sources

[Requests made in conversation](delegated_conversation_requests.md) lets you
ask for work by name. This page is the DA-8 part of the
[delegated assistant plan](delegated_assistant_implementation.md): four more
places a responsibility can **notice** work on its own, always inside a
responsibility you activated, always as *proposed* work that waits for Start
(or starts by itself only if you turned that on), and always under a daily
cap. The decision record is
[ADR 0026](adr/0026-wider-opportunity-sources.md).

## In short

| Scope in `scopes.sources` | Notices | Needs in the grant |
| --- | --- | --- |
| `personal_chat` | A request or commitment you wrote in your own portal chat | Nothing beyond the responsibility's own operations |
| `followed_source` | An item you **kept** from a source you follow | `read` on the process `followed_source:<id>` |
| `job_failure` | A run of yours in the linked project that failed for a cause not seen before | `read` on the project, and `projectId` |
| `ci_verdict` | A watched branch whose CI failed, or went green after failing | `read` on the repository (with its `projectId`) |

- None of them runs until you turn it on for a responsibility, and none is
  read before you activate it.
- All four are **pilot capabilities** (the `sources` capability of
  [the pilot gate](delegated_operations.md#the-pilot-gate)): until the host
  records the pilot decision, only the owner of the installation can name
  them in a responsibility. For anyone else, activation answers `PILOT_ONLY`,
  and a responsibility that already names one stops noticing at once,
  withdraws what it had proposed, and does not start what was already queued
  (that ends `PILOT_ONLY` before any model call).
- Each source proposes **at most 3** pieces of work per responsibility per
  day. A change over the cap is counted and folded into where the source had
  read to, not queued: a flood becomes at most 3 items and a number, never a
  backlog.
- A request in your own chat that calls Goobster by name is not capped
  (like one in a discussion); the open-work limit of 10 still applies.

## History is not an order

When a source is first looked at after activation, the adapter records where
it stands and proposes nothing. A branch that was already red, a run that
already failed, an item you kept last week, a message you sent yesterday:
all history. The Assistant page's **What would it notice?** button shows,
before you activate, the cutoff (activation itself takes the baseline: the
moment you press Activate), how many records already there would be treated
as history, and a few examples. It reads only what the source itself would read, calls no
model, and is available to the owner of the responsibility only.

## Personal chat (`personal_chat`)

Reads **only** messages you wrote, in your own portal chats, that were said
there (not copied in when a chat was branched or moved).

Never read:

- an incognito exchange: it is never stored, so there is nothing to read;
- a chat you excluded from memory (`memory_channel_exclusions`);
- any chat while **Learn from my chats** is off in Settings → Memory;
- Goobster's own replies, except the two lines before a message, which are
  shown to the classifier and to the run as context.

How a message is judged, cheapest first:

1. A request that calls Goobster by name with a work verb (the fixed rules of
   [conversation requests](delegated_conversation_requests.md)) is an
   **explicit** request: proposed, uncapped.
2. The same wording without the name ("can you look into that for me", "please
   compare X and Y") is **implied**: proposed, and counted against the cap.
3. A message with a request-like cue but neither of the above is shown to a
   model for **one label**: `request`, `commitment`, `mention` or `none`.
   `request` and `commitment` are proposed (implied, capped); `mention` and
   `none` propose nothing. "I've been thinking about Rust lately" is a
   mention. "I need to compare Fastify and Hono before Friday" is a
   commitment.

The model call is deliberately small:

- it sees the responsibility's title and outcome, up to two preceding lines
  and the message, which is marked as data it must label and never obey;
- it returns one word; anything else is `none`;
- it never widens what a run may do. A label only decides whether something
  is *proposed*; authority is always the grant's;
- the label (never the text) is cached per message and responsibility
  revision (kept 30 days), so a restart or a stalled pass never pays twice;
- it is charged to the responsibility's own daily token budget (work kind
  `assistant_classification`), may use at most **10 percent** of it, and does
  nothing while the host's stop-all is on;
- at most 5 messages are judged per responsibility per pass (every 5
  minutes). The reading position stops before a message that could not be
  judged (no allowance left, no provider), so nothing is skipped; a message
  older than 7 days when first read is not acted on.

When two active responsibilities of yours both name `personal_chat`, the
older takes the requests.

The result reports to you, and the update links back to the chat. As in
conversation requests, there is no steering in personal chat yet.

## Kept items (`followed_source`)

Keeping an entry of a followed source is you saying it matters. The adapter
proposes one piece of work for an entry you **kept after activating**; an
entry nobody kept is only watched (it can never be proposed), and one kept
before activation is history. Un-keep then keep again is the same
opportunity, not a second.

It reads only the followed sources named in the grant as
`followed_source:<id>` processes, only your own, and only entries from the
last 30 days. Unfollowing the source, un-keeping the entry or revoking the
grant withdraws the proposal on the next pass (`SOURCE_GONE` or
`SOURCE_NOT_COVERED`).

The run is given the title, link, author and the saved text of that one
entry as evidence, marked as someone else's text.

## Failed runs (`job_failure`)

Proposes one investigation per **failure cause** in the linked project, not
one per retry. A cause is defined by what the failed job recorded:

> status (failed or timed out), exit code, the exception class on the last
> stderr line, and the last stack frame that is your own file (library and
> runtime frames are ignored; the path is cut down to the project's own
> relative path). When the output names neither an exception nor a file, the
> language and asset version stand in.

Numbers, timestamps, line numbers and message text are not part of a cause,
so three retries of one broken script are one cause. A cause is **new** when
no earlier failure in the project in the last 30 days has it, and each cause
is proposed once per responsibility.

Which jobs count: those **you** started. A job another member started is
theirs. Jobs the assistant ran itself, the children of a plan step (they have
their own failure handling) and cancelled or interrupted jobs are never an
opportunity. The reading position never passes a job that is still running,
so a job that fails late is read when it fails.

The run is given the job's error output (its stderr tail, its stdout tail,
its error text) as evidence between markers. Failures that predate
activation are history.

## CI verdicts (`ci_verdict`)

Reads the CI watch you already set up (Code view): it never calls GitHub
while noticing and never holds a token. A watch settles a head commit as
`success` or `failure`; everything else (`pending`, `incomplete`, `none` and
**`skipped`**) is only observed.

- A **failure** on a head commit not seen failing is proposed.
- A **success** is proposed only after the branch was last settled as
  `failure` (the recovery). A skipped check is neither a pass nor a recovery
  and does not erase the memory that the branch was red.
- A watch in **fix** mode is left to the watch: it already starts its own
  repair turn and tells you when it gives up.
- A newer head commit replaces the verdict a proposal was about
  (`SOURCE_MOVED`).

When the run starts it reads that exact commit's checks once through
**your own** GitHub connection and is told the counts, the failing checks and
what was skipped, with the rule that a skipped check is evidence of nothing.
If that read is not possible it works from the stored verdict and says so.
The summaries CI returns are evidence, never instructions.

## The daily cap

| Source | Cap per responsibility per UTC day |
| --- | --- |
| `chat_request` (implied requests and commitments) | 3 |
| `followed_source` | 3 |
| `job_failure` | 3 |
| `ci_verdict` | 3 |

The number is the proposed default (architecture 13.2) and a constant today.
The count is taken with one conditional write, so a restart or a second
process cannot exceed it. A change over the cap increments a **not
proposed** counter, moves the cursor on and is shown on the Assistant page
("3 of 3 proposed, 2 more not proposed"). Repeatedly dismissed proposals
lower the rate through DA-10, which scales this number.

## After a pause

Pausing a responsibility holds noticing; resuming it does not take a new
baseline, so what happened while it was paused is read after the resume, as
new: chat messages from the last 7 days, items kept among the last 30 days of
fetched entries, failed runs from the last 3, and the current state of each watched branch. The daily cap
bounds it to 3 pieces of work per source per day, nothing starts without
Start unless the responsibility starts work automatically, and a message
older than 7 days is never acted on. A catch-up preview for a long pause is
not built.

## Why something stops

| Code on a work item | Meaning |
| --- | --- |
| `SOURCE_GONE` | The chat, message, entry or job is gone, was un-kept, or is no longer yours to read. Deleting a chat withdraws what it caused. |
| `SOURCE_NOT_COVERED` | The responsibility no longer names the scope or grants the read. |
| `SOURCE_MOVED` | The watched branch has a newer commit. |
| `PILOT_ONLY` | The source is a pilot capability and this person does not have it. |
| `OPEN_LIMIT` | Ten open pieces of work from this source already. |

Pausing a responsibility, the host's stop-all and a spent classification
allowance hold noticing; they do not withdraw anything. Everything proposed
is re-read as you, under the adapter's own access check, when the run starts,
before any model call.

## What is stored

- `assistant_proposal_counters`: one row per responsibility, source and UTC
  day: how many were proposed and how many were not. Numbers only. Kept 14
  days.
- `assistant_message_labels`: one label per judged message and
  responsibility revision. The label, never the text. Kept 30 days.
- The initiative's `origin` holds references (chat and message ids, the
  followed-source entry id, the CI watch id and commit, the job id and cause
  hash), never the text.
- Both tables, like every per-person assistant table, are part of your
  export, the transparency report and `/forget-me`.

The work ledger records classification spend under work kind
`assistant_classification` (the responsibility id), codes only.

## API

- `GET /api/app/assistant/responsibilities/:id/sources`: the lookback
  preview and today's counts for one of your own responsibilities. It works
  for a draft (the point is to see it before activating) and reads nothing a
  run could not read; it calls no model.
- The initiative list carries `origin` for each kind, read under your current
  access (`available: false` when you can no longer read it).
- `GET /api/app/assistant/access` tells the portal whether the `sources`
  capability is yours; the draft form offers these choices only then.

## Not built

- Steering ("never mind", "instead") in personal chat; steering stays in
  project conversations and discussions.
- DM channel chats with the Discord bot as a source (only portal chats).
- A cap that is configuration (it is a constant; DA-10 scales it).
- A run being offered only the tools its grant allows: the dispatch check
  refuses the rest, and changing what a run is offered would need every
  refusal test to change with it.
- `fix`-mode CI watches are not noticed (the watch owns them).
- Weights and ranking (DA-10).
