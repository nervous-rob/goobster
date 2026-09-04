# ADR 0002: Split the four gravity-well files by capability

## Status

Accepted.

## Context

Four files have become coordination bottlenecks:

- `packages/core/utils/toolsRegistry.js` — every chat/voice tool
- `packages/core/web/appApi.js` — every portal route
- `packages/core/services/parlorService.js` — personas, notes, discussions, turns
- `packages/core/services/projectService.js` — workspace, jobs, quota, chat preamble

Adding a fifth subsystem to any of them is how agents collide and how
reviews lose the plot.

## Decision

Split **by capability / route domain**, not by arbitrary line count. Keep
the existing public entrypoints as facades so callers and tests do not
churn.

### `appApi.js`

`createWebAppContext`, `createWebAppApp`, and `attachWebAppWebSocket`
remain the only exports. Route mounting moves to `packages/core/web/routes/`
grouped by product domain (auth/chat, projects, spitball, parlor,
attention, and the remaining workspace panes). Shared auth, cookie, and
JSON-error helpers live in `appHelpers.js`.

### `toolsRegistry.js`

`getDefinitions` / `execute` / `registerCommandAdapters` remain the only
exports. Tool implementations move to `packages/core/utils/tools/` grouped
by capability (sandbox/observatory, exchange, tavern, attention, parlor,
integrations). Shared account/member resolvers live in `tools/helpers.js`.

### `parlorService.js` and `projectService.js`

The exported singleton and class names stay put. Shared constants, error
types, and pure helpers move to sibling modules (`parlor/*`, `project/*`)
so the service files become orchestration rather than grab-bags. Method
bodies stay on the class in this cycle; a further extract of mixins is
deferred until a second subsystem actually needs those methods.

## Consequences

New routes and tools have an obvious home. Smoke and Jest keep requiring
the facades. Line counts on the facades drop; the *system* does not shrink,
it becomes navigable.
