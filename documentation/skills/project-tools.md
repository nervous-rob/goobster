---
title: Project tool guide
kind: skill
summary: Exact tool choices and arguments for saving new apps, filing existing Chat apps without regenerating them, editing project assets, running scripts and handling failures.
when: You need to save or update a project app, file a generated Chat app, choose a project tool, or recover from a failed project operation.
tags: [projects, apps, assets, save, tools, routing, executePlan]
---

# Project tool guide

Use the specific tool directly, read its result, then choose the next call.
`executePlan` is an optional batch adapter for existing tools. It is neither
a project storage API nor a durable Project Mission. It cannot unlock a
missing tool, bypass personal settings, or bypass approval.

Stopping a chat cancels its `executePlan` batch and releases the chat even if
the current tool does not respond to cancellation. No later steps or remaining
`forEach` iterations start, regardless of `stopOnError`. An external operation
already submitted may still finish; cancellation does not roll it back. Inspect
the deployment or job status before retrying a partially completed batch.

## Choose the operation

| Intent | Tool and action | Important arguments |
|---|---|---|
| Find accessible projects | `projectAssets` → `list_projects` | No project required; use returned slug and owner identity |
| Create a requested project | `projectAssets` → `create_project` | `name` |
| Save complete new app source | `projectAssets` → `save_app` | `project`, `name`, `language: html` or `svg`, `code` |
| Find an existing app from Chat | `projectAssets` → `list_unfiled_apps` | Returns pinned IDs and discovered content hashes; source is not echoed |
| File that app unchanged | `projectAssets` → `file_app` | `project`, exactly one returned `appletId` or `contentHash`; optional `name`/`slug` |
| Inspect saved apps/scripts/notes | `projectAssets` → `list_assets`, then `get_asset` | `project`, optional `kind`; `get_asset` needs `slug` |
| Update source | `projectAssets` → `save_app`, `save_script`, `save_note` | Same target `slug`; complete replacement `code`, not a patch |
| Read/write workspace or run jobs | `observatory` | `files`/`search`/`read`, `run`, `run_script`, `status`, `cancel` |
| Understand a project's state | `observatory` → `inspect` | `project`; includes mission, assets, triggers and recent jobs |
| Durable outcome with human decisions | `observatory` → `mission` | Follow the action schema; approval/start/completion remain human-only |
| Schedule repeated project execution | `observatory` → `set_trigger` | Script/render/fetch/agent action; distinct from a personal reminder |

Both tools use `owner` to disambiguate accessible projects with the same slug.
Copy identities from results; never invent owner IDs. `projectAssets` works
when Projects is active even if Sandbox and Observatory execution are off.
It shares `observatory.scope` (web by default, also available to unattended
automation turns); `everywhere` permits other chat surfaces. Feature state,
user tool preferences, ownership and collaborator access still apply.

## Save a new app

Call `projectAssets` with these arguments (replace the example project and
source with the user's actual target and complete document):

```json
{
  "action": "save_app",
  "project": "lab",
  "name": "Counter",
  "slug": "counter",
  "language": "html",
  "code": "<!doctype html><html><head><title>Counter</title></head><body><button id='count'>0</button><script>let n=0;document.getElementById('count').onclick=e=>e.target.textContent=++n;</script></body></html>",
  "note": "Initial interactive counter"
}
```

`code` is complete source without Markdown fences, never a filename, URL,
summary or a request to write the app later. Apps accept HTML/SVG, scripts
accept Python/JavaScript (not Bash), and notes accept Markdown. Missing
language defaults to HTML/Python/Markdown by kind. A script run can use Bash
through `observatory run`, but Bash is not a stored script-asset language.

A successful save returns `ok: true`, project, slug and version. Same source
at the same slug is a no-op; changed source creates a new version. Report
success only after that result. `ok: false` and `❌` results are failures.

## File an existing Chat app without rewriting it

1. Call `projectAssets` with `action: list_unfiled_apps`.
2. Identify the app by name and conversation. If several match, ask which one.
3. Call `file_app` with the existing project and either its exact `contentHash`
   (discovered app) or `appletId` (pin). The service reads the original source
   using the current user's access; no model regeneration is involved.
4. Confirm the returned project, slug and version. If it is no longer in the
   bounded discovery window, say so. Read the original source from the
   conversation before using `save_app`; never reconstruct a missing app
   from its title or claim a save succeeded.

Discovery scans at most 80 recent app-bearing assistant messages and returns
up to 40 unique apps from the user's own private web conversations. Filing
copies source; it does not delete the conversation. An HTML preview in Chat,
a knowledge attachment (`saveArtifact`), a workspace file and a project app
asset are different objects. A preview alone has not been saved to Apps.

## Edit an existing app safely

List assets, read the chosen slug with `get_asset`, and continue with
`offset`/`limit` when the returned source is truncated. Read enough to
preserve existing behavior. Save complete replacement source to the same
slug. Use a new slug only when the user wants a separate app. Do not use a
workspace `run` just to save an app, and do not mistake `executePlan` for the
project's human-reviewed mission.

Project apps run in a sandboxed iframe. They cannot fetch `/api/app` directly.
Read *Projects → Apps with project access* for `window.goobster` and required
write/delete/run declarations. Saving source does not approve those grants.

## Failures and gates

Do not wrap a missing/disabled tool in `executePlan`. Read the returned code
and message. A missing project calls for `list_projects`; an ambiguous slug
needs `owner`; an unsupported language needs a corrected language; an access
refusal needs the user's authorized project. Never auto-create another
project or overwrite a different asset to hide an error. Consult *Projects*
and *Troubleshooting tactics* for host configuration.

If batching truly helps, use `executePlan` with all steps in order and
`stopOnError: true` for dependent actions. `${stepN.field}` requires a real
structured field. Most `observatory` results are text, so an invented
`${step1.project.slug}` will not resolve. Inspect first, then make the next
direct call when the structure is unknown.
