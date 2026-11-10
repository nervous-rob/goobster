---
title: Delegated work - the pilot record (thresholds, cycle record, exit decision)
kind: guide
summary: The template the owner fills in during the personal pilot of delegated work - the thresholds recorded before any result is judged, the setup in force (project, responsibilities, caps, prompt and model), one record per cycle with where each figure is read from, and the exit decision that keeps, narrows, widens or stops delegated work and says whether the pilot capabilities are opened to everyone.
when: Recording the personal pilot of delegated work; writing down thresholds before judging it; filling in a pilot cycle from the outcome summary; recording the exit decision before opening the pilot capabilities to other people.
tags: [assistant, responsibilities, delegation, pilot, record, template, thresholds, outcomes, host]
feature: assistant
---

# Delegated work: the pilot record

A template. Copy this file somewhere of your own (a project file, a note, a
document outside Goobster) and fill the copy in; the copy in the
documentation stays empty. How to run the pilot is in
[delegated_pilot.md](delegated_pilot.md).

Nothing in the product reads this record. The one thing the installation
itself records is the decision to open the pilot capabilities to everyone
(Host → Delegated work).

Never count notes created, tool calls or time spent as success.

## Thresholds

Write these **before** looking at any result. A threshold chosen afterwards
is not one.

| Measure | Keep it if | Narrow it if | Stop if |
| --- | --- | --- | --- |
| Checked results per cycle (plan steps verified, repairs that held) | | | |
| Findings you accepted as useful, out of those reported | | | |
| Corrections and rollbacks you had to make | | | |
| Unwanted actions (anything done that you would not have approved) | | | |
| Cost per useful result (tokens, and money at your provider's price) | | | |
| Interruptions per day outside the portal | | | |
| Requests you had to answer per cycle | | | |
| Chat responsiveness while background work ran | | | |

Recorded on: ____ (date), by: ____

## Setup

| | |
| --- | --- |
| Installation and version (or the commit) | |
| Project | |
| Cycle length, and how many cycles are planned | |
| Rehearsal (`npm run pilot:rehearsal`): date, checks passed, prompt version | |
| Evaluation set, if run ([delegated_evaluation.md](delegated_evaluation.md)): date, cases passed, cost | |
| Caps in force (Host → Delegated work): `installationRuns`, `runsPerAccount`, `defaultModelTokens`, `defaultSearches`, `defaultComputeSeconds`, and which the host set | |
| Attention: initiative level, quiet hours, DMs per day, minutes between DMs, digest time, boundaries changed from their defaults | |
| Outside services connected (Notion page or database, GitHub), and what each may be used for | |

One row per responsibility:

| Responsibility | Revision | May (operations and resources) | Sources | Daily limits (tokens, searches, compute, outside writes, repair attempts) | Updates reach me by | Starts work automatically | Ends |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Keep important knowledge current | | | | | | | |
| Advance approved work | | | | | | | |
| Keep its processes healthy and useful | | | | | | | |

## Cycle record

Copy this section once per cycle. The figures come from **What your
responsibilities did** on the Responsibilities page, with the period set to
the cycle ([where each line is read](delegated_pilot.md#recording-a-cycle)).

Cycle: ____ of ____, from ____ to ____

| Measure | Record |
| --- | --- |
| Responsibility and policy version | Resources, allowed actions, limits, review boundaries; the revision of each responsibility, and what changed since the last cycle |
| Trigger and authority | Human instruction or source change; why the work was eligible |
| Expected and actual useful result | Checked results (plan steps, repairs); findings reported, and of those the ones you said were useful, already known or wrong, and your judgement of the ones you gave no answer on; corrected assumptions; justified no-ops |
| Actions and consequences | Note, project and process changes; outside writes; what was undone or rolled back, and whether rollback was available |
| Human effort | Requests asked, answered and still waiting; approvals; corrections; anything you had to start or orchestrate by hand |
| Delivery | Updates on Home; digests and contacts actually sent; duplicates; anything irrelevant or badly timed (the times you said *Wrong time*) |
| Resources | Tokens, searches, compute; tokens per checked result; held or estimated figures noted |
| Model and prompt version | Provider and model id of the runs, and the prompt version label (`v<version>-<fingerprint>`), from the summary's "Ran on" line |
| Caps in force | The five caps, and which of them the host set |
| Reliability | Refused calls by code, runs stopped before a result, writes left to check, failures, revoked access, concurrent edits, retries, unwanted actions |
| What it learned | Sources slowed by your answers or by what you dismissed and ignored, hours marked as a wrong time, and anything you reset |
| Foreground responsiveness | Whether chat stayed responsive while background work ran (your own observation; nothing measures it) |
| Against the thresholds | Which were met, which were not |
| Decision | Keep the policy, narrow or widen it explicitly (say what changes), repair the machinery, or stop |

## Exit decision

| | |
| --- | --- |
| Date, and who decided | |
| Cycles recorded | |
| Thresholds met and missed | |
| Decision for your own use | Keep / narrow / widen / stop, and exactly what changes |
| Caps saved in Host → Delegated work | |
| Pilot capabilities | Stay with the host / **Open to everyone** pressed on ____ |
| Conditions on opening to other people (limits, capabilities left off, what to watch) | |
| What has to be repaired or built first | |
| When this decision is reviewed again | |
