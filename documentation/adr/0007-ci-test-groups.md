# ADR 0007: Named CI test groups and optional live integrations

## Status

Accepted.

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

1. **Keep the SQLite and Postgres jobs.** Each still installs dependencies
   once. Replace the single `npm test` step with named groups from
   `tests/ciGroups.js`, run via `--runTestsByPath`.
2. **Inventory first.** `scripts/check-test-groups.js` compares the
   manifest to `jest --listTests` and to
   `.github/actions/run-test-groups/action.yml`. A new spec that is not in
   exactly one group fails CI before any group runs.
3. **Continue after a group failure.** Group steps use `continue-on-error`.
   A final step fails the job if any group's `outcome` is not `success`.
   Setup failures (checkout, `npm ci`) still skip the groups.
4. **Live integrations are a separate job** (`test (live integrations)`),
   on trusted `main` pushes and `workflow_dispatch` only. Missing env vars
   skip that provider and report the variable name, never the value.
   Invalid keys or failed provider calls fail the test. The job is not
   part of the `both engines` aggregator (ADR 0006).
5. **`npm run test:integration` is an alias for `npm run test:live`**,
   which uses `jest.live.config.js` and `tests/live/*.live.test.js`.

Local `npm test` is unchanged: one Jest invocation, no keys, no network.

## Consequences

The Actions log shows which domain failed. Sequential group startups add
a little wall-clock time (timeouts raised to 25 minutes). Parallel jobs per
group can wait until timings justify repeating ffmpeg/npm setup.

Operators who want live coverage add repository secrets named
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`PERPLEXITY_API_KEY`, and `ELEVENLABS_API_KEY`. Absent secrets produce skips,
not failures.
