/**
 * The run tool table (ADR 0018, decision 1): everything a delegated run can
 * do. `assistantRunService.TOOLS` is this object; a tool that is not in it
 * does not run.
 *
 * One module per capability. Each exports `{ <toolName>: spec }`, where a
 * spec is:
 *  - `definition`: the function definition offered to the model.
 *  - `needs(args, ctx)`: the operation and resource `authorize()` must
 *    allow (with `also: [...]` for more than one), `{ refuse: CODE }`, or
 *    null for a tool that touches nothing of the person's (public docs, the
 *    run's own report). It may be async when the resource has to be looked
 *    up in our own database.
 *  - `effect`: 'read' or 'write'. It decides crash recovery: a read is safe
 *    to repeat, a write is not - unless it is `atomic`: a write to our own
 *    database that commits in the same transaction as its journal row, so
 *    "in flight" means "did not happen".
 *  - `run(args, ctx)`: does it and returns the text the model sees.
 *  - optional `available({ project, features, planStep, grants, capabilities })`:
 *    false keeps the tool off this run's offer (no linked project, a
 *    feature switched off, not a plan-step run, an operation the grant does
 *    not name, a capability still in the pilot that the owner does not
 *    have).
 *  - optional `source: 'private'` (the tool returns the person's private
 *    knowledge) and `publishes`: 'project' (what the tool writes can be
 *    read by the project's audience) or 'external' (it leaves this
 *    installation). A run that has read private knowledge may not publish
 *    into a project other people read and may not publish externally at
 *    all, and a plan-step run in a shared project is not offered the
 *    private tools.
 *  - optional `final: true`: the tool ends the run with its report; a
 *    resumed run records the report again from its journal.
 *  - optional `guard(args, ctx)`: asked after `authorize()` allowed the call
 *    and before it is journaled as dispatched; returns a refusal code or
 *    null. For what only the outside world can say (is that branch
 *    protected?), which must not be asked before authority is established.
 *    A guard that throws refuses.
 *  - optional `budget` ('searches' | 'computeSeconds' |
 *    'externalOperations'), `component` (the Home component a successful
 *    write is reported under), `reconcile(args, ctx)` (after a crash: did
 *    this write happen?) and `replay(prior, ctx)` (what a resumed run is
 *    told instead of the journaled text).
 *
 * A write that declines answers with text starting "Not " ("Not pushed:
 * ..."): it changed nothing, is left out of the run's "Changed:" list and
 * does not count against `externalOperations`. A spec with `proposes: true`
 * changes nothing either: it files a request for the person to decide, and
 * the run's report lists it as waiting for them, not as changed. A spec
 * with `quiet: true` records evidence only and is not reported at all.
 *
 * To add a capability: add a module here and one line below. The order of
 * the lines is the order the tools are offered in.
 */

const TOOLS = {
    ...require('./searchWeb'),
    ...require('./lookupNotes'),
    ...require('./projectFiles'),
    ...require('./runProjectFile'),
    ...require('./projectRepos'),
    ...require('./connectors'),
    ...require('./startResearch'),
    ...require('./generatedNotes'),
    ...require('./savedNotes'),
    ...require('./consultDocs'),
    ...require('./finish'),
    ...require('./planStep')
};

module.exports = TOOLS;
