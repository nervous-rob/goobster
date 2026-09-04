# ADR 0005: Open design questions (issue tracker is empty)

## Status

Proposed. These are unresolved product/architecture decisions living in
documents. They are recorded here because the GitHub issue tracker is
empty and this agent cannot file issues (read-only token).

Promote each item to a GitHub issue when write access is available.
Do not start the work from this ADR alone.

## Questions

### 1. Note revision revert UX

`documentation/spitball_expeditions.md` and the standards doc: 
`kg_node_revisions` is written; revert UX is “deliberately later work.”

Need: who may revert (owner vs collaborator vs Goobster), whether revert
is a new revision or a rewrite, and how research_expand interacts with a
human_edit head.

### 2. Guild-scope shared expeditions

Expeditions are personal-graph only. Shared / guild expeditions need an
explicit permission model (who pays the budget, who sees sources, how
`/forget-me` behaves for a member vs the owner). Do not reuse project
membership by accident.

### 3. Attention-initiated expeditions

The research `proactiveCompute` boundary exists. Whether Goobster may
*start* an expedition without a click is undecided. Default must remain
off; enrollment and budget belong in `attentionPolicyService`.

### 4. Coverage campaign vs. current 80% gate

The configured threshold does not cover services, `appApi`, or the React
client. Decide whether to (a) keep a narrow high bar, (b) add a second
job with a lower bar on services, or (c) grow the existing bar. Do not
silently widen `collectCoverageFrom` — CI will go red.

### 5. Project chat vs. dedicated 🔭 Study threads

Projects now have a shared parlor. Older per-member `🔭 <project>` Study
conversations remain as history. Is the Study thread deprecated, or a
private scratch pad beside the table? The spec still mentions both.

### 6. Operator gates (not design, but undecided in production)

- GitHub ruleset: require `test (sqlite)` and `test (postgres)` on `main`.
- Pi deploy: `GOOBSTER_REQUIRE_CI=true` in `/etc/goobster-update.conf`.

These are configuration, not code. Until they are on, merge velocity can
deploy a green-looking commit whose Postgres job has not finished.

## Consequences

Design questions have a durable home. The empty tracker is no longer the
only place they can hide.
