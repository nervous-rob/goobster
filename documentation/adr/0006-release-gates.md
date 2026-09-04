# ADR 0006: Release gates for both database engines

## Status

Accepted as an operator action. The repository can only make the required
checks *exist*; it cannot enable GitHub rulesets or write
`/etc/goobster-update.conf` on the Pi.

## Context

PR #201 merged to `main` at 02:32:25 UTC. Its `test (postgres)` job
finished at 02:33:04. `main` advanced before both engines were green.
The visible repository ruleset (`standard`, id 6215449) is still
disabled. `scripts/auto-update.sh` defaults `GOOBSTER_REQUIRE_CI` to
`false` so a box without GitHub checks (or a non-GitHub remote) still
deploys; that default is not a recommendation.

This agent’s GitHub token is read-only. It cannot flip the ruleset.
It cannot SSH to the production Pi.

## Decision

1. **CI exposes a single aggregator.** `.github/workflows/ci.yml` has a
   `both engines` job (`if: always()`, `needs: [test-sqlite, test-postgres]`)
   that fails unless both named jobs succeeded. Require this job — or
   both `test (sqlite)` and `test (postgres)` — on `main` in the GitHub
   ruleset. Do not require only the SQLite job. `test (playwright)` is a
   separate job (ADR 0004) and is not part of this aggregator.
2. **Do not default `GOOBSTER_REQUIRE_CI` to true in the script.** A
   fake or non-GitHub remote would then skip every deploy (`ci_status`
   returns 2). Production copies `deploy/goobster-update.conf.example`,
   which already sets `GOOBSTER_REQUIRE_CI=true`.
3. **Warn when a GitHub remote would deploy ungated.** If the tracked
   remote looks like GitHub and `GOOBSTER_REQUIRE_CI` is false, the
   updater logs a loud WARN and still deploys. That is how an operator
   notices the Pi is unprotected without breaking lab remotes.

## Operator checklist (cannot be done from this repository)

- Enable ruleset 6215449 (or an equivalent) on `main`.
- Require `both engines`, or both `test (sqlite)` and `test (postgres)`.
- On the Pi: `/etc/goobster-update.conf` must contain
  `GOOBSTER_REQUIRE_CI=true`. Confirm with
  `sudo ./scripts/auto-update.sh --check` and the updater journal.

## Consequences

Until the ruleset is on, a green-looking merge can still land before
Postgres finishes — the #201 race. Until `GOOBSTER_REQUIRE_CI=true` is
set on the Pi, that merge can also deploy. The aggregator and the WARN
make both gaps visible; they do not close them by themselves.
