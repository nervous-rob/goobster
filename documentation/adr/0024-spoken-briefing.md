# ADR 0024: The spoken briefing is the Home projection read aloud by a tool, only to the person alone, and it records delivery only

## Status

Accepted for DA-7c of the
[delegated assistant plan](../delegated_assistant_implementation.md): the
spoken briefing. It builds on
[ADR 0017](0017-initiatives-updates-processes.md) (canonical updates, and
receipts that keep delivery apart from acknowledgment) and
[ADR 0023](0023-conversational-delegation-and-receipts.md) (where the
delegation tools answer, and the rule that a model call confirms nothing).
Behaviour is documented in
[delegated_conversation.md](../delegated_conversation.md#hearing-a-briefing).
The code is `packages/core/services/assistant/spokenBriefing.js`, the
`spokenBriefing` tool in `packages/core/utils/tools/assistant.js` and
`getVoiceToolDefinitions` in `packages/core/services/voice/voiceTurnShared.js`.

## Context

The plan asks for "a voice intent" that reads `assistantHomeService.project`,
speaks the counts, the Needs-you titles and up to three findings, calls no
acknowledgment route, and is never spoken in a shared guild voice channel.
Its acceptance is one sentence: a spoken briefing reports the same counts as
Home and acknowledges nothing.

Three facts about the code shaped the decision:

- **There are two voice paths, and only one is private.** The portal's voice
  chat is an ordinary turn of the person's own chat with `spoken: true`. A
  Discord `/voicechat` session lives in a guild voice channel: everyone in
  the channel hears the reply, and the reply is also posted as a transcript
  in a text channel.
- **Voice has no intent layer.** A voice turn is a chat turn: the model
  chooses tools, and tool-calling goes through `runAgentLoop`. The house
  rule is to extend that loop, not to add a second way to run tools.
- **A model that summarizes can miscount.** If the model were handed the
  projection and asked to describe it, "the same counts as Home" would
  depend on the model.

## Decision

### 1. The intent is a chat tool with no arguments

`spokenBriefing` is a fourth tool of the `assistant` feature. It takes no
arguments, so nothing a model passes can choose whose Home is read, ask for
more, or ask for anything to be marked. It runs inside `runAgentLoop` like
every other tool.

### 2. The server writes the words

`compose(projection)` is a pure function from the Home projection to
sentences: the status line, the Needs-you count and up to five titles (the
number Home previews), the count of updates not reviewed and up to three
findings (title and first sentence), what is running, and how many processes
are not working or running with a problem. A count the projection could not
read (`null`) is said to be unknown and never as zero. Titles are reduced to
words: no link, markup or line break. The tool returns those sentences and
tells the model to say them as given. The numbers are the projection's, not
the model's.

### 3. It is said only to the person alone

The tool is offered only when the turn is spoken, and it answers only where
the other delegation tools do (ADR 0023): the speaker's own conversation,
attended, not incognito, with the feature on and the pilot gate open
(`assistantAccessService.allows(userId, 'conversation')`).

A Discord voice session is treated as shared, always, whoever is in the
channel at that moment. The tool is still given to such a session, for one
reason: so the model has a truthful refusal to give instead of improvising
one. It answers `NOT_PRIVATE` before the projection is read, and the refusal
tells the model to say nothing about the person's delegated work, not even
whether there is any. A written turn is not offered the tool;
`describeDelegatedWork` answers there.

Voice sessions previously gave the model every tool on the voice list. They
now filter that list through each tool's `offered` check, as chat does. A
check that cannot be made hides the briefing and the turn goes on.

### 4. Hearing it is delivery, and nothing else

`brief()` calls `assistantUpdateService.markDelivered` for the updates the
briefing named. That sets `deliveredRevision` on the person's receipts and
nothing else. No code path from the tool reaches `acknowledge`, the Inbox's
read state, a snooze or a gate decision. If recording delivery fails, the
briefing is still returned.

A briefing is not a contact (DA-9): the person asked for it. It uses none of
the daily contact cap and does not mark an update as having left the portal,
so an update heard in a briefing can still appear in that day's digest.

## Consequences

- Home's counts and the briefing's cannot differ at the moment of asking:
  both are one call to `project()`. A change to the projection (as when
  process health became two counts) needs `compose` to follow, and its test
  compares against `project()` so it fails when it does not.
- There is no spoken briefing in Discord today, because Discord has no voice
  session that belongs to one person. A future one would mark its turns
  `spoken: true` outside a guild context and would get the briefing with no
  further change.
- A speaker outside the pilot is no longer shown the tool in a voice
  session, and any later voice tool with an `offered` check is filtered the
  same way.
- The briefing stores nothing of its own, so there is no new privacy path.

## Alternatives considered

- **Let the model summarize `describeDelegatedWork` or the raw projection.**
  Rejected: the acceptance is exact counts, and an unread section would be
  easy to narrate as "nothing".
- **Detect the request by matching the transcript and bypass the model.**
  Rejected: it adds a second dispatch path next to `runAgentLoop`, and it
  would mishear paraphrases the model already understands.
- **Allow the briefing in a Discord voice channel when the speaker is alone
  in it.** Rejected: someone can join mid-sentence, and the transcript is
  posted to a text channel others read.
- **Do not offer the tool in Discord voice at all.** Rejected: asked "what
  needs me?", the model would answer from whatever else it has. A refusal
  written by the server is the safer answer.
- **Mark what was heard as reviewed.** Rejected by ADR 0017 and the plan:
  hearing is not reviewing, and a request still needs a decision.
