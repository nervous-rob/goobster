---
title: Capability gaps (what Goobster could not do)
kind: reference
summary: When Goobster is asked to do something none of his tools can do, he records the missing capability with noteCapabilityGap; the operator triages the counted, anonymous backlog in the Host room.
tags: [operations, roadmap, tools, privacy]
---

# Capability gaps

Goobster is often asked for something he has no tool for: "rebase this
branch", "merge that pull request", "stream the run log here". Before this
existed he would describe a plan he could not carry out. Now he says plainly
what he cannot do, offers the closest thing he can, and records the missing
capability so the operator can see what to build next.

## How it works

- **The tool.** `noteCapabilityGap` (`packages/core/utils/tools/capabilityGaps.js`,
  owned by `core`, offered on every surface). Parameters: `capability`, a
  short generic phrase of 8-160 characters ("rebase a project clone onto
  another branch"), and an optional `area` (`projects`, `repositories`,
  `chat`, `knowledge`, `discord`, `voice`, `music`, `integrations`,
  `automations`, `portal`, `other`). The shared tool guidance
  (`utils/toolPromptBuilder.js`, *When you cannot do something*) tells the
  model to check its tools and `consultDocs` first, call the tool once, then
  tell the person what it cannot do. It is not for errors from a tool that
  exists: those already go to `work_failures`.
- **The table.** `capability_gaps`: one row per distinct capability.
  `gapKey` is the lowercased words of the phrase, so the same gap reported
  twice counts twice on one row (`hits`, `firstSeenAt`, `lastSeenAt`).
  `status` is `open`, `planned` or `dismissed`; a dismissed gap keeps
  counting but stays dismissed. At most 500 rows; once full, new gaps are
  refused while known ones still count.
- **The Host room.** *Capability gaps* on the Host overview lists the
  backlog by status, most-hit first, with Plan, Dismiss, Reopen and Delete.
  API (operators only): `GET /api/app/admin/capability-gaps?status=open|planned|dismissed|all`,
  `PATCH /api/app/admin/capability-gaps/:id` (`{ status }`) and
  `DELETE /api/app/admin/capability-gaps/:id`. Each change writes one
  `operator_audit` row (`capability-gap.status`, `capability-gap.delete`).

## Privacy

The backlog is anonymous and aggregated on purpose. There is no actor
column and no conversation text: a row is a generic capability phrase, an
area, a count and two times. Links and control characters are stripped and
the phrase is clipped. The tool description tells the model never to put
the person's request, names, content, links or data in it. Because no row
belongs to anyone, it is not on the erasure path; `/forget-me` has nothing
to remove.

Service: `packages/core/services/capabilityGapService.js`. Tests:
`tests/capabilityGaps.test.js` (both engines).
