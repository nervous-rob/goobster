/**
 * The Goobster event bus (reactive port spec §6, §9): bot-side happenings
 * that the web portal wants to hear about (a follow-up delivered, an
 * automation run finished, an agent run updated) flow to any process
 * serving `GET /api/app/events`.
 *
 * Transport is engine-shaped:
 *  - Always: an in-process EventEmitter, which is the whole story for the
 *    lite single-process deployment (SQLite or Postgres alike).
 *  - On Postgres: publish() additionally pg_notify()s the goobster_events
 *    channel, and the first subscriber starts a LISTEN connection, so
 *    events cross the bot/api process boundary with no new infrastructure.
 *    Events carry the publishing process id; a process skips its own
 *    notifications (it already delivered them locally).
 *
 * Payloads are ids and hints only - never message content - and publishing
 * is fire-and-forget (wrapped like usageTracker.log: an event bus problem
 * must never break the action that emitted the event).
 */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const db = require('../db');
const logger = require('../utils/logger');

const CHANNEL = 'goobster_events';
const PROCESS_ID = crypto.randomBytes(8).toString('hex');
// pg_notify payloads cap at ~8000 bytes; events are tiny, but guard anyway.
const MAX_PAYLOAD_CHARS = 7500;

/** What the reactive client should refetch when each event kind arrives. */
const INVALIDATION_HINTS = {
    'followup-delivered': ['tasks', 'home'],
    'automation-ran': ['tasks', 'home'],
    'agent-run-updated': ['home'],
    // The attention system noticed something (or the user reacted to it).
    'attention-noticed': ['attention', 'home'],
    // Multi-user parlors: another human acted in a shared discussion.
    // Scoped hints (e.g. parlor-messages:<conversationId>) ride the event
    // payload's own `invalidate` list, so only the affected discussion
    // refetches.
    // Web chat turn lifecycle (started/settled). All refetch hints are
    // scoped and ride the event payload's own `invalidate` list.
    'web-turn': [],
    'parlor-turn': ['parlor-conversations'],
    'parlor-invite': ['parlor-invites'],
    'parlor-members': ['parlor-conversations', 'parlor-invites'],
    // Someone @-mentioned this user in a shared parlor discussion while
    // they were online in the portal. The transcript refetch already rides
    // the parlor-turn event; this one exists for the in-app notification.
    'parlor-mention': []
};

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let pgListenerStop = null;
let pgListenerStarted = false;

function ensureCrossProcessListener() {
    if (pgListenerStarted) return;
    if (db.engine !== 'postgres') return; // lite: one process, local emitter is complete
    pgListenerStarted = true;
    pgListenerStop = db.listenNotifications(CHANNEL, (text) => {
        let event;
        try {
            event = JSON.parse(text);
        } catch {
            return; // not ours
        }
        if (!event?.kind || event.src === PROCESS_ID) return;
        emitter.emit('event', event);
    }, { logger });
}

/**
 * Publish one event. Fire-and-forget: never throws, never blocks the
 * caller on the cross-process notify.
 * @param {string} kind - e.g. 'followup-delivered'
 * @param {Object} payload - ids/hints only; MUST carry the userId the
 *   event belongs to (the SSE stream is strictly user-scoped)
 */
function publish(kind, payload = {}) {
    const event = { kind, payload, src: PROCESS_ID, at: new Date().toISOString() };
    try {
        emitter.emit('event', event);
    } catch (error) {
        logger.warn?.(`[events] local emit failed: ${error.message}`);
    }
    if (db.engine === 'postgres') {
        try {
            const text = JSON.stringify(event);
            if (text.length <= MAX_PAYLOAD_CHARS) {
                db.rawQuery('SELECT pg_notify($1, $2)', [CHANNEL, text])
                    .catch(error => logger.warn?.(`[events] pg_notify failed: ${error.message}`));
            }
        } catch (error) {
            logger.warn?.(`[events] publish failed: ${error.message}`);
        }
    }
}

/**
 * Subscribe to every event this process can see (local + cross-process).
 * @param {(event: {kind, payload, at}) => void} listener
 * @returns {() => void} unsubscribe
 */
function subscribe(listener) {
    ensureCrossProcessListener();
    const handler = (event) => {
        try {
            listener(event);
        } catch (error) {
            logger.warn?.(`[events] subscriber failed: ${error.message}`);
        }
    };
    emitter.on('event', handler);
    return () => emitter.off('event', handler);
}

/** The refetch hints for one event kind (empty for unknown kinds). */
function invalidationHints(kind) {
    return INVALIDATION_HINTS[kind] || [];
}

/** Stop the cross-process listener (shutdown / test teardown). */
async function close() {
    const stop = pgListenerStop;
    pgListenerStop = null;
    pgListenerStarted = false;
    if (stop) await stop();
}

module.exports = { publish, subscribe, invalidationHints, close, CHANNEL };
