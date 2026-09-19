---
title: Project examples
kind: skill
summary: Worked examples of things you can build with users - one-off diagrams, checkpointed Observatory simulations, data dashboards, recurring digests, research expeditions, Parlor salons, Tavern campaigns - each with the surface to use, a starter brief, and the guardrails that apply.
when: A user wants to build, run, simulate, analyse, automate, or research something with you and you need to pick the right surface and shape the first step.
tags: [projects, examples, observatory, sandbox, automations, spitball, parlor, tavern, templates]
---

# Project examples

Pick the surface first; the rest follows. Every capability below is optional on
a deployment - if the tool is not in your list, read *Troubleshooting tactics*
before proposing it.

## Choosing the surface

| The user wants | Use | Because |
|---|---|---|
| A quick answer that needs computation or a picture, once | `runCode` | Resource-limited sandbox run; files come back inline |
| Something that should persist, iterate, or run longer than one call | `observatory` (a **project**) | Workspace + versioned assets + checkpointed background jobs + dashboard |
| The same work on a schedule ("every morning", "hourly") | `manageAutomations` | Durable cron automation; each run is a full agent turn with tools |
| To know when an outcome happens ("tell me when it finishes") | `watchFor` | Fires one turn on a condition; never poll with an automation |
| Autonomous research over a topic with sources and notes | Spitball **Expedition** (portal: Spitball → Expeditions) | Pipeline with source review, legalized notes, budgets |
| Several viewpoints debating one topic | `manageParlor` `quickstart` | Multi-persona salon grounded in per-persona notes |
| A tabletop adventure | `/tavern`, `/adventure`, the `tavern*` tools | Deterministic rules + authored prose; AI narration optional |
| A reminder with no work attached | `scheduleFollowUp` | Reposts a note; runs no tools |

## Example 1 - a diagram in one call (`runCode`)

Brief: "Draw the logistic map bifurcation diagram for r in [2.5, 4]."

- Language `python`; the tool description tells you which modules exist
  (numpy/matplotlib when the curated toolkit is installed, standard library
  only otherwise). Write for what is there.
- Save the figure to the working directory (`plt.savefig('bifurcation.png')`);
  every produced file is attached to the reply.
- No network, bounded CPU/time/memory. If `ModuleNotFoundError` appears, retry
  once against the modules the note lists - do not guess a third time.

## Example 2 - a long simulation with checkpoints (`observatory`)

Brief: "Run a 10⁶-step Lotka-Volterra sweep overnight and show me the phase
portraits."

1. `create-project` with a clear name; the reply restates the layout contract.
2. `save_script` (language `python`) that follows the **checkpoint convention**:
   load `$GOOBSTER_RUN_DIR/checkpoint.json` if present, work in segments, rewrite
   the checkpoint as it progresses, write frames to `$GOOBSTER_RUN_DIR/frames/`,
   exit 0 when done. A segment killed at the timeout only resumes if the
   checkpoint advanced.
3. `run_script` with `background: true`; note the job id.
4. `watchFor` `arm` on `observatory.job_completed` narrowed to that `jobId`,
   with a prompt that says what to inspect and what hypothesis to check. Do not
   create a polling automation.
5. When it fires: `status`, `files`, `read` the results, `render` the frames into
   a video, and `dashboard` for the shareable summary. Distill what was learned
   with `note_knowledge` so the project remembers.

Guardrails: one active job per user by default, per-project disk quota,
`maxResumes`; all in *Projects → Limits*.

## Example 3 - real data in, dashboard out

Brief: "Pull this CSV of monthly temperatures and build a little explorer."

1. `fetch-data` with the https URL. Allowlisted hosts download at once; anything
   else becomes a pending request for the deployment's approvers - tell the user
   it is waiting rather than retrying.
2. `save_script` that reads `$GOOBSTER_PROJECT_DIR/data/<file>` and writes tidy
   outputs; `run_script` foreground for small data.
3. `save_app` (language `html`) for the explorer - it renders in the portal's
   applet sandbox and may read the project's own files through the applet
   bridge (*Projects → Own-project reads*).
4. `dashboard` regenerates the results page; the owner can mint a read-only
   share link in the portal.

## Example 4 - a recurring digest (`manageAutomations`)

Brief: "Every weekday at 9am Eastern, summarise what changed in the lab channel."

- Convert the time to **UTC** (say the conversion back: 9am ET is 13:00 or
  14:00 UTC depending on DST - ask which they want, or pick and state it).
- `create` with a prompt written as an instruction that stands alone on every
  run: *"Read the last day of #lab, list decisions, blockers, and open
  questions, and post a five-line status."* Each run is a full turn with tools.
- `list` afterwards to show schedule and next run. A recurring **reminder** with
  no work is `scheduleFollowUp` with `repeat` instead.

## Example 5 - a research expedition (Spitball)

Brief: "Find out what is known about tidal locking timescales for sub-Neptunes."

- Expeditions are started from the portal (Spitball → Expeditions). Help the user
  write a **seed** that names the question, the scope boundary, and what a good
  answer looks like; a *focused* run completes in about a minute with real keys.
- The pipeline works from Wikipedia alone when no Perplexity key exists; say so
  if source breadth looks thin.
- Results land as legalized notes in the graph with source provenance; the user
  can arm a `watchFor` on completion.

## Example 6 - a salon of viewpoints (`manageParlor`)

Brief: "I want to stress-test my startup pitch."

- `quickstart` with the brief: the concierge designs two to four personas with
  seed notes and opens a discussion. Then `overview`, and offer `invite-user` to
  bring a Discord friend into the discussion.
- The parlor is personal (DMs / portal); it never deletes anything from chat -
  point at the portal for that.

## Example 7 - a custom Tavern campaign

Campaigns are YAML under `campaigns/`; a server operator drops overrides into
`data/tavern/campaigns/`, validated on load. The game is fully playable without
an AI key; narration is the optional layer. Help the user author scenes, checks,
and outcomes in the shape of an existing campaign file (`consultDocs`
`read` *The Goobster Tavern + Adventure Mode*).

## Example 8 - teaching yourself about a deployment

Operators can drop Markdown notes into `data/self-docs/` (for example "our
production box", "who to ping for the Postgres volume", house rules). They are
seeded next to the shipped docs and come back from `consultDocs` like any other
document. Suggest this when a user keeps re-explaining local conventions.

## What a good brief looks like

- **Outcome**, not activity: "a phase portrait per parameter value", not "run
  some code".
- **Boundaries**: data size, time budget, what is out of scope.
- **Where it lives**: one-off reply, a named project, or a schedule.
- **How we know it worked**: the check you will perform before reporting.

Restate the brief in that shape before the first tool call; it is the cheapest
error-prevention there is.
