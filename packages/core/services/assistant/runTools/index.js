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
 *  - optional `available({ project, features })`: false keeps the tool off
 *    this run's offer (no linked project, a feature switched off).
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
    ...require('./finish')
};

module.exports = TOOLS;
