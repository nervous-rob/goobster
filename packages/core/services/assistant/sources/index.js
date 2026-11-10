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
 *  - optional `standing: true`: what the adapter returns is work that is
 *    waiting now, so a source seen for the first time is proposed instead
 *    of recorded as a baseline. A source may then carry
 *    `planStep: { id, planRevision }`, stored on the initiative.
 *  - optional `stale(responsibility)`: the proposed or queued attempts of
 *    this kind whose opportunity is gone, as `[{ id, code, supersededBy? }]`.
 *    The initiative service supersedes them on its next pass, so stale
 *    work leaves the list without waiting to be started.
 *  - optional `stream: true` (ADR 0021): the adapter walks a log forward
 *    instead of fingerprinting a record. `read(responsibility, { cursor,
 *    now })` returns one `{ sourceId, revision, events }` (or null), where
 *    `revision` is how far it read and each event is a request to propose,
 *    a change of direction to apply, or both. An event carries `origin`,
 *    stored on the initiative.
 *
 * To add an adapter: add a module here and one line below. The key is the
 * `sourceKind` stored on cursors and initiatives.
 */

const SOURCES = {
    attention_item: require('./attentionItem'),
    project_plan: require('./projectPlan'),
    project_plan_step: require('./projectPlanStep'),
    conversation_request: require('./conversationRequest')
};

module.exports = SOURCES;
