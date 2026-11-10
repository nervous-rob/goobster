/**
 * Initiative source adapters (ADR 0017), keyed by source kind.
 * `assistantInitiativeService.SOURCES` is this object.
 *
 * One module per adapter. Each exports:
 *  - `read(responsibility)`: the CURRENT material state of the records the
 *    responsibility links to, as
 *    `[{ sourceId, revision, title, reason, category }]`. `revision` is a
 *    fingerprint of what is material; the text names the record and never
 *    copies private content.
 *  - optional `feature`: the adapter is skipped while that feature is off.
 *
 * To add an adapter: add a module here and one line below. The key is the
 * `sourceKind` stored on cursors and initiatives.
 */

const SOURCES = {
    attention_item: require('./attentionItem'),
    project_plan: require('./projectPlan')
};

module.exports = SOURCES;
