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
5. Do **not** add `forceExit: true` to unit Jest. A quiet exit is the
   signal. `forceExit` would re-conceal leaks.

Coverage: keep `npm test` as the CI gate. `test:coverage` stays a local
/ optional job. Widening `collectCoverageFrom` to services and the
React client is a separate campaign.

## Consequences

CI logs become a place you can spot a new leak. Workers should exit
without Jest’s force-exit banner. A remaining late log after this ADR
is a defect, not ambient noise.
