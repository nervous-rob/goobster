/**
 * The internal domain event bus: "something changed" announcements that other
 * services can react to, as opposed to the portal event bus
 * (services/eventBusService.js) which exists to tell a browser what to refetch.
 *
 * Why a second bus: the portal bus is a user-scoped SSE feed, and everything
 * on it reaches a browser. Domain events are service-to-service, carry topics
 * rather than refetch hints, and are subscribed to with wildcards. Mixing the
 * two would either leak internal chatter to clients or force domain
 * subscribers to filter portal noise.
 *
 * Transport mirrors the portal bus so there is no new infrastructure:
 *  - Always: an in-process EventEmitter, which is the whole story for the lite
 *    single-process deployment.
 *  - On Postgres: publish() also pg_notify()s a dedicated channel and the
 *    first subscriber starts LISTENing, so events cross the bot/api boundary.
 *    A process skips its own notifications (it delivered them locally).
 *
 * **Events are hints, never the source of truth.** Nothing here is durable: a
 * subscriber that is restarting misses whatever fires in the meantime. The
 * attention system is built on that assumption — its candidates are re-derived
 * deterministically from database state on every sweep, and events only make
 * it look sooner. Never put a decision on this bus that cannot be recomputed.
 *
 * Payloads are ids and small scalars. Publishing is fire-and-forget: a bus
 * problem must never break the action that emitted the event.
 */

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const db = require('../db');
const logger = require('../utils/logger');

const CHANNEL = 'goobster_domain_events';
const PROCESS_ID = crypto.randomBytes(8).toString('hex');
/** pg_notify payloads cap at ~8000 bytes; domain events are tiny. */
const MAX_PAYLOAD_CHARS = 7500;

/**
 * The internal event vocabulary. Publishers must use a listed topic so
 * subscribers can rely on the shape, and so the set stays reviewable rather
 * than growing into free-form strings.
 */
const TOPICS = {
    CONVERSATION_MESSAGE_CREATED: 'conversation.message_created',

    KNOWLEDGE_NODE_CREATED: 'knowledge.node_created',
    KNOWLEDGE_CONTRADICTION_DETECTED: 'knowledge.contradiction_detected',
    REFLECTION_COMPLETED: 'reflection.completed',

    OBSERVATORY_JOB_STARTED: 'observatory.job_started',
    OBSERVATORY_JOB_COMPLETED: 'observatory.job_completed',
    OBSERVATORY_JOB_FAILED: 'observatory.job_failed',
    OBSERVATORY_JOB_INTERRUPTED: 'observatory.job_interrupted',

    ATTENTION_ITEM_CREATED: 'attention.item_created',
    ATTENTION_ITEM_RESOLVED: 'attention.item_resolved',
    ATTENTION_NOTICE_SURFACED: 'attention.notice_surfaced',

    AUTOMATION_RAN: 'automation.ran',
    FOLLOWUP_DELIVERED: 'followup.delivered'
};

const KNOWN_TOPICS = new Set(Object.values(TOPICS));

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
        if (!event?.topic || event.src === PROCESS_ID) return;
        emitter.emit('event', event);
    }, { logger });
}

/**
 * Does an event topic match a subscription pattern? Patterns are either an
 * exact topic, a namespace wildcard ('observatory.*'), or '*' for everything.
 * @param {string} topic
 * @param {string} pattern
 * @returns {boolean}
 */
function topicMatches(topic, pattern) {
    if (pattern === '*') return true;
    if (pattern === topic) return true;
    if (pattern.endsWith('.*')) {
        return String(topic).startsWith(pattern.slice(0, -1));
    }
    return false;
}

/**
 * Announce that something changed. Never throws.
 * @param {string} topic - one of TOPICS
 * @param {Object} payload - ids and small scalars; include userId when the
 *   event belongs to one person so per-user subscribers can filter cheaply
 */
function publish(topic, payload = {}) {
    if (!KNOWN_TOPICS.has(topic)) {
        logger.warn?.(`[domain-events] refusing unknown topic: ${topic}`);
        return;
    }
    const event = { topic, payload, src: PROCESS_ID, at: new Date().toISOString() };
    try {
        emitter.emit('event', event);
    } catch (error) {
        logger.warn?.(`[domain-events] local emit failed: ${error.message}`);
    }
    if (db.engine === 'postgres') {
        try {
            const text = JSON.stringify(event);
            if (text.length <= MAX_PAYLOAD_CHARS) {
                db.rawQuery('SELECT pg_notify($1, $2)', [CHANNEL, text])
                    .catch(error => logger.warn?.(`[domain-events] pg_notify failed: ${error.message}`));
            }
        } catch (error) {
            logger.warn?.(`[domain-events] publish failed: ${error.message}`);
        }
    }
}

/**
 * Subscribe to matching topics. A throwing listener is logged and ignored:
 * one bad subscriber must not stop the others.
 * @param {string|string[]} patterns - topic, namespace wildcard, or '*'
 * @param {(event: {topic: string, payload: Object, at: string}) => void} listener
 * @returns {() => void} unsubscribe
 */
function subscribe(patterns, listener) {
    ensureCrossProcessListener();
    const list = (Array.isArray(patterns) ? patterns : [patterns]).map(String);
    const handler = (event) => {
        if (!list.some(pattern => topicMatches(event.topic, pattern))) return;
        try {
            const result = listener(event);
            // Async subscribers are the norm here (they hit the database);
            // swallow their rejections for the same reason as the sync path.
            if (result && typeof result.catch === 'function') {
                result.catch(error =>
                    logger.warn?.(`[domain-events] subscriber failed: ${error.message}`));
            }
        } catch (error) {
            logger.warn?.(`[domain-events] subscriber failed: ${error.message}`);
        }
    };
    emitter.on('event', handler);
    return () => emitter.off('event', handler);
}

/** Stop the cross-process listener (shutdown / test teardown). */
async function close() {
    const stop = pgListenerStop;
    pgListenerStop = null;
    pgListenerStarted = false;
    if (stop) await stop();
}

module.exports = { publish, subscribe, topicMatches, close, TOPICS, CHANNEL };
