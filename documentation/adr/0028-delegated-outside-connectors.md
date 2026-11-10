# ADR 0028: A delegated run reaches an outside service only through a typed connector from a registry, on a named resource, with the person's own credential, behind the same guard and cap as a push

## Status

Accepted for DA-11d of the
[delegated assistant plan](../delegated_assistant_implementation.md): the
framework for outside connectors, with no connector shipped. It builds on
[ADR 0016](0016-delegated-responsibilities.md) (the grant),
[ADR 0018](0018-delegated-runs.md) (the run and its tool contract) and
[ADR 0025](0025-delegated-repository-work.md) (the `guard` hook,
`publishes: 'external'` and the `externalOperations` budget, which this
reuses as ADR 0025 asked). Behaviour is documented in
[delegated_connectors.md](../delegated_connectors.md). The code is
`services/assistant/connectors/`, `services/assistant/runTools/connectors.js`
and `services/assistantConnectorService.js`, all under `packages/core/`.

No specific connector is part of this decision. The owner has not named one.

## Context

The grant vocabulary has carried `external.write` on an `external` resource
since DA-1, and the product documents promised "typed adapters with a
manifest of exactly what each reads and writes", opt-in per responsibility,
scoped to named resources, with a recorded owner decision per connector and
no "watch everything" option. No run tool used it.

Outside services differ from a project's files and GitHub in one way that
matters here: this installation knows nothing about them. It cannot say who
reads what is written, cannot ask a general question about whether a write
landed, and cannot undo one. Each service answers those questions its own
way, so the framework can only fix the shape of the answer, not the answer.

## Decision

1. **A connector is a manifest and its functions, held in a registry.**
   `registry.register(manifest)` validates it whole: an id, a name, a
   description, an optional feature id, the owner's recorded decision, the
   credential provider, what a named resource looks like, and lists of
   typed reads and writes, each with a description and a `run` (writes may
   also have `reconcile`). The registry only holds and checks manifests; it
   calls nothing outside. The manifest is what the person is shown before
   they grant anything (`GET /api/app/assistant/connectors`), minus its
   functions.

2. **Goobster ships none.** `connectors/shipped.js` is an empty list.
   `register()` refuses a manifest without a recorded decision
   (`NO_OWNER_DECISION`), so a connector reaches production only by a pull
   request that names the owner's decision in its manifest. A `testOnly`
   manifest skips that rule and is never loaded by the product: the test
   double in `tests/helpers/connectorDouble.js` is the only one. A new
   connector's module goes in `shipped.js` and adds nothing else to the run
   tool table.

3. **A grant names one resource of one connector.** The resource is
   `{ kind: 'external', ids: ['<connector>:<resource>'] }`. It is checked
   when the responsibility is saved: the connector must be installed, and
   the resource must be a named, wildcard-free string of the shape the
   manifest accepts. `read` and `external.write` take it; nothing else does.
   There is no grant on a connector as a whole.

4. **Three run tools, none specific to a service.** `listConnectors`
   (reads the run's own grant and the manifests, calls nothing outside),
   `readConnector` and `writeConnector`. Each is a table entry in
   `runTools/connectors.js` and none is a chat tool. They are offered only
   when the grant names `read` or `external.write` on an `external`
   resource, at least one connector is installed and the owner has the
   pilot capability `reach`.

5. **The framework reuses ADR 0025's contract, not a parallel one.**
   - `needs` resolves the call to `read` or `external.write` on the one
     resource `<connector>:<resource>` and refuses an unknown connector,
     operation or resource, or input the manifest's `validate` rejects,
     before anything is journaled as dispatched.
   - `guard` asks the pilot gate (`assistantAccessService.allows(owner,
     'reach')`), the connector's feature and the person's credential,
     where the call is dispatched.
   - A write has `publishes: 'external'` (refused with `PRIVATE_CONTEXT`
     after any private read) and `budget: 'externalOperations'` (the same
     per-responsibility daily cap as a push, default 2, ceiling 20, counted
     from the journal; a connector write and a push share it).
   - A read is `source: 'private'`: what an outside service returns is the
     person's own data, so a run that read from one cannot write
     outside this installation or into a project others read, and a run
     that shares findings with a project's members is not offered the read
     at all. Reads are not counted against `externalOperations`.

6. **The credential is the person's own, in `user_integrations`.** The
   manifest names a provider from `userIntegrationService`'s catalog. The
   token is read for the one call and handed to the adapter; it is never in
   a result, a journal row, a report or a log. A connector is reachable
   for a person when it is installed, its feature is on and that provider
   is connected. `authorize()` checks that (a new `external` branch of
   `_resourceAccess`), and so does activation and the guard.

7. **Revocation deletes the credential.** `POST
   /api/app/assistant/connectors/:id/revoke` deletes the person's token for
   the connector's provider and returns the live responsibilities that
   held a grant on it. Their next call is refused `RESOURCE_UNAVAILABLE`
   (not a stop code: the run goes on without it). The grant stays until
   the person revokes the responsibility. Anyone may revoke their own; it
   never needs the pilot.

8. **After a crash the outside service is asked before anything is tried
   again.** A write's manifest `reconcile({ resource, input, token,
   operationId })` returns `done` (with the text to report), `absent` or
   `unknown`; the adapter's `run` receives the same `operationId`
   (`<run>:<op>`) so it can mark the write in whatever way the service
   allows. A write without `reconcile`, or one that answers `unknown` or
   cannot be asked, stops the work for review (`OPERATION_UNCERTAIN`) and
   is never retried. An adapter that knows the service changed nothing
   throws `declined(code, message)`; the call is answered "Not written
   (CODE): ..." and counts for nothing. Any other throw may have happened
   and counts.

9. **Every result that reached the service says it cannot be undone from
   here**, in one line the report lists under what changed: "Wrote to
   <name> (<resource>): <detail>. That cannot be undone from here." The
   framework builds that line; an adapter's text is only the detail.

10. **Reads and writes are pilot-gated by resource kind.** `read` is not
    in the pilot's operation list, so `assistantAccessService` gained
    `capabilityForOperation(operation, resourceKind)`: anything on an
    `external` resource is `reach`, at activation and in `authorize()`.

## What is deliberately not here

- **A connector.** None is named by the owner. The first one is its own
  pull request: a module, a manifest with the decision, tests.
- **A new credential provider.** `user_integrations.provider` is a CHECK
  over `github` and `notion`, so a connector with its own credential adds
  its provider to the catalog and widens that CHECK in its own change. The
  test double uses the `notion` slot only because a manifest must name a
  catalog provider; it never calls Notion. A connector that shares a
  provider with chat shares its token and its revocation.
- **Public reads.** Every connector read is `source: 'private'`. A
  connector whose reads are public (a status page) cannot say so yet,
  because `source` is a property of the tool, not of one call.
- **A per-operation grant.** A grant is on a resource; every manifest
  write on it is allowed. A person who wants fewer writes grants a
  connector that has fewer.
- **Background ingestion, watching, or a "watch everything" connector.**
  A connector is used only by a run under a responsibility, on a named
  resource.
- **A host list of connectors or a host switch per connector.** The
  `feature` field is the switch. The host's stop-all, caps and pilot gate
  apply as they do to every run.
- **Moving a responsibility to review when its connector is revoked.**
  Its next call is refused and reported; the grant is the person's to
  withdraw.

## Consequences

- No schema change and no new per-person table: credentials stay in
  `user_integrations`, which privacy, export, the dormant-data pass and
  `/forget-me` already cover, and what a run did is in the existing
  journal.
- The run tool table gains three entries, so every run's prompt
  fingerprint changes once (the tools are filtered from the offer unless
  the grant names an external resource). The live evaluation should be
  rerun.
- A connector write shares the daily `externalOperations` cap with pushes
  and pull requests. A responsibility with both has one number for what
  leaves.
- With no connector installed the grant form, the connector list and the
  tools are all absent, and a grant on an `external` resource cannot be
  saved.
