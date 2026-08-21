/**
 * Attention scoring — the pure math behind "is this worth bothering them
 * about?". No I/O, no model calls, no database: everything here is a
 * function of numbers so the interruption policy is testable in isolation
 * (the same separation optionsMath/marginMath get in the exchange).
 *
 * The model:
 *
 *   P = U x I x C x A - K
 *
 *   U  urgency        — how time-pressured this is right now
 *   I  importance     — how much it matters to the person
 *   C  confidence     — how sure Goobster is it understands correctly
 *   A  actionability  — whether there is something useful to do about it
 *   K  interruption   — the cost of speaking up at all, right now
 *
 * The product means a single weak factor is enough to disqualify an
 * intervention, which is the behaviour we want: a very urgent thing Goobster
 * only half-understands should stay quiet, and so should a well-understood
 * thing nobody can act on.
 */

const config = require('../config/attentionConfig');

/** Clamp to the unit interval, mapping junk input to 0. */
function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

/**
 * Urgency from a deadline: zero outside the horizon, saturating at 1 once
 * the deadline is inside the "urgent" window (and for anything overdue).
 * @param {number} msUntilDeadline - negative when already past
 * @param {Object} [bounds]
 * @returns {number} 0..1
 */
function deadlineUrgency(msUntilDeadline, {
    horizonHours = config.CANDIDATES.deadlineHorizonHours,
    urgentHours = config.CANDIDATES.deadlineUrgentHours
} = {}) {
    const ms = Number(msUntilDeadline);
    if (!Number.isFinite(ms)) return 0;
    const horizon = horizonHours * 3600_000;
    const urgent = urgentHours * 3600_000;
    if (ms <= urgent) return 1;
    if (ms >= horizon) return 0;
    // Linear ramp between the horizon and the urgent window.
    return (horizon - ms) / (horizon - urgent);
}

/**
 * Urgency from neglect: a loop that should have moved and hasn't. Ramps from
 * zero at the staleness threshold to 1 at twice the threshold, so "quiet for
 * a bit" is never as loud as "quiet for ages".
 * @param {number} daysIdle
 * @param {number} [staleDays]
 * @returns {number} 0..1
 */
function stalenessUrgency(daysIdle, staleDays = config.CANDIDATES.staleLoopDays) {
    const days = Number(daysIdle);
    if (!Number.isFinite(days) || days <= staleDays) return 0;
    return clamp01((days - staleDays) / staleDays);
}

/**
 * The K term: what it costs to speak up right now, independent of content.
 * @param {Object} pressure
 * @param {number} [pressure.recentNotices] - notices already surfaced today
 * @param {boolean} [pressure.withinCooldown] - contact cooldown still running
 * @param {boolean} [pressure.quietHours] - inside the do-not-disturb window
 * @returns {number} 0..INTERRUPTION.max
 */
function interruptionCost({ recentNotices = 0, withinCooldown = false, quietHours = false } = {}) {
    const k = config.INTERRUPTION;
    let cost = k.base;
    cost += Math.max(0, Number(recentNotices) || 0) * k.perRecentNotice;
    if (withinCooldown) cost += k.withinCooldown;
    if (quietHours) cost += k.quietHours;
    return Math.min(k.max, cost);
}

/**
 * Score one candidate intervention.
 * @param {Object} candidate - { urgency, importance, confidence, actionability }
 * @param {number} [cost] - the K term from interruptionCost()
 * @returns {{ score: number, value: number, urgency: number, importance: number,
 *            confidence: number, actionability: number, interruptionCost: number }}
 */
function scoreCandidate(candidate = {}, cost = 0) {
    const urgency = clamp01(candidate.urgency);
    const importance = clamp01(candidate.importance);
    const confidence = clamp01(candidate.confidence);
    const actionability = clamp01(candidate.actionability);
    const value = urgency * importance * confidence * actionability;
    const interruption = Math.max(0, Number(cost) || 0);
    return {
        urgency,
        importance,
        confidence,
        actionability,
        interruptionCost: interruption,
        value,
        score: value - interruption
    };
}

/**
 * Which band a score falls into. `discard` means the observation is dropped
 * without a trace; every other band produces a notice row.
 * @param {number} score
 * @param {Object} [thresholds]
 * @returns {'discard'|'inbox'|'mention'|'dm'|'urgent'}
 */
function dispositionFor(score, thresholds = config.THRESHOLDS) {
    const n = Number(score);
    if (!Number.isFinite(n) || n < thresholds.discard) return 'discard';
    if (n < thresholds.inbox) return 'inbox';
    if (n < thresholds.mention) return 'mention';
    if (n < thresholds.dm) return 'dm';
    return 'urgent';
}

/**
 * Apply the agency boundary: an intervention may never be louder than the
 * person's initiative level allows. Quieter is always permitted, so this
 * demotes rather than discards — an `observe` user's DM-worthy observation
 * still lands in their inbox, it just doesn't ping them.
 * @param {string} disposition
 * @param {string} initiative - observe | nudge | assist | delegate
 * @returns {'discard'|'inbox'|'mention'|'dm'|'urgent'}
 */
function clampDisposition(disposition, initiative) {
    if (disposition === 'discard') return 'discard';
    const ceiling = config.MAX_DISPOSITION_BY_INITIATIVE[initiative];
    if (!ceiling) return 'inbox';
    const rank = config.DISPOSITION_RANK;
    if ((rank[disposition] ?? 0) <= rank[ceiling]) return disposition;
    return ceiling;
}

/** Whether `level` grants at least as much agency as `required`. */
function initiativeAllows(level, required) {
    const rank = config.INITIATIVE_RANK;
    return (rank[level] ?? -1) >= (rank[required] ?? 99);
}

/**
 * Shift the thresholds for one category based on what the person actually
 * did with past notices in it. Dismissals raise the bar, acting on them
 * lowers it. Deliberately small, bounded, and symmetric — this is
 * calibration, not learning a new policy.
 * @param {Object} outcomes - { dismissed, actedOn, samples }
 * @param {Object} [thresholds] - base bands
 * @returns {Object} shifted bands (same keys)
 */
function calibrateThresholds({ dismissed = 0, actedOn = 0, samples = 0 } = {},
    thresholds = config.THRESHOLDS) {
    const cal = config.CALIBRATION;
    if (samples < cal.minSamples) return { ...thresholds };
    const dismissRate = Math.max(0, dismissed) / samples;
    const actRate = Math.max(0, actedOn) / samples;
    const raw = (dismissRate - actRate) * cal.shiftPerRate;
    const shift = Math.max(-cal.maxShift, Math.min(cal.maxShift, raw));
    const out = {};
    for (const [band, value] of Object.entries(thresholds)) {
        // Bands stay ordered and inside (0, 1) whatever the shift.
        out[band] = Math.max(0.05, Math.min(0.99, value + shift));
    }
    return out;
}

module.exports = {
    clamp01,
    deadlineUrgency,
    stalenessUrgency,
    interruptionCost,
    scoreCandidate,
    dispositionFor,
    clampDisposition,
    initiativeAllows,
    calibrateThresholds
};
