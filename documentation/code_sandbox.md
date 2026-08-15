# Code Sandbox (`runCode` tool)

Goobster can write and run small snippets of code for a user and hand back the
output and any files they produced — the headline use case is **"draw me a
diagram"** in the web app (Python + matplotlib → a PNG rendered inline in
chat). The feature is **opt-in and gated**, off by default, and every run is
resource-limited and isolated.

- Service: `services/sandboxService.js`
- Config: `config/sandboxConfig.js` (env-first, then `config.json`, then defaults)
- Tool: `runCode` in `utils/toolsRegistry.js` (picked up by the shared agent loop)

## Enabling it

The sandbox is disabled until you turn it on. Add a `sandbox` block to
`config.json` (see `config.example.json`), or set the environment switches:

```json
"sandbox": {
  "enabled": true,
  "scope": "web"
}
```

- `GOOBSTER_SANDBOX_ENABLED=1` — master switch (equivalent to `sandbox.enabled`).
- `GOOBSTER_SANDBOX_SCOPE=web|everywhere` — where the tool is offered.
- `GOOBSTER_SANDBOX_PYTHON=/path/to/venv/bin/python` — interpreter for Python runs.

When disabled, the tool is **not registered at all** (it never appears in the
model's function list). When `scope` is `web` (the default and smallest
audience), the tool is offered only inside the authenticated web app chat and
refused everywhere else; `everywhere` also exposes it to Discord text chat.
It is never added to the voice tool subset.

## What "gated and resource-limited" means

The trust boundary is the project's usual one — **the model proposes, the
service legalizes**. The model only ever supplies a `language` + `code`
string; `sandboxService` decides how it runs. Every run gets, regardless of
what the snippet asks for:

- **Isolation ladder, strongest first** (auto-detected once at first run):
  1. **bubblewrap** (`bwrap`) — a throwaway mount namespace with the host
     filesystem mounted read-only, a private `/tmp`, the per-run working
     directory bound read-write, separate PID/IPC/UTS namespaces, and — unless
     `allowNetwork` is set — **no network** (`--unshare-net`). This is the
     recommended backend; install `bubblewrap` on the host to get it.
  2. **`unshare -rn`** — an unprivileged user + network namespace. Drops
     network access at least (no filesystem isolation).
  3. **rlimits + timeout only** — best effort with no OS isolation. A warning
     is logged at first run; not recommended on a shared host.
- **POSIX rlimits on every run** via a `ulimit` wrapper: CPU seconds
  (`maxCpuSeconds`), virtual memory (`maxMemoryMb`), max output file size
  (`maxWriteMb`), and a process-count cap (fork-bomb guard).
- **A hard wall-clock timeout** (`timeoutMs`) enforced by coreutils `timeout`
  (`--signal=KILL`) with a Node-side backstop kill.
- **A scrubbed environment** — the snippet never sees the bot's Discord token,
  AI keys, or any other host secret; only a tiny `PATH`/`HOME`/locale
  allowlist plus a headless-matplotlib nudge (`MPLBACKEND=Agg`, and
  `MPLCONFIGDIR`/`HOME`/`TMPDIR` pointed at the throwaway workdir).
- **A private per-run working directory** under `data/sandbox/runs/<id>/`
  (mode `0700`). Output files are collected from it (count-capped by
  `maxOutputFiles`, size-capped by `maxFileSizeBytes`) and the whole tree is
  pruned after `retentionHours`.
- **Bounded output** — stdout and stderr are each truncated to
  `maxOutputBytes`.
- **Concurrency + rate limits** — `maxConcurrent` runs bot-wide and
  `runsPerWindow` runs per user per 5 minutes (in-memory, transient state).

## Limits: defaults and ceilings

Every knob is clamped into a floor/ceiling range in `config/sandboxConfig.js`,
so a config typo can never remove a guardrail — an out-of-range value lands on
the nearest bound instead of passing through, and anything unset or
unparseable falls back to the default.

The **defaults** are the conservative "runs fine on a Pi" numbers you get by
just switching the sandbox on. The **ceilings** sit two orders of magnitude
higher so a capable host can be configured for real work (long simulations,
large datasets, batches of plots) without patching code:

| Knob | Default | Ceiling |
| --- | --- | --- |
| `timeoutMs` | 20 s | 12,000,000 ms (~3.3 h) |
| `maxCpuSeconds` | 20 | 6,000 |
| `maxMemoryMb` | 2,048 | 409,600 (400 GB of address space) |
| `maxWriteMb` | 16 | 12,800 |
| `maxOutputBytes` | 64 KB | 100 MB |
| `maxOutputFiles` | 8 | 2,500 |
| `maxFileSizeBytes` | 8 MB | 6,400 MB |
| `runsPerWindow` | 10 | 10,000 |
| `maxConcurrent` | 1 | 400 |
| `retentionHours` | 24 | 16,800 (700 days) |

A ceiling means the knob still exists, not that the number is comfortable —
raising one is a deliberate act with real consequences. In particular: a run
holds one of the `maxConcurrent` slots for its whole `timeoutMs`, so a
multi-hour timeout with the default concurrency of 1 makes the sandbox
single-file for hours; `maxMemoryMb` is a `ulimit -v` cap that the host's real
RAM does not follow; and delivery limits are separate from collection limits
(Discord still refuses attachments over its own size cap, however large
`maxFileSizeBytes` is — the run summary lists the files either way).

Clamping is covered by `tests/sandboxConfig.test.js`.

## Generated files

Every file a run writes — images (`.png`, `.jpg`, `.svg`, …) and non-image
files (Markdown, CSV, JSON, …) alike — is delivered to the user the same way
`generateImage` output is: sent as an attachment via
`interactionContext.channel.send` (images render inline, everything else is a
downloadable attachment) and recorded on `interactionContext.generatedFiles`
so the web portal persists them in message history and re-serves them through
the owner-bound `/api/app/files/:id` route. Delivery is best effort; the run
summary lists the produced files either way.

## Persistence (the Observatory)

The sandbox workdir is throwaway by design. When a user needs state that
*survives* between runs — long simulations, checkpoints, frame sequences —
that is the Observatory's job: named per-user projects whose workspace
directory is mounted read-write beside the run dir, plus checkpointed
background jobs and a frame→video render pipeline. See
`documentation/observatory.md`.

## Languages

`python` (default interpreter `python3`; point `pythonCommand` at a venv that
has the libraries you want, e.g. matplotlib/numpy), `javascript` (`node`), and
`bash`. Aliases (`py`, `js`, `node`, `sh`, …) are normalized.

## Raspberry Pi note

The defaults are deliberately conservative but Python plotting needs headroom:
matplotlib + numpy map a lot of *virtual* address space, so `maxMemoryMb`
(a `ulimit -v` cap, not RSS) defaults to 2048 MB. Lower it only if you know
your plotting stack fits. On a Pi, install `bubblewrap` for real isolation and
create a small venv with just the plotting libraries you need.

On a larger host, raise the knobs you actually need rather than all of them —
the defaults stay conservative on purpose, and each one you lift is a
resource a snippet is now allowed to spend. Raise `maxConcurrent` alongside
`timeoutMs` if long runs must not block everyone else.
