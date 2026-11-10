/**
 * Marks the code that runs because a model called a tool.
 *
 * Every dispatcher that executes a model's tool call wraps the call in
 * `run()`: the chat tool registry, the agent loop (which also covers the
 * delegated run executor and any other custom executor), the voice turn
 * loop and the MCP server. Operations that only a person may take ask
 * `active()` and refuse, whatever arguments the call carried.
 *
 * This is the structural half of "a model call is never a confirmation"
 * (ADR 0023). It does not replace the checks a human-only operation makes
 * for itself (a session, a revision, a confirmation receipt); it makes the
 * model's side provable: no tool, present or future, reaches a human-only
 * operation by calling it.
 *
 * The scope follows the call through awaits (AsyncLocalStorage). Work a
 * tool hands to a queue that another context drains is outside it, which is
 * correct: that work is no longer the model's call.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

const HUMAN_ONLY = 'HUMAN_ONLY';

/**
 * Run `fn` as a model tool call.
 * @param {string} origin - which dispatcher and tool, for diagnostics (`chat:rememberFact`)
 * @param {Function} fn
 */
function run(origin, fn) {
    const outer = storage.getStore();
    return storage.run({ origin: String(origin || 'tool'), outer: outer ? outer.origin : null }, fn);
}

/** The enclosing model tool call, or null. */
function current() {
    return storage.getStore() || null;
}

/** True while a model tool call is on the stack. */
function active() {
    return Boolean(storage.getStore());
}

/**
 * Throw `makeError()` when a model tool call is on the stack. The error a
 * human-only operation raises is its own class, so the caller supplies it.
 * @param {() => Error} makeError
 */
function assertHuman(makeError) {
    if (active()) throw makeError();
}

module.exports = { run, current, active, assertHuman, HUMAN_ONLY };
