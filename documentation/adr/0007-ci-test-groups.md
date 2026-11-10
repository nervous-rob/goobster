# ADR 0007: Named CI test groups and optional live integrations

## Status

Accepted. Amended 2026-11-10: the engine jobs and the Playwright job run as
parallel shards (see "Amendment: parallel shards" below). Decisions 1 and 3
are updated in place; the rest stands. Amended again the same day: the
Chromium system packages come from a cache (last section).

## Context

Each engine job ran a single `npm test` step over every `tests/*.test.js`
file. Failures were correct but slow to localize, and a first failure hid
later suites. `npm run test:integration` pointed at a stale
`jest.integration.config.js` that required `config.json` and a missing
`__tests__/integration` tree.

Live provider keys (OpenAI, Anthropic, Gemini, Perplexity, ElevenLabs) must
never become a prerequisite for the mocked unit suite. Fork pull requests
do not receive repository secrets.

## Decision

1. **Keep the SQLite and Postgres jobs.** Replace the single `npm test`
   step with named groups from `tests/ciGroups.js`, run via
   `--runTestsByPath`. Each engine job is a matrix of shards; a shard
   installs dependencies once and runs the groups in its `groups` list.
2. **Inventory first.** `scripts/check-test-groups.js` compares the
   manifest to `jest --listTests` and to `.github/workflows/ci.yml`.
   Named groups are ordinary job steps in both engine jobs — not a
   composite action, which GitHub collapses to one parent step. A new spec
   that is not in exactly one group fails the `static checks` job, and a
   group that is not in exactly one shard of each engine fails it too.
3. **Continue after a group failure.** Group steps use `continue-on-error`.
   A final step (`scripts/require-test-groups.js`) fails the shard unless
   every group in its list wrote a passing result, so a group that was
   skipped or never started counts as a failure. Setup failures (checkout,
   `npm ci`) still skip the groups.
4. **Live integrations are a separate job** (`test (live integrations)`),
   on trusted `main` pushes and `workflow_dispatch` only. Missing env vars
   skip that provider and report the variable name, never the value.
   Invalid keys or failed provider calls fail the test. The job is not
   part of the `both engines` aggregator (ADR 0006).
5. **`npm run test:integration` is an alias for `npm run test:live`**,
   which uses `jest.live.config.js` and `tests/live/*.live.test.js`.

Local `npm test` is unchanged: one Jest invocation, no keys, no network.

## Consequences

The Actions log shows which domain failed because each group is an
ordinary named step on both engine jobs. Sequential group startups add
a little wall-clock time. The original version ran all groups in one job
per engine and left parallel jobs "until timings justify repeating
ffmpeg/npm setup"; they now do (next section).

Operators who want live coverage add repository secrets named
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`PERPLEXITY_API_KEY`, and `ELEVENLABS_API_KEY`. Absent secrets produce skips,
not failures.

## Amendment: parallel shards (2026-11-10)

### What was measured

Seven runs of `ci.yml` on 2026-11-08 and 2026-11-09 (five pull requests,
two pushes to `main`), wall clock from the push:

| Job | Median | Range | Where the time went |
| --- | ---: | ---: | --- |
| `test (playwright)` | 19.4 min | 18.0 to 19.8 | 17.1 to 18.8 min of journeys on one worker; 1 min of setup |
| `test (postgres)` | 10.8 min | 7.7 to 11.9 | Core infrastructure 3.6 to 5.3 min, Privacy 1.0 to 1.8 min, 45 s of setup |
| `test (sqlite)` | 6.1 min | 4.7 to 6.3 | Core infrastructure 2.3 to 2.9 min, 45 s of lint, typecheck and build |
| `test (docker postgres)` | 2.6 min | 2.3 to 2.7 | |
| `sandbox isolation` | 1.1 min | 1.0 to 1.1 | |
| `both engines` reported | 10.9 min | 7.8 to 12.0 | waits on `test (postgres)` |
| Whole run green | 19.4 min | 18.0 to 19.9 | waits on `test (playwright)` |

Three things set those numbers. The journeys ran serially in one job. Each
engine ran its groups one after another, so the job took the sum of the
groups. And a few suites are long enough to bound any split (seconds from
run 42720787318): on Postgres `dbMigration` (162), `nativePostgresKinds`
(118), `dataReset` (94) and `dockerPostgresKinds` (92); on SQLite
`nativePostgresKinds` (87) and `dockerPostgresKinds` (72).
`Core infrastructure` held three of those and was about half of each
engine job.

A pull request that was pushed twice ran both pushes to the end; the
workflow had no `concurrency` group.

### Decision

1. **Split `Core infrastructure`.** The manager, installer, payload,
   service-adapter, managed-Postgres, release and update suites move to a
   new group, `install` ("Installer and lifecycle"). `core` keeps the
   database, migrations, configuration, gateways and feature gating. No
   test file changed; this is group assignment only.
2. **Shard each engine job.** `test-sqlite` and `test-postgres` are
   matrix jobs. Each matrix entry names the groups it runs:

   | Engine | Shards |
   | --- | --- |
   | SQLite | `install` · `core`, `chat`, `portal`, `knowledge`, `projects`, `voice`, `games`, `privacy` |
   | Postgres | `core` · `install` · `portal`, `projects` · `privacy`, `chat`, `knowledge`, `voice`, `games` |

   The two engines are split differently because the same groups take
   about twice as long on Postgres. The layout is sized so that no shard
   is much longer than its longest single suite. Every group step carries
   `if: contains(matrix.groups, '<id>')`, so the step list of every shard
   still names every group and shows the ones it does not run as skipped.
3. **The shard layout lives in the workflow; the audit keeps it honest.**
   `auditEngineShards` in `tests/ciGroups.js` parses `ci.yml` and fails if
   a group is in no shard of an engine or in two, if a group step is not
   gated on its own id, if the verdict step is missing or conditional, or
   if `both engines` does not wait on both engine jobs. It runs in
   `static checks` (`scripts/check-test-groups.js`) and in
   `tests/ciGroups.test.js` on both engines.
4. **Engine-independent checks run once, in `static checks`:** lint, the
   smoke require, the web typecheck and build, and the inventory. It is a
   separate job so that a lint error and a failing test are both reported
   by one push. `both engines` now needs it as well as the engine jobs
   and `sandbox isolation`, so nothing that gated a merge before stopped
   gating it.
5. **Shard the Playwright journeys.** `test-e2e` is a matrix of five jobs,
   each with its own server and throwaway database. `scripts/e2e-shard.js`
   plans the split from the spec files on disk, weighted by the seconds
   recorded in `e2e/shard-durations.json` (Playwright's own `--shard`
   balances by test count in file order and left one shard twice the size
   of another). A new spec needs no registration: it is placed at the
   median weight until someone refreshes the file with
   `node scripts/e2e-shard.js --record <report.json>`. A job named
   `test (playwright)` waits on the shards and reports one result under
   the name the single job had (ADR 0004).

   The single job had a 20-minute limit and was taking 18 to 20. On pull
   request #416 the limit cancelled it with 298 of 305 journeys passed and
   seven never started. A shard runs about four minutes of journeys under
   a 15-minute limit, and three things keep that room as journeys are
   added: `tests/ciGroups.test.js` fails when the longest planned shard
   (plus setup) passes half of the limit and says to add a number to the
   `shard` list; the shard step prints a warning past eight minutes of
   journeys; and a failed or cancelled shard uploads its traces
   (`playwright-shard-<n>`).
6. **Cancel superseded pull-request runs.** `concurrency` groups a pull
   request's runs by ref with `cancel-in-progress`. Pushes to `main` and
   manual runs are each their own group and always finish, because the
   updater's CI gate (`scripts/auto-update.sh`) treats a cancelled check
   run on the commit it is about to deploy as a failure. `both engines`
   and `test (playwright)` keep `if: always()`, so a cancelled run reports
   them failed and never skipped.
7. **Smaller Postgres setup.** The client-tools step refreshes only the
   pgdg index instead of running `apt-get update` three times, with the
   old steps as the fallback. The service database runs with `fsync`,
   `synchronous_commit` and `full_page_writes` off; it is discarded with
   the job.

Local commands are unchanged: `npm test`, `npm run test:postgres`,
`npm run test:group -- <id>` and `npm run test:e2e` each still run in one
process.

### Consequences

- A pull-request run uses 16 jobs instead of 6 (one more on `main`, the
  live checks), each shorter. Total runner time rises
  by the repeated setup (about 30 to 55 s per extra job). A public
  repository on the free plan gets 20 concurrent jobs, so three or more
  branches pushed at the same moment queue. That is why superseded runs
  are cancelled and why the shard counts stop where the longest single
  suite takes over.
- Check names changed. `test (sqlite)` and `test (postgres)` are now
  several checks each (`test (sqlite, install)` and so on) and the labels
  will change when shards are rebalanced. A ruleset must require
  **`both engines`**, not the per-shard names. `test (playwright)` and
  `both engines` keep their names.
- The Postgres floor is `dbMigration`, about 2.7 minutes in the measured
  run. Going lower means changing that suite, not the workflow.
- Rebalancing is a workflow edit: move a group id between `groups` lists.
  Run `npm run test:groups:check` afterwards. If a shard grows past the
  others, split a group in `tests/ciGroups.js` or add a shard; if the
  journeys drift, refresh `e2e/shard-durations.json` or add a number to
  the `shard` list in `test-e2e`.

### Considered and left alone

- **Path filters on `sandbox isolation` and `test (docker postgres)`.**
  They finish in 1 and 2.6 minutes, inside the shortest shard, so skipping
  them saves no wall clock, and a filter that is wrong once is coverage
  lost silently.
- **Narrowing the packaging-proof platform matrix on pull requests.** It
  is already path-filtered. The paths that make it run on ordinary feature
  work (`packages/core/db/**`, `packages/core/features/**`) are the ones
  that decide what goes into a payload and how the database opens under
  the bundled runtime, per platform. Its slowest job (`darwin-x64`, about
  4.7 minutes) is close to what a CI run now takes, so it is not what a
  pull request waits for.
- **Caching `node_modules`, the web build or the Playwright browser.**
  `npm ci` is 7 to 12 s with the lockfile cache and the build is 7 to 10 s.
  The browser download is about 10 s from Playwright's CDN and did not
  stall in any measured job, so a browser cache would save little. Handing
  a build from one job to the others would make them wait for it. (The
  font packages of the Chromium step are cached; see the last section.)
- **More Jest workers or more Playwright workers per job.** The journeys
  share one server and one database within a job, and the timing-sensitive
  manager suites are already slower on the runners than locally.
- **Skipping jobs for documentation-only changes.** `documentation/**` is
  read by the self-knowledge, feature-inventory and wiki suites.

## Amendment: the Chromium system packages come from a cache (2026-11-10)

`npx playwright install --with-deps chromium` runs `apt-get update`,
installs Chromium's libraries and fonts with `apt-get install`, and
downloads the browser. On a GitHub runner the libraries are present and
the install is nine font packages, 21 MB, from the runner's Ubuntu mirror.
Over 52 jobs in 40 runs the step took 22 s at the median and 16 s at best.
On 2026-11-10 the mirror served the packages at about 100 kB/s to four of
those jobs and the step took 97, 122, 125 and 240 s. One of the four was
the run for the #416 merge, where the job then ran out of its 20 minutes.
With five shards a run has five chances of drawing a slow download.

The step is now `scripts/ci-playwright-chromium.sh`, between a cache
restore and a cache save keyed on the runner image version and the
Playwright version:

- **With the packages in the cache** it runs `apt-get update` with a
  45-second limit (on a stalled mirror it carries on with the package lists
  the runner already has), checks that each cached file has the SHA-256 the
  signed package index gives for that package and version, and installs
  them with `apt-get install --no-download`. Then it asks Playwright:
  `npx playwright install --with-deps --dry-run chromium` exits 0 only when
  the old command would install or upgrade nothing. Then
  `npx playwright install chromium` downloads the browser as before.
- **With no cache, or if any of that fails,** it runs the command the step
  always ran, with no time limit, once more if it fails, and copies the
  packages that command installed into the cache folder. Shard 1 saves the
  cache.

What the journeys render with does not change: the browser build comes
from the same Playwright version, and the fonts are the same files apt
would download, installed by apt. The script prints a SHA-256 over every
font file on the machine, so two jobs on one runner image can be compared.

A cache step may fail without failing the shard, and nothing in the script
can fail a job that the old command would not. The cost is one full
install per runner image version (about weekly) on `main`, and on a pull
request whose first run comes before `main` has saved that image's cache.
If a font package is republished within an image's lifetime, the cached
file no longer matches the index and every run does the full install until
the next image; that is the old behaviour, not a failure.

