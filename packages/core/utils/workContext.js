/**
 * The current piece of work (roadmap #256).
 *
 * work_failures, resource_events and usage_reservations join on one key:
 * (workKind, workId) - the chat turn, expedition, job or automation that a
 * cost or a failure belongs to. The code that knows that id (the chat
 * handler, the expedition runner, the automation loop) is several calls
 * away from the code that spends the resource (a search adapter, the
 * sandbox spawn), so the id travels in AsyncLocalStorage instead of being
 * threaded through every signature.
 *
 *   workContext.run({ kind: 'expedition', id: 12, actor: userId }, () => ...)
 *   workContext.current()  // -> { kind, id, actor, payer } or null
 *
 * Nested runs keep the outer work: an unattended chat turn inside an
 * automation is the automation's cost and the automation's failure. The
 * context is read-only advice - a caller that knows better passes the ids
 * explicitly and wins.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/**
 * @typedef {Object} WorkRef
 * @property {string} kind - a work_failures kind: 'chat', 'expedition', 'job', ...
 * @property {string|number|null} id - the row id of that work
 * @property {string|null} [actor] - principal who started it
 * @property {string|null} [payer] - scope that pays (defaults to the actor)
 */

/**
 * Run `fn` with `work` as the current piece of work. An existing context
 * wins unless `replace` is set - a nested turn stays attributed to the
 * automation or expedition that started it.
 * @template T
 * @param {WorkRef} work
 * @param {() => T} fn
 * @param {{ replace?: boolean }} [options]
 * @returns {T}
 */
function run(work, fn, { replace = false } = {}) {
    const existing = storage.getStore();
    if (existing && !replace) return fn();
    const ref = normalize(work);
    return ref ? storage.run(ref, fn) : fn();
}

/** @returns {WorkRef|null} */
function current() {
    return storage.getStore() || null;
}

/** @param {WorkRef|null|undefined} work */
function normalize(work) {
    if (!work || !work.kind) return null;
    return {
        kind: String(work.kind),
        id: work.id == null ? null : String(work.id),
        actor: work.actor == null ? null : String(work.actor),
        payer: work.payer == null ? (work.actor == null ? null : String(work.actor)) : String(work.payer)
    };
}

module.exports = { run, current, normalize };
