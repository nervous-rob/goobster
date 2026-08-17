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

**Unattended automation runs count as a trusted surface** for the `web`
scope (both for the sandbox and the Observatory): an automation created to
drive a project ("check neurogene-lab every hour and advance the
simulation") executes as a Discord-delivered pseudo-interaction, and
without this rule its runs could never touch the very project they were
created for. The prompts behind automations are authored through surfaces
that already enforce the scope, so this widens delivery, not authorship.

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

Simulations usually want numpy/scipy/matplotlib, and expeditions through
real observational data want astropy — run **`npm run sandbox-python`** once
to install the managed toolkit venv the sandbox auto-detects (core numerics
and plotting, the `astro` bundle for FITS/WCS/units/cosmology, photometry,
spectra and reprojection, and image/frame I/O), and the tool descriptions
will advertise exactly what is importable (see "Python packages" in
`documentation/code_sandbox.md`).

## Getting real data in (`fetch-data`)

Sandbox runs have **no network** — that never changes. Instead, the
`fetch-data` action downloads a file *host-side* into the project workspace
at `data/<file>`, where runs read it via `$GOOBSTER_PROJECT_DIR` like any
other workspace file. The model only proposes a URL; `utils/safeFetch`
legalizes the transfer:

- **https only**, default port, no embedded credentials, no redirects
  (a 302 into a metadata endpoint is the classic allowlist escape — the
  model is told to propose the final URL instead).
- **DNS is resolved once and pinned**: every address the name resolves to
  must be publicly routable (loopback, RFC1918, link-local/cloud-metadata,
  CGNAT, NAT64/mapped forms are all refused), and the connection goes to the
  pinned address — a DNS rebind between check and connect has nothing to move.
- **Byte-capped on received bytes** (`sandbox.maxFetchMb`, default 512 MB,
  further capped by the project's remaining `maxProjectMb` quota), streamed
  with abort — never a trusted Content-Length. Existing files are never
  overwritten, and filenames are flattened to a safe basename.

Consent is two-tier: hosts on `sandbox.fetchAllowedHosts` (exact hostnames,
e.g. `mast.stsci.edu`, `zenodo.org`) have standing operator consent and fetch
immediately; any other host becomes a pending `sandbox_requests` row and the
configured `sandbox.approverUserIds` get a DM with Approve/Deny buttons (12 h
TTL; the DNS pin is re-checked at approval time). With no approvers
configured, off-list fetches are simply refused. Every fetch — allowlisted or
approved — is recorded in `sandbox_requests` as the audit trail.

```json
"sandbox": {
  "fetchAllowedHosts": ["mast.stsci.edu", "archive.stsci.edu", "zenodo.org"],
  "maxFetchMb": 512,
  "approverUserIds": ["your-discord-user-id"]
}
```

The operator can always bypass all of this by dropping files into
`data/sandbox/projects/<userId>/<slug>/` directly.

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
  after a process restart is reaped to `INTERRUPTED` — and, when it left a
  `checkpoint.json`, is **auto-resumed on startup**
  (`observatoryService.autoResumeInterrupted`, called from `index.js` once
  the Discord client is ready), so a deploy or crash never silently
  freezes a long-running simulation. Jobs without a checkpoint stay
  `INTERRUPTED` for a manual `action: "resume"` — which also works after
  `TIMED_OUT`, while resume budget remains. Auto-resume respects the
  per-user active-job cap and never consumes the timeout-resume budget.
- `action: "cancel"` kills the live segment (the whole process group) and
  settles the job as `CANCELLED`.
- A busy sandbox (concurrency cap reached) *defers* a segment with backoff
  instead of failing the job.
- Only a job's first segment counts against the user's sandbox rate limit;
  resumes are service-initiated and bounded by `maxResumes` instead.
- When a job finishes (any terminal state), a follow-up is filed **due now**
  in the user's DM scope and delivered by the heartbeat's minute loop — the
  same machinery as `scheduleFollowUp` and the portal Tasks pane.
- For periodic check-ins on a long-running project ("check in on
  neurogene-lab every hour"), ask for a **recurring follow-up** —
  `scheduleFollowUp` with `repeat: "every hour"`. It re-arms itself after
  every delivery (restart-safe, missed hours collapse into one catch-up
  message) until cancelled from the portal Tasks pane, so nobody has to
  re-schedule after each check-in.
- A recurring follow-up is a *reminder ping* — it reposts the note, never
  runs tools. If the bot itself should check the project and post a status
  each time (a full agent turn), use a recurring **automation** instead:
  `manageAutomations` in chat, `/automation`, or the portal Tasks pane.

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
| `maxProjectMb` (per-project disk quota) | 1,024 | 1 | 102,400 |
| `maxActiveJobsPerUser` | 1 | 1 | 50 |
| `maxResumes` | 12 | 0 | 500 |
| `maxWorkspaceFiles` (per listing) | 50 | 1 | 5,000 |
| `maxRenderFrames` | 2,000 | 2 | 100,000 |
| `renderFps` | 24 | 1 | 120 |

The disk quota is enforced **before** every run and segment, so a runaway
job stops at the quota instead of filling the disk.

## The dashboard artifact

The final step of every project run — foreground runs and background jobs
alike — regenerates the project's **results dashboard**: a single,
self-contained HTML document with the job timeline (status, segments,
resumes, errors, stdout tails), the latest render playing inline, an image
gallery, the current checkpoint, a workspace file table, and quota usage.
Media is inlined as base64 data URLs (extension-checked, size-capped:
12 images ≤ 2 MB each, one video ≤ 16 MB; anything larger is noted and
left to the portal file browser), so the one file can be explored,
downloaded, or forwarded as-is.

Security posture:

- The dashboard is **authored by deterministic server code and stored
  outside the workspace** (`data/sandbox/dashboards/<userId>/<slug>.html`).
  The workspace is snippet-writable, so a run can create its own
  `dashboard.html` there — it gets *listed* like any file, escaped, and is
  never served as the trusted page.
- Every dynamic string is HTML-escaped and a strict CSP meta tag pins what
  the page may do.

Surfaces:

- **Owner (live)**: `GET /api/app/observatory/projects/:slug/dashboard`
  (regenerated when stale, `?fresh=1` forces) — the 📊 Dashboard button on
  each portal project card opens it. A small inline script probes the
  authenticated API; for the signed-in owner on the bot's origin, **control
  buttons appear**: per-job Cancel/Resume, Render frames to video, and
  Refresh — calling the normal Observatory routes. For anyone else the
  probe fails and the page stays read-only.
- **Share link**: 🔗 Share on the project card (or the API) mints one
  revocable read-only link per project — `/app/observatory/share/<token>`,
  no sign-in, the `web_share_links` pattern (`observatory_share_links`
  table; the unguessable token is the capability). The shared page is
  regenerated when stale, so it always shows the project's current state,
  and being self-contained it exposes no other file or route. Revoking,
  deleting the project, disabling the feature, or `/forget-me` kills the
  URL instantly.
- **Chat**: the `dashboard` tool action regenerates the artifact and
  attaches it to the conversation like any produced file.

## The portal pane

The web app grows a 🔭 **Observatory** pane (shown only when the feature is
enabled): project list with sizes and job counts, live job status with
segments/resumes/heartbeat, cancel and resume buttons, a workspace file
browser served through the owner-bound `/api/app/files/:id` route, inline
playback for rendered videos, and per-project 📊 Dashboard / 🔗 Share
buttons. Projects and jobs are *created* from chat — the pane is mission
control, not a second API surface.

## Privacy

Projects, jobs, and dashboard share links are personal data:
`/what-do-you-know-about-me` reports them, `/forget-me` deletes the rows,
the share links, the on-disk workspace tree, AND the generated dashboards
(live jobs are cancelled first), and `privacyService.auditUser` counts all
three tables plus any leftover workspace/dashboard directories so "zero
gaps" stays provable.

## Tests

`tests/observatoryConfig.test.js` (clamping),
`tests/observatoryService.test.js` (projects, quota, workspace persistence,
jobs end to end, checkpoint/resume round-trip, resume budget, cancellation,
orphan reaping, render happy path + missing-ffmpeg fallback, notifications,
erasure), and `tests/toolsRegistryObservatory.test.js` (tool gating and a
happy path through the registry).
