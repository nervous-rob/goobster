/**
 * The personal heartbeat.
 *
 * The guild heartbeat (services/heartbeatService.js) watches *channels*: its
 * unit of attention is recent conversation, and its question is "should I say
 * something in here?". This loop watches *people*: its unit of attention is
 * their open loops, and its question is "has anything changed that Rob would
 * want to know about?".
 *
 * Two loops rather than one because the guardrails are genuinely different.
 * The guild loop is gated on channel activity and server opt-in; this one is
 * gated on personal enrollment, a contact budget, quiet hours, and an
 * initiative ceiling. Merging them would mean one set of thresholds
 * pretending to serve both.
 *
 * The loop itself is deliberately dumb: it wakes up, picks the people who are
 * due (or whom an event has dirtied), and hands each to
 * attentionService.sweepUser. All judgement lives there; all scheduling lives
 * here. It also owns the two things a loop is for: expiring watches that
 * outlived their window, and subscribing the attention system to the domain
 * event bus so a change can bring a sweep forward instead of waiting.
 *
 * Spec: documentation/attention.md
 */

const db = require('../db');
const attentionService = require('./attentionService');
const attentionPolicyService = require('./attentionPolicyService');
const attentionWatchService = require('./attentionWatchService');
const domainEventBus = require('./domainEventBus');
const config = require('../config/attentionConfig');
const { toGateway } = require('../gateway');
const logger = require('../utils/logger');

const { HEARTBEAT } = config;

/** Stored UTC text -> epoch ms. */
function utcMs(text) {
    if (!text) return null;
    const ms = new Date(`${String(text).replace(' ', 'T')}Z`).getTime();
    return Number.isNaN(ms) ? null : ms;
}

class PersonalHeartbeatService {
    /**
     * @param {Object} client - the live discord.js client (wrapped in a
     *   gateway, so nothing below this line touches discord.js)
     */
    constructor(client) {
        this.client = client || null;
        this.gateway = toGateway(client);
        this.timer = null;
        this.firstTick = null;
        this.ticking = false;
        this._unsubscribe = null;
        PersonalHeartbeatService.instance = this;
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => this.tick().catch(error =>
            logger.error?.(`[attention] Tick failed: ${error.message}`)
        ), HEARTBEAT.tickMs);
        this.firstTick = setTimeout(() => this.tick().catch(error =>
            logger.error?.(`[attention] First tick failed: ${error.message}`)
        ), HEARTBEAT.firstTickDelayMs);

        // Events only accelerate the loop; they are never the source of
        // truth (see domainEventBus). A missed event costs one interval.
        this._unsubscribe = domainEventBus.subscribe('*', event => attentionService.onEvent(event));
        attentionWatchService.attach(this.client);

        logger.info?.(`[attention] Personal heartbeat started (every ${Math.round(HEARTBEAT.tickMs / 60000)}m)`);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        if (this.firstTick) clearTimeout(this.firstTick);
        this.timer = null;
        this.firstTick = null;
        if (this._unsubscribe) this._unsubscribe();
        this._unsubscribe = null;
        attentionWatchService.detach();
    }

    /**
     * One pass over the people who are due.
     * @returns {Promise<{swept: number, raised: number, contacted: number, skipped?: boolean}>}
     */
    async tick() {
        const outcome = await db.withSingletonLock('personal_attention', async () => {
            if (this.ticking) return { swept: 0, raised: 0, contacted: 0 };
            this.ticking = true;
            try {
                return await this._tickBody();
            } finally {
                this.ticking = false;
            }
        });
        if (!outcome.acquired) {
            logger.warn?.('[attention] Tick skipped: another process holds the singleton lock');
            return { swept: 0, raised: 0, contacted: 0, skipped: true };
        }
        return outcome.result;
    }

    async _tickBody() {
        const result = { swept: 0, raised: 0, contacted: 0 };
        try {
            await attentionWatchService.expireStale();
        } catch (error) {
            logger.warn?.(`[attention] Watch expiry failed: ${error.message}`);
        }

        const policies = await attentionPolicyService.listActive(HEARTBEAT.maxUsersPerTick);
        const now = Date.now();
        for (const policy of policies) {
            // A person is swept when their interval is up, or sooner if an
            // event flagged them - but never inside the accelerated floor,
            // so a busy conversation cannot sweep on every message.
            const lastSweep = utcMs(policy.lastSweepAt);
            const idle = lastSweep === null ? Infinity : now - lastSweep;
            const due = idle >= HEARTBEAT.sweepIntervalMs
                || (policy.dirtyAt !== null && idle >= HEARTBEAT.dirtySweepIntervalMs);
            if (!due) continue;

            try {
                const summary = await attentionService.sweepUser({
                    policy,
                    gateway: this.gateway
                });
                result.swept++;
                result.raised += summary.raised;
                if (summary.contacted) result.contacted++;
            } catch (error) {
                logger.error?.(`[attention] Sweep for ${policy.userId} failed: ${error.message}`);
            }
        }
        if (result.raised > 0 || result.contacted > 0) {
            logger.info?.(`[attention] Swept ${result.swept} person(s): ${result.raised} noticed, ${result.contacted} contacted`);
        }
        return result;
    }
}

PersonalHeartbeatService.instance = null;

module.exports = PersonalHeartbeatService;
