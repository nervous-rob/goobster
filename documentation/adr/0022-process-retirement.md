# ADR 0022: A process is retired in separate, reversible stages; archive never deletes and cleanup removes only a previewed manifest

## Status

Accepted for DA-5b of the
[delegated assistant plan](../delegated_assistant_implementation.md): pause,
resume, archive, restore and exact cleanup of recurring processes. It builds
on [ADR 0020](0020-process-assessment-and-incidents.md) (the assessment that
says a process's purpose is over), [ADR 0016](0016-delegated-responsibilities.md)
(`authorize()` and the `process.*` operations) and
[ADR 0017](0017-initiatives-updates-processes.md) (canonical updates and
gates). Behaviour is documented in
[process_stewardship.md](../process_stewardship.md#retiring-a-process). The
code is `packages/core/services/assistantProcessLifecycleService.js`, four
`steward*` methods on each owning service (`automationManagerService`,
`projectTriggerService`, `attentionWatchService`, `followedSourceService`),
the `process_retirement` descriptor in `assistantGateDescriptors.js`, and the
`lifecycle.steward()` step inside `assistantIncidentService.reconcile()`.

Repair through runs is DA-5c and is not part of this decision.

## Context

DA-5a could say "this process's purpose is over and it is still switched on"
and could do nothing about it. The only way to stop a process was the switch
or the delete where it was made, and those have three problems for
stewardship:

- **The existing remove paths delete history.** Removing an automation, a
  trigger or a followed source deletes the definition and, by cascade or by
  retention, what it recorded. Retirement that starts with a delete cannot be
  undone and cannot be delegated safely.
- **A switch is not a fence.** Each kind is launched by its own scheduler:
  a cron claim, an event claim, a watch fire, a source claim. Setting a flag
  from outside does not say what happens to a launch that is between its
  claim and its work, or to work that has already started.
- **"Clean up" is not a boundary.** Without an exact list, a cleanup can
  only be described by intent ("its old data"), which is how shared or kept
  material gets deleted.

## Decision

1. **Four stages, each its own decision.** `ACTIVE -> PAUSED -> ARCHIVED ->
   CLEANED`. Archive requires a process that is already off; cleanup requires
   one that is archived. No call skips a stage, and no stage implies the
   next.

2. **The definition never leaves its table.** Archive sets `archivedAt` on
   the row in `automations`, `project_triggers`, `attention_watches` or
   `followed_sources`. Nothing is copied to an archive table and nothing is
   deleted. Restore clears the column. The existing remove APIs are not
   called by any stage.

3. **The fence lives where the launch is claimed.** Each owning service
   implements `stewardPause`, `stewardResume`, `stewardArchive` and
   `stewardRestore`. Pause clears the switch the service's own launch claim
   already tests in its `WHERE` (`isEnabled = 1`, `enabled = 1`; a watch
   gained `pausedAt IS NULL`, because its `status` also says whether it has
   fired). A pause and a claim are single statements on the same row, so one
   of them wins; there is no window in which a launch has been decided and
   the pause has not been seen. An event trigger's fire became one atomic
   claim (`claimEventFire`) for the same reason. The lifecycle service never
   writes a process table.

4. **Archived means off, and it cannot be switched on from any path.**
   Archive is only accepted for a row that is already off, so an archived
   row never passes a launch claim. Every path that switches a process on
   (the portal's task and source toggles, `/automation`, the chat tools, a
   trigger update, `stewardResume`) refuses an archived row with its own
   typed error, and the enabling write itself carries `archivedAt IS NULL`,
   so the refusal does not depend on the check before it.

5. **Work already started has a stated fate per kind.** A scheduled task's
   run, a project job a trigger launched and a watch's turn **finish**. A
   followed-source check is **abandoned**: its claim token is cleared, so
   whatever it fetches is not stored. Deliveries of an event trigger that
   were waiting to be retried are dropped and recorded as skipped. The pause
   returns the count and the policy, and the row keeps them.

6. **A started run is evidence, not an inference.** Scheduled tasks had no
   record between claim and outcome, so a run under way could not be
   counted. A run now records a `dispatch` observation with reason
   `STARTED` before it works and its `outcome` after. A start with no
   outcome inside one hour is a run under way. Trigger and watch work is
   counted from their own rows.

7. **Restore returns paused; resume is checked when asked.** Restore never
   switches a process on. Resume checks, at that moment, that the person
   still reaches the project, that every process it depends on is switched
   on, and (in the owning service) that the definition is still valid. Events
   that settled while an event trigger was paused are recorded as skipped,
   not replayed.

8. **The stewardship row records; the process tables decide.**
   `assistant_process_lifecycle` holds who acted, under which
   responsibility, why, when, what was under way, how the process stood when
   archived (states, codes and times only) and what a cleanup removed. It
   carries a `revision` for optimistic concurrency. Whether a process can
   run is decided only by its own row, so losing or erasing the stewardship
   tables cannot start anything.

9. **Stewardship follows the person, it does not fight them.** If a paused
   process is switched back on where it was made, the next read moves the
   stewardship row to `ACTIVE` (`RESUMED_ELSEWHERE`). A process switched off
   natively, with no stewardship pause, is resumed natively
   (`NOT_PAUSED_HERE`).

10. **Cleanup is a frozen manifest of row ids.** Preview selects the exact
    ids it would delete and stores them with a sha256 over the process
    reference, the lifecycle revision, the contract revision, a hash of the
    definition and the ids. Apply takes the manifest id and hash, refuses
    one that is expired, superseded or made against anything that has since
    changed, and deletes `WHERE id IN (...)` with the ownership predicate
    repeated in every statement. It reports what it removed and what it
    skipped. Applying twice is a no-op.

11. **Cleanup reaches only what the process alone derived.** Its
    observations; for a followed source, fetched entries that were not kept
    and that no research run started from, and the cached page text. The
    definition, the contract, Inbox results, kept and research-linked
    entries, trigger deliveries and the jobs a trigger started are counted
    in the preview as kept and are never in a manifest.

12. **Dependents are checked at apply time.** A cleanup is refused while a
    process that is not archived depends on this one. Pause and archive name
    the dependents and do not touch them. The assistant does not pause a
    process that a switched-on process depends on; it asks.

13. **The assistant acts only under an exact grant, checked at the change.**
    On the steward pass, for a `retirement_candidate`, it looks for an
    `ACTIVE` responsibility that names `process.pause` on that reference,
    probes it with `permits()` and then calls `authorize()`
    immediately before the pause. `authorize()` applies the Attention
    boundary: `process.*` is compute on the `schedule` category, which is
    off by default. It archives only a process it paused itself as a
    retirement (`reasonCode` begins `RETIRE_`), after seven days paused, with
    the purpose still over, under `process.archive` checked the same way. It
    never resumes, restores or cleans up.

14. **Without a grant it asks once.** The relevance update gains a gate,
    `{ kind: 'process_retirement', id: <ref>, occurrence }`. It is one
    update per process (`process_relevance:<ref>`), revised when the
    assistant pauses or archives, and its gate is resolved when the person
    pauses, archives or keeps the process, or when the reason goes away. A
    request asked again after it was answered is a new occurrence.

15. **"Keep it running" is an answer and is remembered.** It records the
    contract revision and the reason it answered. The same question is not
    asked, and the process is not paused, until one of them changes.
    Resuming a process whose purpose is over records the same answer.

16. **The request is decided in place through the same act.** The
    `process_retirement` descriptor offers *Pause it* and *Keep it running*
    on Home and in the Inbox and calls `lifecycle.act()`, the call the
    Processes list makes. Its card revision includes the lifecycle revision,
    so a card that is out of date is refused.

17. **No model, no chat tool.** Every transition is deterministic code. No
    tool lets a model pause, archive, restore or clean up a process.

## Defaults taken

Where the plan left a choice open, this takes the conservative one: slower
to act, narrower in what it removes, and never automatic without a grant.

| Question | Default | Why |
| --- | --- | --- |
| Running work at pause | Finish, except a source check, which is abandoned | Interrupting a run mid-write is the riskier outcome; a source check has no partial result worth keeping |
| Replay after resume | None: events settled while paused are skipped | A resume must not start a burst of old work |
| What a cleanup may remove | The process's own observations; a source's unkept, unresearched entries and cached text | Everything else is delivered, kept, shared or owned by another feature (IMPL "Decisions still requiring", item 4) |
| Cleanup by the assistant | Not available; `cleanup.exact` is granted and unused | Removal is the one step that cannot be undone |
| Assistant archive delay | 7 days paused, purpose still over, own retirement pause only | Gives the person a week to notice the pause and resume |
| Dependents at assistant pause | Ask instead of pausing | Pausing an upstream process blocks others |
| Manifest lifetime | 1 hour | Long enough to read a preview, short enough to stay true |
| Manifest size | 5,000 ids per type | Bounded statement and row size; more takes a second cleanup |
| Unopened results | Never a reason to pause or ask | SPEC section 8 |
| Attention off | The person's own actions work; the assistant asks nothing and pauses nothing | Same gate as incidents (ADR 0020, decision 15) |
| Stewardship rows of a running process | Pruned 180 days after their last change | Matches incidents and updates |

## What is deliberately not here

- **Repair** (DA-5c), including a `process_repair` decision descriptor, a
  process source adapter for initiatives, and enforcement of a repair
  attempt cap.
- **Cleanup under `cleanup.exact`.** The manifest and apply path exist; an
  assistant caller, with its own grant check and report, does not.
- **Declared owned artifacts.** A contract cannot yet name files or notes a
  process owns, so cleanup cannot reach a workspace or the knowledge graph.
- **Permanent deletion.** No stage deletes a definition. The person's own
  delete where the process was made is unchanged.
- **Target-ended codes.** Still no producer of `TARGET_MERGED` and its
  siblings; a watch becomes a candidate through its linked goal or its fire
  limit.
- **Pausing a responsibility's own initiatives or runs.** Those have their
  own lifecycle (ADR 0018).

## Consequences

- Every write that switches one of the four kinds on now carries the
  archive test. A new enabling path for one of them must carry it too; the
  lifecycle tests fail if an archived row can be switched on or claimed.
- A scheduled task writes two observation rows per run instead of one. The
  assessment groups by occurrence and reads the `outcome` phase, so health
  is unchanged.
- The relevance message became a request. Home shows it under Needs you, not
  under What changed, and the Processes card counts it as needing the person.
- A fifth process kind must supply the four `steward*` methods, a launch
  claim that tests them, and a started-work policy before it can be retired.
- The two new tables are per-person data and are in the transparency report,
  the account export, erasure and the dormant-data inventory.
