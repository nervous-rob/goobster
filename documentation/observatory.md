# The Observatory

The Observatory **is** the [Projects](projects.md) feature: named per-user
workspaces, versioned assets, checkpointed jobs, and project-scoped
triggers, plus an Inbox for leftover Workshop pins.

This file is kept so existing links keep working. The living document is
[`documentation/projects.md`](projects.md).

Implementation notes that have not moved:

- Service: `services/projectService.js` (`observatoryService.js` is a thin
  re-export so every existing `require` keeps working)
- Config / tool / tables: `config/observatoryConfig.js`, the `observatory`
  tool, `observatory_projects` / `observatory_jobs` — names unchanged
- Portal: the 🔭 Observatory room (`apps/web/src/rooms/ObservatoryRoom.tsx`)
- Routes: `/api/app/observatory/*` still work; `/api/app/projects/*` is
  the newer alias for assets and triggers
