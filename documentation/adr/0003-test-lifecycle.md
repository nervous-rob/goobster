# ADR 0003: Quiet Jest on both database engines

## Status

Accepted.

## Context

Both CI jobs are green and both are noisy: a worker is force-exited for
leaked handles; SQLite emits late-log warnings; Postgres adds teardown
`missing relation` chatter while dropping isolation schemas.

Unit Jest does **not** set `forceExit` (only `jest.integration.config.js`
does). Jest 30 still force-exits a worker that still has open handles
after the suite’s `afterAll`. That can hide a real leak behind a green
tick.

Likely sources, from code inspection:

- `eventBusService` / `domainEventBus` start a dedicated `pg.Client`
  LISTEN connection on first subscribe. `db.closeConnection()` ended the
  pool and left those clients (and their reconnect timers) alive.
- `intentDetectionHandler` starts a one-hour unref’d-missing
  `setInterval` at construct time. Loading the module in a worker pins
  the process.
- `globalTeardown` `DROP SCHEMA … CASCADE` warns on every expected race
  with a leftover backend.

## Decision

1. Track LISTEN clients on the Postgres adapter and close them in
   `closeConnection()`.
2. Close both event buses in the per-suite `afterAll` *before* closing
   the database.
3. `unref()` module-level housekeeping timers that must not keep a
   worker alive.
4. Treat “could not drop leftover test schema” as a debug line, not a
   warning, when the schema is already gone or the backend refused a
   racy drop. Unexpected errors still warn.
5. `unref()` voice turn-end and capture-cutoff timers. Tests that call
   `_respondToTurn` must cancel the silence window a failed turn
   reschedules.
6. Track in-flight knowledge-reflection runs and `await stop()` before
   closing the database, so a fire-and-forget “Reflect” cannot write
   after Postgres drops the isolation schema.
7. Do **not** add `forceExit: true` to unit Jest. A quiet exit is the
   signal. `forceExit` would re-conceal leaks.

Coverage: keep `npm test` as the CI gate. `test:coverage` stays a local
/ optional job. Widening `collectCoverageFrom` to services and the
React client is a separate campaign.

## Consequences

Late-log warnings from leftover voice turn timers, LISTEN clients, and
expected Postgres `DROP SCHEMA` races are gone. One Jest worker still
force-exits because `@discordjs/voice` loads `@snazzah/davey`, whose
native `CustomGC` handle survives the suite. That is a third-party
addon, not an application timer. Do not paper it over with
`forceExit: true`. A new late log after this ADR is a defect.
