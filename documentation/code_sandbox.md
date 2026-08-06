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

Every knob is clamped to a hard ceiling in `config/sandboxConfig.js`, so a
config typo can never remove a guardrail (e.g. `timeoutMs` can never exceed
120s, `maxCpuSeconds` never exceeds 60s).

## Generated images

Image files a run writes (`.png`, `.jpg`, `.svg`, …) are delivered to the user
the same way `generateImage` does: sent as an attachment via
`interactionContext.channel.send` and recorded on
`interactionContext.generatedFiles` so the web portal persists them in message
history and re-serves them through the owner-bound `/api/app/files/:id` route.

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
