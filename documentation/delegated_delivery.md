---
title: Delegated delivery (live updates, the interruption rule, the daily digest)
kind: reference
summary: How delegated work reaches you. Home and the Responsibilities page change while they are open, through an `assistant` event on the portal stream that carries kinds and refetch hints only. Each responsibility has an interruption rule - `home` (nothing leaves the portal, the default), `digest` (one digest a day) or `immediate` (one contact per request that needs your decision; findings still go in the digest). Every digest and contact goes through Attention's `requestContact()`, so quiet hours, the daily contact cap and the cooldown apply and Attention's own notices spend the same budget. A push or a DM records delivery, never review. Covers the digest time setting, what is stored (`assistant_digests`, `attention_contacts`), the pilot gate and the defaults chosen.
when: Understanding why Home changed by itself, or did not; choosing how a responsibility's updates reach you; why a digest or a contact did or did not arrive (quiet hours, CONTACT_CAP, COOLDOWN, NO_CHANNEL, ATTENTION_OFF, PILOT_ONLY); setting the digest time; checking that turning Attention off stops outbound contact; calling `attentionService.requestContact()` from a new producer; publishing `assistant.changed`.
tags: [assistant, responsibilities, delivery, digest, interruption, attention, push, portal, privacy]
feature: assistant
---

# Delegated delivery

Everything delegated work produces is on [Home](assistant_home.md) and has
one item in the Inbox. This page is about the two things on top of that:
the pages changing while you look at them, and whether an update also
reaches you outside the portal.

Until the host records the pilot decision
([delegated_operations.md](delegated_operations.md), "The pilot gate"),
everything on this page is available to the installation's owner only.
Other accounts keep what they had: Home and the Inbox, read when opened.

## Live updates

Home and the Responsibilities page change without a reload when:

- a finding or a request is filed, revised, reviewed, snoozed or resolved;
- a piece of work is proposed, started, cancelled, retried or finished;
- a run starts, makes progress or ends;
- a responsibility is created, edited or changes state.

How it works:

1. The service that made the change calls
   `assistantLiveService.changed(userId, kinds)`. That publishes
   `assistant.changed` on the domain event bus with
   `{ userId, kinds }`, where each kind is `update`, `initiative`, `run` or
   `gate`. There is no title, no text and no id of the thing that changed.
   A project update is announced to the project's owner and current members.
2. The portal event stream (`GET /api/app/events`) forwards it to that
   person's own sessions as an `assistant` event:
   `{ kinds, invalidate, at }`. `invalidate` is a list of query names
   (`home`, `assistant-responsibilities`, `assistant-initiatives`, `inbox`
   when an update or a request changed, and `assistant-processes` when an
   update changed, since it may be a process incident; a process that is
   paused, resumed, archived, restored or cleaned up is announced as an
   `update` too, so the Processes report follows it).
3. The client reads those again through the ordinary routes, which check
   the session and what it may see on every read. The event is a reason to
   look, never the data.

Limits:

- **At most one event every five seconds** per person and stream. The first
  change of a burst is forwarded after 300 ms (the change is announced from
  inside its transaction, so the read must not race the commit); changes
  after that are collected and sent as one event with the union of their
  kinds. A burst always ends with one event, so the last state is fetched.
- Run progress is announced at most once per run every five seconds.
- The stream rechecks the session before every event it writes; a revoked
  session gets `session-revoked` and nothing else.
- The pilot gate and the feature state are asked again before every
  forwarded event, so a decision taken back, or the feature turned off,
  stops the events on streams that are already open.
- **After a reconnect** the client reads Home, the Responsibilities page
  and the Inbox again. Nothing is replayed: what changed while the stream
  was down sent no event, and the refetch is what catches up.
- The event never makes Attention sweep. It is a display signal.

The Responsibilities page also reads its work list every 15 seconds, which
covers an account the events do not reach.

## The interruption rule

Each responsibility has one rule, `rules.interruption`, chosen in the draft
form ("How should its updates reach you?"), restated in the activation
confirmation and shown on its row.

| Rule | A finding | A request that needs your decision |
| --- | --- | --- |
| `home` (default) | Home and Inbox | Home and Inbox |
| `digest` | Home and Inbox, and the day's digest | Home and Inbox, and the day's digest |
| `immediate` | Home and Inbox, and the day's digest | Home and Inbox, and one contact |

- **A finding never contacts you by itself.** Only a request can, and only
  under `immediate`.
- **One contact per request.** Rewording an open request does not contact
  you again. The same request raised again later (a new occurrence) may.
- **Never both.** An update that went out as a contact is not a digest
  entry, and an update listed in a digest is not contacted about. A request
  that has been waiting more than 48 hours without a contact goes into the
  digest instead.
- **The rule is read when the decision is made**, not when the update was
  filed. Changing a responsibility to `home` stops what was still waiting.
- **A paused, revoked, archived or draft responsibility sends nothing out.**
  Its updates stay on Home and in the Inbox. Resuming a paused one makes
  what is still waiting eligible again.
- An update that belongs to no responsibility never leaves the portal.
- Updates you have already reviewed, snoozed requests, and updates older
  than 7 days never go out.
- Filing the Inbox item is quiet: no browser notification and no Discord
  message. Whether anything leaves the portal is decided only here.

`digest` and `immediate` cannot be activated by an account without the
pilot capability: the form does not offer them, and activation is refused
with `PILOT_ONLY` (409).

## The daily digest

- **At most one a day** per person. `assistant_digests` holds one row per
  person and day, so a second cannot be sent.
- **An empty day sends nothing** and records nothing.
- It goes out once your **digest time** has passed, on the steward's next
  pass (every five minutes), and holds what was waiting at that time.
  Updates that arrive later are tomorrow's.
- **Digest time** is Settings → Initiative → *Daily digest*. The default is
  **09:00**. It is on the clock your quiet hours use: your timezone when
  quiet hours are set to local, otherwise UTC. Stored as
  `attention_policies.digestMinute` (minutes from midnight; `NULL` is the
  default).
- The digest is one Inbox notice ("3 updates from your delegated work")
  listing up to ten titles, marking the ones waiting for your decision, and
  linking to Home. Each update keeps its own Inbox item.
- It is sent through the contact path below and **counts as one contact**.
  If your quiet hours, cap or cooldown hold it, it is given back and sent on
  a later pass the same day; if the day ends first, those updates are in the
  next day's digest (for up to 7 days).

## One contact path

Delegated work has no channel of its own. A digest and a contact both go
through `attentionService.requestContact()`, which is also what Attention's
own notices use:

```js
await attentionService.requestContact({
    userId, reason: 'assistant',
    updateId,            // or refId
    inboxItemId,         // echo an item that is already in the Inbox
    item,                // or file a new one (inboxService.deliver() shape)
    urgent: false, gateway
});
// -> { contacted, attempted, code, inboxItemId }
```

It applies, in this order, read fresh on every call:

| Refusal | Meaning |
| --- | --- |
| `ATTENTION_OFF` | Attention is off for this person |
| `OUTBOUND_OFF` | Settings → Initiative → Outbound contact is off |
| `QUIET_HOURS` | Inside the person's quiet hours |
| `CONTACT_CAP` | The daily cap is used up (default 3 in any 24 hours) |
| `COOLDOWN` | Too soon after the last contact (default 180 minutes) |
| `NO_CHANNEL` | No enrolled device and no Discord identity to reach |

A refusal sends nothing and spends nothing; the update waits and is tried
again on the next pass. The channels are the browser push and the Discord
DM echo of the Inbox item.

- **One budget.** Attention's notices and delegated contacts count against
  the same daily cap and start the same cooldown, whoever asked. Delegated
  work cannot exceed what you allowed Attention.
- For Attention's own notices the cooldown stays a cost its score absorbs
  ([attention.md](attention.md)). Delegated work has no score, so for it
  the cooldown is a hard stop.
- The budget is reserved in a transaction on the person's
  `attention_state` row before anything is sent, so two requests at once
  cannot both pass the cap.
- **Turning Attention off stops outbound contact at once**, including for
  what was already waiting. So does the host's stop-all, the Delegated
  assistant feature being off, and the pilot decision being taken back.
- Only the process that runs the steward sends. A web-only process (the
  split deployment's API) files the Inbox item and leaves the contact for
  the steward's next pass.
- No delegated contact is urgent: nothing bypasses quiet hours.

## Delivery is not review

A browser notification, a Discord DM and a digest record that an update was
**delivered** (`assistant_update_receipts.deliveredRevision`). They never
mark it reviewed. Home stays highlighted, the Inbox item stays unread and a
request stays in Needs you until you have looked or decided.

## What is stored

| Table | Holds | Kept |
| --- | --- | --- |
| `assistant_digests` | `userId`, `day`, the ids of the updates listed, the Inbox item, `sentAt` | 90 days |
| `attention_contacts` | `userId`, `reason`, a reference (an update id or `digest:<day>`), `urgent`, the Inbox item id, the Discord status, how many devices were pushed to | 30 days |
| `assistant_updates.outbound*` | Which revision and gate occurrence left the portal, how (`contact` or `digest`) and when | With the update |
| `attention_policies.digestMinute` | The digest time | With the policy |

No title, summary, message body or address is in either ledger.
`/forget-me` deletes both tables, the privacy audit counts them, the
account export includes them, and the transparency report shows the number
of contacts under Attention.

## Code

- `services/assistantLiveService.js` - `changed()`, `progress()`, `watch()`.
- `services/assistantDeliveryService.js` - the rule, `contactNow()` (called
  when an Inbox envelope is filed), `sweep()` (the steward's delivery
  step), the digest, `prune()`.
- `services/attentionService.js` - `requestContact()`, `contactAllowed()`,
  `contactChannels()`.
- `services/inboxService.js` - `deliver({ push: false })` files quietly;
  `echo()` sends the push and the DM for an item already filed.
- `web/routes/eventsStatic.js` - the `assistant` event.
- Portal: `hooks/usePortalEvents.ts`, `rooms/assistant/DraftForm.tsx`,
  `rooms/settings/InitiativeSection.tsx`.

Tests: `tests/assistantDeliveryService.test.js`,
`tests/assistantLiveService.test.js` (CI group `privacy`, both engines) and
`e2e/assistantDelivery.spec.js`.

## Defaults chosen where the plan left them open

- **Digest time: 09:00**, on the quiet-hours clock.
- **Delegated requests share Attention's daily contact cap** (default 3)
  and cooldown. There is no separate allowance for delegated work.
- The stream event carries kinds only, which is less than the "ids only"
  the plan allowed.
- The plan says the rule is evaluated when the envelope is filed. It is
  read when the contact or digest is decided, so a later change to `home`,
  a pause or a revoke applies to what is still waiting.
- The plan says an update already contacted about is "listed, not
  re-announced" in the digest. It is left out of the digest, which is what
  the acceptance criterion ("never both") requires.

## Not built yet

- "Wrong time" feedback that moves the digest or contact time (DA-10).
- A spoken briefing as a delivery (DA-7c).
- A finding shared with a project's members
  ([delegated_project_findings.md](delegated_project_findings.md)) reaching
  them outside the portal. The shared copy files no personal Inbox item, so
  it is in no member's digest and contacts nobody; members see it on Home,
  which changes while open. The person whose responsibility found it gets
  their own notice, and that one follows the rule. No increment is assigned
  to this yet.
- Deciding a request from the notification itself.
