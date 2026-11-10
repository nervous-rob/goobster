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
 * DA-8 (ADR 0026) adds, all optional, all described in
 * documentation/delegated_opportunity_sources.md:
 *  - `capability`: the pilot capability (assistantAccessService) the adapter
 *    needs. While it is closed for the owner, or the host's stop-all is on,
 *    the adapter reads nothing, and a closed capability withdraws what it
 *    proposed.
 *  - `dailyCap(source)`: the proposals per responsibility per day this
 *    source may take (null = uncapped). What is over the cap is counted and
 *    folded into the cursor, not queued.
 *  - a record adapter's `read(responsibility, { cursors, now })` may mark a
 *    source `observe: true` (the cursor moves, nothing is proposed) and give
 *    a `cursorRevision` when the cursor remembers more than the revision a
 *    proposal is deduplicated on. A stream event may say `propose: true`.
 *  - `alreadyWork(responsibility, event)`: a stream event that is work
 *    already.
 *  - `locate(responsibility, origin)`: the source of an attempt as it is
 *    now, or why it is gone (used by `stale` and by the run).
 *  - `lookback(responsibility)`: what activation tells the owner about the
 *    history the adapter will not act on.
 *
 * DA-5c (ADR 0029) adds `process_incident`: a failing process the grant
 * names for repair. It uses `capability`, `standing`, `stale` and `locate`.
 *
 * To add an adapter: add a module here and one line below. The key is the
 * `sourceKind` stored on cursors and initiatives.
 */

const SOURCES = {
    attention_item: require('./attentionItem'),
    project_plan: require('./projectPlan'),
    project_plan_step: require('./projectPlanStep'),
    conversation_request: require('./conversationRequest'),
    chat_request: require('./chatRequest'),
    followed_source: require('./followedSource'),
    job_failure: require('./jobFailure'),
    ci_verdict: require('./ciVerdict'),
    process_incident: require('./processIncident')
};

module.exports = SOURCES;
