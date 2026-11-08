---
title: Server schedules (the operator's pause, resume, run-now and delete)
kind: reference
summary: Host → Schedules lists every automation and reminder that posts into a Discord server, whoever owns it, and lets an operator pause, resume, run now or delete it. Personal DM and Inbox tasks are never listed or changeable; every change writes an operator_audit row with ids only and tells the owner in their Inbox.
when: A recurring automation or reminder keeps posting into a server and its owner will not or cannot stop it; finding out what is scheduled across the servers Goobster is in; checking what the operator can and cannot do to someone else's scheduled work.
tags: [operations, automations, followups, schedules, operator, audit, privacy]
---

# Server schedules

An owner manages their own automations (`/automation`, the Tasks pane, the `manageAutomations` tool) and reminders (the `scheduleFollowUp` tool, the Tasks pane). Nobody else can. When a recurring job keeps posting into a server and its owner will not turn it off, the installation's **operator** (an account with `role = operator`; Discord *Manage Server* never confers it) can manage it from **Host → Schedules** (`/host/schedules`).

## What is listed

Only rows that post into a server channel:

- `automations` rows whose scope is a guild id and whose channel is not `inbox:<userId>`. This includes the jobs `/wrapped schedule`, `/digest` and the Daily Wheel create (labelled *Server Wrapped*, *Channel digest* and *Daily Wheel*).
- `followups` rows that are still `PENDING` in a guild channel, recurring or one-time.

**Never listed, never changeable:** anything keyed on the DM scope `dm:<userId>` or delivered to `inbox:<userId>`. Those are a person's private tasks. Every action re-checks this and answers `403 NOT_GUILD_SCOPE`.

**Never sent to the browser:** an automation's prompt text. The panel shows the name, a kind label, the owner, the server, the channel, the cadence (cron in UTC, or the reminder's recurrence label), the last and next run, the delivery count and the status. A reminder also shows its note clipped to 120 characters, because that note is what gets posted to the channel.

Not covered: project cron triggers (they belong to a user's private project) and the per-server `/proactive` heartbeat.

## What an operator can do

| Row | Pause | Resume | Run now | Delete |
| --- | --- | --- | --- | --- |
| Automation | yes | yes | yes (while active) | yes |
| Recurring reminder | yes | yes | yes (while active) | yes (cancels the series) |
| One-time reminder | no (`UNSUPPORTED`) | no | yes | yes (cancels it) |

- **Pause** an automation sets `isEnabled = 0` and clears `nextRun`, exactly what `/automation toggle` does. Pausing a recurring reminder sets `followups.pausedAt`; `followupService.getDue()` skips paused rows, so the delivery tick never sends them. The row stays `PENDING`.
- **Resume** recomputes an automation's `nextRun` from its cron. A reminder's `pausedAt` is cleared and a `dueAt` that passed while paused moves to the next future occurrence, so **nothing fires late**; a `dueAt` still in the future is kept.
- **Run now** makes the row due now. For an automation it sets `nextRun` to the current time; the poll loop's atomic claim (`automationService.claimDueRun`) then runs it within a minute and advances `nextRun` to the next cron slot, so its schedule is unchanged. A reminder's `dueAt` is set to now and delivery moves its cadence anchor from there. Guild runs and guild-channel reminders are delivered by the bot process; with the bot unreachable they wait (the panel says so).
- **Delete** removes an automation row. A reminder is cancelled (`status = CANCELLED`), which ends the whole series and keeps the row's history.

A paused row cannot be run (`409 PAUSED`); pausing a paused row is `409 ALREADY_PAUSED`; resuming one that is not paused is `409 NOT_PAUSED`; an automation whose stored cron no longer parses cannot resume (`409 BAD_SCHEDULE`).

## Routes

All behind `requireAuth` and `requireOperator` in `packages/core/web/routes/admin.js`:

- `GET /api/app/admin/schedules?guildId=&kind=automation|followup&status=active|paused` returns `{ schedules, guilds, botOnline }`. Server and owner names come from the Discord gateway when it is reachable and are `null` (the id is shown) otherwise.
- `POST /api/app/admin/schedules/:kind/:id/pause|resume|trigger`
- `DELETE /api/app/admin/schedules/:kind/:id`

The logic is `services/operatorScheduleService.js`; automations go through the id-addressed `automationManagerService.setEnabledById`, `removeById` and `triggerNow`, so cron handling stays in one place.

## Audit and notice

Each successful change writes one `operator_audit` row (`schedule.pause`, `schedule.resume`, `schedule.trigger`, `schedule.delete`) with the operator as `actor`, `target` = `<kind>:<id>` (for example `automation:12`) and `detail` = `{ kind, guildId }`. No name, prompt or note is ever in the ledger. A refused action writes nothing.

Pausing or deleting also files a `system` Inbox item for the owner ("The host paused one of your scheduled tasks"), so a change is never silent. The notice is best-effort and never blocks the change. The owner's Tasks pane shows a paused reminder as "paused by the host" and a paused automation as disabled.

## Adding a new kind of scheduled work

A scheduler that keeps its own "next time" in the database must be reachable from `skipMissedSchedules()` (backup and restore) **and** from this panel's service, with the same guild-facing guard and an audit action.
