# ADR 0030: Notion is the first outside connector; it reads and writes one named page or database, a run may write back into the resource it read, and what cannot be granted is asked for one action at a time

## Status

Accepted for DA-11e of the
[delegated assistant plan](../delegated_assistant_implementation.md): the
first connector on the framework of
[ADR 0028](0028-delegated-outside-connectors.md). It records owner decision
12 (Rob, 2026-11-09): the first connector is Notion, reading and writing,
not append-only. Behaviour is documented in
[delegated_notion.md](../delegated_notion.md) and
[delegated_connectors.md](../delegated_connectors.md). The code is
`services/assistant/connectors/notion.js`,
`services/assistantConnectorRequestService.js`,
`services/assistant/runTools/connectors.js` and the private-origin rule in
`services/assistantRunService.js`, all under `packages/core/`.

This ADR amends ADR 0028 in two places, both stated under Decision: the
private-read rule for a connector write, and the manifest (it gains `asks`,
`resource.canonical` and `permits`).

## Context

ADR 0028 built the framework and shipped no connector. Three things in it
do not fit a read/write connector as it stood.

**A run that reads a page could not then edit it.** ADR 0028 made every
connector read `source: 'private'` and every connector write
`publishes: 'external'`, and a run refuses an external write after any
private read (`PRIVATE_CONTEXT`). That rule exists so that what a run read
in one private place cannot be carried to a place with a different
audience. Applied to one Notion page it forbids the only useful shape of
the work: read the page, then tick the to-do on it. The text is not leaving
anywhere; it is already in the page being written.

**The owner asked for more than appending.** Editing an existing block or
a page's properties replaces what was there. Notion keeps page history on
its own side, but this installation cannot undo an edit, and the framework
already says so in every write's result. That is accepted for edits. It is
not accepted for removal: a run that could move pages to the trash on a
standing grant could empty the resource on one bad reading of one injected
sentence.

**"One named resource" has to be enforced by this installation.** A Notion
integration token reaches every page shared with that integration. Notion
has no request that means "this block, but only if it is under that page".
A grant of one page is therefore only as good as the check made before
each call.

Notion's API also sets some facts this decision works within: it has no
idempotency key on any write; it has no permanent delete (archiving moves a
page or block to the trash, restorable for 30 days); a block cannot change
type; and a page's parent cannot be changed through the API.

## Decision

### One grant is one page or one database

The resource of a grant is the id of one Notion page or one Notion
database: `notion:<32 hex characters>`. A pasted link or a dashed id is
reduced to that when the responsibility is saved and whenever a run names
it (`resource.canonical` in the manifest), so the same resource has one
spelling in the grant, the journal and the budget count. There is no
wildcard and no workspace grant.

The connector uses the `notion` provider that already exists in
`user_integrations`: the person's own token, the same one the chat tools
`searchNotion` and `readNotionPage` use. There is no operator token, no new
provider and no schema change to credentials. A person who keeps a Notion
allowlist in Settings is held to it here too (the manifest's `permits`): a
granted resource that is not on a non-empty allowlist is refused as
`NOT_ON_ALLOWLIST`, and a list that cannot be read refuses.

### Everything a call names is proved to be inside the grant first

Before a page, block or database is read or changed, its chain of parents
is walked up, one request a step, until it reaches the granted id. A chain
that reaches the workspace, cannot be read with the person's token, or is
longer than twelve steps is outside (`OUTSIDE_RESOURCE`), and nothing is
sent for it. The walk runs again on every call and again at the moment an
approved action is carried out: nothing about containment is remembered
between calls except whether an id is a page or a database, which never
changes.

### What a grant allows

`read` on the resource: a page's title, properties and text; the blocks
under a page or block, with their ids; the rows of a database.

`external.write` on the resource: append text to a page or under a block;
create a page in a database; replace the text of one existing block or tick
a to-do; set a page's properties, title included.

Every write is `publishes: 'external'`, behind the same guard, Attention
policy, pilot gate and `externalOperations` budget as ADR 0028 set. No
separate budget is introduced: a Notion write counts with pushes and pull
requests, 2 a day for a responsibility unless the grant sets a number up to
20.

### A run may write back into the one outside resource it read

A tool's private read can now say where its text lives. `readConnector` is
`source: 'private'` with `sourceScope: 'resource'`; `writeConnector` is
`publishes: 'external'` with `publishesTo: 'resource'`. The run keeps the
set of outside resources it has read and whether it has read anything
private that has no such home (saved notes, generated notes, another
tool). An external write is allowed after a private read only when:

- the write names an outside resource, and
- every private thing the run has read came from that same resource.

So a run can read a Notion page and edit it. It cannot read the person's
notes and write to Notion, read one Notion resource and write to another,
or read two and write to either. Each of those is still `PRIVATE_CONTEXT`.
A push or a pull request after a connector read is still refused, and a
run that shares findings with a project is still not offered connector
reads at all. A resumed run rebuilds the set from its journal, so a crash
does not forget what was read.

The consequence is deliberate: "copy what I noted into Notion" cannot be
delegated. That needs a rule about which private text may go where, which
this decision does not attempt.

### A write is safe to repeat, and each kind says how it is checked

Notion has no idempotency key, so each write carries its own evidence.

- **Adding** (`append`, `createPage`): the added content ends with one
  grey, italic line, "Goobster · ref <12 hex>". The reference is a hash of
  the operation id (`<run>:<step>`), the resource and the input, and is
  nothing else: no title, no text, no person. After a crash the connector
  looks for that line where the write would have put it. Found is done;
  absent is made once; more content than is looked through is unknown,
  which stops the work for review. The line is also how a person reading
  the page can tell what Goobster added.
- **Setting** (`updateBlock`, `updatePage`): setting a value twice is the
  same as setting it once, so the check is a comparison. What is there
  equals what was asked: done. Otherwise it is set.

A failure Notion itself reports (400, 401, 403, 404, 409, 429), and any
failure before the changing request is sent, is `declined`: certainly
nothing changed, and the run is told so. A timeout or a 5xx on the
changing request may have happened and takes the framework's uncertain
path.

### What cannot be granted is asked for, one action at a time

A manifest may list `asks` beside `reads` and `writes`: actions no grant
allows a run to take. Notion has one, `archive` (move one page or block
inside the resource to the trash).

A run with `external.write` on the resource can call `askConnector`. That
changes nothing outside. It checks, with reads only, that the target is
inside the resource, and files one row in `assistant_connector_requests`
and one `question` update with a gate (`connector_request`). The request
appears under Needs you on Home and in the Inbox, in the same decision
card as every other gate. The run is told "Not done: the person has been
asked", so nothing is listed as changed and nothing is counted against the
budget.

The person approves or refuses each request through
`assistantGateService.decide`, which no model tool can reach. Approving
carries out that one action at that moment, with their credential, after
checking again: the pilot gate, the host's stop, the connector and its
feature, that the responsibility is still live and still grants writing
there, the credential, the person's own allowlist, and containment. A
check that can come back (the pilot, the stop, a missing credential,
Notion not answering) leaves the request waiting. One that cannot (the
grant is gone, the target was moved out of the resource; the manifest
names these as `voids`) withdraws it. Refusing changes nothing and the run
is not asked to try again.

Limits: at most five requests can wait per responsibility (`ASK_LIMIT`);
asking twice for the same thing returns the request already waiting; the
granted page or database itself, and a database inside it, can never be
archived from here; nothing is approved in advance or in bulk. A waiting
request is withdrawn when its responsibility ends or stops granting
writing there, when the connector is revoked, or when the connector is no
longer installed.

Permanent deletion is not offered at all, because Notion's API does not
have it.

### Stored data

One new table, `assistant_connector_requests`. Its `label` is the title or
first words of the thing to be archived, which is the person's own content:
it is treated as private user data. Erasure deletes the person's rows, the
export includes them, the transparency and audit counts include them, and
answered requests are pruned with the initiatives window (180 days). No
Notion content, token, link or id is written to a ledger row, a log or an
operator view. The connector module keeps no token.

## Consequences

- The private-read rule is no longer "any private read, then no external
  write". It is narrower in one direction only, and the new allowance is
  checked on both sides (where the text came from, where the write goes).
  A tool that does not declare `sourceScope` or `publishesTo` behaves
  exactly as before.
- A write may cost several Notion requests: the root, the parent walk,
  then the change. A deep block costs more. Notion's rate limit answer
  (429) is a certain refusal and the run reports it.
- An edit cannot be undone from here. The result of every write says so.
  Notion's own page history is the way back.
- The marker is visible in the person's page. That is intended. A person
  who deletes it makes a crashed append look absent, and it would be made
  again once.
- A page with more than 2,000 blocks under one parent cannot be searched
  for a marker; a crashed append there stops for review instead of being
  repeated.
- Per-action approval is a framework feature, not a Notion one. A later
  connector can list its own `asks`.
- What is not built: moving a page, permanent deletion, changing a
  block's type, comments, files and images, a grant on single operations
  of a connector, a second connector.

## Verification

`tests/notionConnector.test.js` (the adapter and whole runs against an
in-memory Notion, `tests/helpers/fakeNotion.js`),
`tests/notionService.test.js` (the requests sent),
`tests/assistantConnectorRequests.test.js` (asking and approving, against
the framework's test double), `tests/assistantConnectors.test.js` (the
private-origin rule) and `e2e/assistantNotion.spec.js` (granting by pasted
link, a run, approving and refusing in the browser). Nothing in the suite
talks to Notion. The evaluation set has two Notion cases
([delegated_evaluation.md](../delegated_evaluation.md)).
