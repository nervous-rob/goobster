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
 *    run's own report).
 *  - `effect`: 'read' or 'write'. It decides crash recovery: a read is safe
 *    to repeat, a write is not - unless it is `atomic`: a write to our own
 *    database that commits in the same transaction as its journal row, so
 *    "in flight" means "did not happen".
 *  - `run(args, ctx)`: does it and returns the text the model sees.
 *  - optional `available({ project, features, planStep })`: false keeps the
 *    tool off this run's offer (no linked project, a feature switched off,
 *    not a plan-step run).
 *  - optional `source: 'private'` (the tool returns the person's private
 *    knowledge) and `publishes: 'project'` (what the tool writes can be
 *    read by the project's audience). A run that has read private
 *    knowledge may not publish into a project other people read, and a
 *    plan-step run in such a project is not offered the private tools.
 *  - optional `final: true`: the tool ends the run with its report; a
 *    resumed run records the report again from its journal.
 *  - optional `budget` ('searches' | 'computeSeconds'), `component` (the
 *    Home component a successful write is reported under),
 *    `reconcile(args, ctx)` (after a crash: did this write happen?) and
 *    `replay(prior, ctx)` (what a resumed run is told instead of the
 *    journaled text).
 *
 * To add a capability: add a module here and one line below. The order of
 * the lines is the order the tools are offered in.
 */

const TOOLS = {
    ...require('./searchWeb'),
    ...require('./lookupNotes'),
    ...require('./projectFiles'),
    ...require('./runProjectFile'),
    ...require('./startResearch'),
    ...require('./generatedNotes'),
    ...require('./consultDocs'),
    ...require('./finish'),
    ...require('./planStep')
};

module.exports = TOOLS;
