/**
 * Live updates for Home and the Responsibilities page (DA-9).
 *
 * Producers call `changed(userId, kind)` when delegated work changes for a
 * person. That publishes `assistant.changed` on the domain event bus with
 * `{ userId, kinds }` and nothing else: no title, no text, no id of the
 * thing that changed. The portal event stream forwards it to that person's
 * own sessions as an `assistant` event, and the client answers by reading
 * Home and the Responsibilities page again through the ordinary routes,
 * which check the session and what it may see on every read. The event is
 * a reason to look, never the data.
 *
 * `watch()` is what a stream subscribes with. It coalesces: the first
 * change is forwarded after a short settle delay (producers publish from
 * inside their transactions, so the read must not race the commit), and
 * after that at most one event every five seconds carries the union of
 * the kinds that changed meanwhile. A burst always ends with one trailing
 * event, so the last state is always fetched.
 *
 * Spec: documentation/delegated_delivery.md ("Live updates").
 */

const domainEventBus = require('./domainEventBus');
const { features } = require('../features/featureState');
const logger = require('../utils/logger');

const TOPIC = domainEventBus.TOPICS.ASSISTANT_CHANGED;
const KINDS = ['update', 'initiative', 'run', 'gate'];
/** At most one forwarded event per person and stream in this window. */
const MIN_INTERVAL_MS = 5000;
/** How long the first change of a burst waits for its transaction to commit. */
const SETTLE_MS = 300;
/** Run progress is published at most this often per run. */
const PROGRESS_INTERVAL_MS = 5000;

/** What the client refetches for each kind (query-key hints, see apps/web/src/lib/parseSse.cjs). */
const BASE_HINTS = ['home', 'assistant-responsibilities', 'assistant-initiatives'];
// An update may be a process incident, or a process paused, archived or restored: the Responsibilities page's
// Processes report reads again too. An update or a request may be a change to the person's notes: so does its
// Notes list.
const KIND_HINTS = {
    update: ['inbox', 'assistant-processes', 'assistant-knowledge'], gate: ['inbox', 'assistant-knowledge'], initiative: [], run: []
};

class AssistantLiveService {
    constructor() {
        this.KINDS = KINDS;
        this.TOPIC = TOPIC;
        this.MIN_INTERVAL_MS = MIN_INTERVAL_MS;
        this._progressAt = new Map();
    }

    /**
     * Announce that delegated work changed for one or more people. Never
     * throws and never waits: a display signal must not fail or slow the
     * work that produced it.
     * @param {string|string[]} userIds
     * @param {string|string[]} kinds - one or more of KINDS
     */
    changed(userIds, kinds) {
        try {
            const list = [...new Set((Array.isArray(kinds) ? kinds : [kinds]).filter(kind => KINDS.includes(kind)))];
            if (!list.length) return;
            const people = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
            for (const userId of people) domainEventBus.publish(TOPIC, { userId, kinds: list });
        } catch (error) {
            logger.warn?.(`[assistant live] publish failed: ${error.message}`);
        }
    }

    /**
     * Run progress (a heartbeat): the same announcement, at most once per
     * run in PROGRESS_INTERVAL_MS, so a busy run does not flood the bus.
     */
    progress(userId, runId) {
        const key = String(runId);
        const now = Date.now();
        if (now - (this._progressAt.get(key) || 0) < PROGRESS_INTERVAL_MS) return;
        this._progressAt.set(key, now);
        if (this._progressAt.size > 500) {
            for (const [id, at] of this._progressAt) {
                if (now - at > 10 * PROGRESS_INTERVAL_MS) this._progressAt.delete(id);
            }
        }
        this.changed(userId, 'run');
    }

    /** A finished run needs no progress clock any more. */
    forgetRun(runId) {
        this._progressAt.delete(String(runId));
    }

    /** The refetch hints for a set of kinds. */
    hintsFor(kinds) {
        const hints = new Set(BASE_HINTS);
        for (const kind of kinds || []) for (const hint of KIND_HINTS[kind] || []) hints.add(hint);
        return [...hints];
    }

    /**
     * May this person's portal be told at all? Asked again before every
     * forwarded event, so a feature turned off, or a pilot decision taken
     * back, stops the events on streams that are already open.
     */
    async allowed(userId) {
        if (features.enforcedOff('assistant')) return false;
        try {
            return await require('./assistantAccessService').allows(String(userId), 'delivery');
        } catch {
            return false;
        }
    }

    /**
     * Subscribe one stream to one person's changes, coalesced.
     * @param {string} userId
     * @param {(event: { kinds: string[], invalidate: string[], at: string }) => void} listener
     * @param {{ minIntervalMs?: number, settleMs?: number }} [options]
     * @returns {() => void} unsubscribe (also drops anything still pending)
     */
    watch(userId, listener, { minIntervalMs = MIN_INTERVAL_MS, settleMs = SETTLE_MS } = {}) {
        const owner = String(userId);
        const pending = new Set();
        let timer = null;
        let lastSentAt = 0;
        let closed = false;

        const flush = async () => {
            timer = null;
            if (closed || !pending.size) return;
            const kinds = KINDS.filter(kind => pending.has(kind));
            pending.clear();
            lastSentAt = Date.now();
            try {
                if (!(await this.allowed(owner)) || closed) return;
                listener({ kinds, invalidate: this.hintsFor(kinds), at: new Date().toISOString() });
            } catch (error) {
                logger.warn?.(`[assistant live] forward failed: ${error.message}`);
            }
        };

        const unsubscribe = domainEventBus.subscribe(TOPIC, (event) => {
            if (closed || event?.payload?.userId !== owner) return;
            for (const kind of event.payload.kinds || []) if (KINDS.includes(kind)) pending.add(kind);
            if (!pending.size || timer) return;
            const wait = Math.max(settleMs, lastSentAt + minIntervalMs - Date.now());
            timer = setTimeout(flush, wait);
            timer.unref?.();
        });

        return () => {
            closed = true;
            pending.clear();
            if (timer) clearTimeout(timer);
            timer = null;
            unsubscribe();
        };
    }
}

module.exports = new AssistantLiveService();
module.exports.AssistantLiveService = AssistantLiveService;
module.exports.KINDS = KINDS;
module.exports.MIN_INTERVAL_MS = MIN_INTERVAL_MS;
