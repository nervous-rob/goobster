# The Observatory (`observatory` tool)

Persistent, long-running simulation projects layered on top of the
[code sandbox](code_sandbox.md). The sandbox turns Goobster into a
scratchpad; the Observatory turns it into a lab bench — **named per-user
projects with durable workspaces, checkpointed background jobs,
automatic frame→video rendering, and completion notifications** that
arrive in your Discord DMs.

- Service: `services/observatoryService.js`
- Config: `config/observatoryConfig.js` (env-first, then `config.json`, then defaults)
- Tool: `observatory` in `utils/toolsRegistry.js` (picked up by the shared agent loop)
- Tables: `observatory_projects`, `observatory_jobs` in `db/schema.sql`
- Portal: the 🔭 Observatory pane in the web app (`web/app/observatory.js`,
  routes under `/api/app/observatory/`)

## Enabling it

Off by default, and it additionally requires the sandbox itself to be on —
the Observatory grants **persistence, never new execution powers**:

```json
"sandbox":     { "enabled": true, "scope": "web" },
"observatory": { "enabled": true, "scope": "web" }
```

- `GOOBSTER_OBSERVATORY_ENABLED=1` — master switch (equivalent to `observatory.enabled`).
- `GOOBSTER_OBSERVATORY_SCOPE=web|everywhere` — where the tool is offered
  (`web`, the default, limits it to the authenticated web app chat).
- `GOOBSTER_OBSERVATORY_FFMPEG=/path/to/ffmpeg` — render-pipeline binary.

When disabled (or when the sandbox is disabled), the tool is **not registered
at all**. It is never added to the voice tool subset.

## What a project is

A project is a named, per-user workspace at
`data/sandbox/projects/<userId>/<slug>/` (mode `0700`, same posture as the
per-run sandbox dirs). Every run belonging to the project keeps its normal
throwaway run directory as its working directory, **plus** the workspace:

- In bwrap isolation the workspace is bind-mounted **read-write** — the only
  writable path beyond the run dir; the rest of the filesystem stays
  read-only. In unshare/rlimits fallback modes the same path is reachable
  directly, and the env var below is still the contract.
- The snippet finds it via **`$GOOBSTER_PROJECT_DIR`**. Anything written
  there survives between runs; anything written to the cwd is collected and
  attached to the chat like a normal `runCode` output, then pruned.

Everything else about a run is unchanged: the isolation ladder, rlimits,
scrubbed environment, wall-clock timeout, byte-capped output, concurrency
slots, and per-user rate limits all come from the sandbox and its config.

Simulations usually want numpy/scipy/matplotlib — run
**`npm run sandbox-python`** once to install the managed toolkit venv the
sandbox auto-detects, and the tool descriptions will advertise exactly what
is importable (see "Python packages" in `documentation/code_sandbox.md`).

## Background jobs and the checkpoint convention

`action: "run"` with `background: true` detaches the run into a **job** (an
`observatory_jobs` row). The job engine runs the same snippet in *segments* —
each one a fully legalized sandbox run holding a concurrency slot honestly.

The resume rules are a documented convention, not magic:

1. Your code loads `$GOOBSTER_PROJECT_DIR/checkpoint.json` **when it exists**
   and starts from that state; otherwise it starts fresh.
2. It rewrites `checkpoint.json` as it progresses.
3. When the sandbox's timeout wall kills a segment, the engine compares the
   checkpoint's mtime: if the segment advanced it, the job is **resumed**
   (a new segment starts, loading the checkpoint) — up to `maxResumes`
   times. That converts "one 3-hour run" into many short legal runs, which
   is dramatically friendlier to a shared host.
4. A segment that exits `0` completes the job; a non-zero exit fails it; a
   timeout with **no** checkpoint progress is terminal (the reason is
   recorded on the job).

Other lifecycle facts:

- Jobs survive restarts as data: a job found `RUNNING` with no live handle
  after a process restart is reaped to `INTERRUPTED` and can be resumed
  (from its checkpoint) with `action: "resume"` — also after `TIMED_OUT`,
  while resume budget remains.
- `action: "cancel"` kills the live segment (the whole process group) and
  settles the job as `CANCELLED`.
- A busy sandbox (concurrency cap reached) *defers* a segment with backoff
  instead of failing the job.
- Only a job's first segment counts against the user's sandbox rate limit;
  resumes are service-initiated and bounded by `maxResumes` instead.
- When a job finishes (any terminal state), a follow-up is filed **due now**
  in the user's DM scope and delivered by the heartbeat's minute loop — the
  same machinery as `scheduleFollowUp` and the portal Tasks pane.

## The render pipeline

A job that writes numbered frames — `$GOOBSTER_PROJECT_DIR/frames/
frame_0001.png`, `frame_0002.png`, … — gets an automatic ffmpeg stitch into
`renders/render_<n>.mp4` when it completes (recorded on the job row). The
`render` action does the same on demand with an optional `fps`. Missing
ffmpeg degrades to a clear message — the frames stay in the workspace. Videos
are attached in chat and play inline in the portal pane.

## Limits: defaults and ceilings

Same clamping contract as the sandbox: every numeric knob lands on the
nearest bound when misconfigured, so a config typo can never remove a
guardrail (`tests/observatoryConfig.test.js`).

| Knob | Default | Floor | Ceiling |
| --- | --- | --- | --- |
| `maxProjectsPerUser` | 5 | 1 | 200 |
| `maxProjectMb` (per-project disk quota) | 256 | 1 | 102,400 |
| `maxActiveJobsPerUser` | 1 | 1 | 50 |
| `maxResumes` | 12 | 0 | 500 |
| `maxWorkspaceFiles` (per listing) | 50 | 1 | 5,000 |
| `maxRenderFrames` | 2,000 | 2 | 100,000 |
| `renderFps` | 24 | 1 | 120 |

The disk quota is enforced **before** every run and segment, so a runaway
job stops at the quota instead of filling the disk.

## The portal pane

The web app grows a 🔭 **Observatory** pane (shown only when the feature is
enabled): project list with sizes and job counts, live job status with
segments/resumes/heartbeat, cancel and resume buttons, a workspace file
browser served through the owner-bound `/api/app/files/:id` route, and
inline playback for rendered videos. Projects and jobs are *created* from
chat — the pane is mission control, not a second API surface.

## Privacy

Projects and jobs are personal data: `/what-do-you-know-about-me` reports
them, `/forget-me` deletes the rows AND the on-disk workspace tree (live
jobs are cancelled first), and `privacyService.auditUser` counts both tables
plus any leftover workspace directory so "zero gaps" stays provable.

## Tests

`tests/observatoryConfig.test.js` (clamping),
`tests/observatoryService.test.js` (projects, quota, workspace persistence,
jobs end to end, checkpoint/resume round-trip, resume budget, cancellation,
orphan reaping, render happy path + missing-ffmpeg fallback, notifications,
erasure), and `tests/toolsRegistryObservatory.test.js` (tool gating and a
happy path through the registry).
