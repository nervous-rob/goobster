/**
 * Unit tests for the attention scoring math (utils/attentionScore.js).
 *
 * Pure functions, no database and no model: this is the interruption policy
 * in isolation, which is exactly the part that has to be right. If the bands
 * or the initiative ceiling drift, Goobster either nags or goes silent.
 */

const score = require('@goobster/core/utils/attentionScore');
const config = require('@goobster/core/config/attentionConfig');

const HOUR = 3600_000;

describe('deadlineUrgency', () => {
    test('is zero outside the horizon and saturates inside the urgent window', () => {
        expect(score.deadlineUrgency(200 * HOUR)).toBe(0);
        expect(score.deadlineUrgency(config.CANDIDATES.deadlineHorizonHours * HOUR)).toBe(0);
        expect(score.deadlineUrgency(config.CANDIDATES.deadlineUrgentHours * HOUR)).toBe(1);
        expect(score.deadlineUrgency(1 * HOUR)).toBe(1);
    });

    test('treats an overdue deadline as maximally urgent', () => {
        expect(score.deadlineUrgency(-5 * HOUR)).toBe(1);
    });

    test('ramps monotonically between the horizon and the urgent window', () => {
        const far = score.deadlineUrgency(60 * HOUR);
        const near = score.deadlineUrgency(24 * HOUR);
        expect(far).toBeGreaterThan(0);
        expect(near).toBeGreaterThan(far);
        expect(near).toBeLessThan(1);
    });

    test('ignores junk input rather than scoring it', () => {
        expect(score.deadlineUrgency(NaN)).toBe(0);
        expect(score.deadlineUrgency(undefined)).toBe(0);
    });
});

describe('stalenessUrgency', () => {
    test('stays silent until the staleness threshold is crossed', () => {
        expect(score.stalenessUrgency(1)).toBe(0);
        expect(score.stalenessUrgency(config.CANDIDATES.staleLoopDays)).toBe(0);
    });

    test('reaches full urgency at twice the threshold', () => {
        const stale = config.CANDIDATES.staleLoopDays;
        expect(score.stalenessUrgency(stale * 1.5)).toBeCloseTo(0.5, 5);
        expect(score.stalenessUrgency(stale * 2)).toBe(1);
        expect(score.stalenessUrgency(stale * 10)).toBe(1);
    });
});

describe('interruptionCost', () => {
    test('a fresh, quiet moment costs only the baseline', () => {
        expect(score.interruptionCost({})).toBeCloseTo(config.INTERRUPTION.base, 5);
    });

    test('accumulates with notice pressure, cooldown, and quiet hours', () => {
        const quiet = score.interruptionCost({});
        const busy = score.interruptionCost({ recentNotices: 3 });
        const cooling = score.interruptionCost({ withinCooldown: true });
        expect(busy).toBeGreaterThan(quiet);
        expect(cooling).toBeGreaterThan(quiet);
        expect(score.interruptionCost({ quietHours: true })).toBeGreaterThan(cooling);
    });

    test('is capped so a genuinely urgent thing is never mathematically impossible', () => {
        const worst = score.interruptionCost({
            recentNotices: 100, withinCooldown: true, quietHours: true
        });
        expect(worst).toBe(config.INTERRUPTION.max);
        expect(worst).toBeLessThan(1);
    });
});

describe('scoreCandidate', () => {
    test('multiplies the four factors and subtracts the interruption cost', () => {
        const result = score.scoreCandidate(
            { urgency: 0.5, importance: 0.8, confidence: 1, actionability: 1 },
            0.1
        );
        expect(result.value).toBeCloseTo(0.4, 5);
        expect(result.score).toBeCloseTo(0.3, 5);
    });

    test('one weak factor disqualifies the whole intervention', () => {
        // Urgent, important, actionable - but Goobster barely understands it.
        const misunderstood = score.scoreCandidate(
            { urgency: 1, importance: 1, confidence: 0.1, actionability: 1 }
        );
        expect(score.dispositionFor(misunderstood.score)).toBe('discard');

        // Perfectly understood and important, but nothing to do about it.
        const inert = score.scoreCandidate(
            { urgency: 1, importance: 1, confidence: 1, actionability: 0.1 }
        );
        expect(score.dispositionFor(inert.score)).toBe('discard');
    });

    test('clamps factors outside the unit interval', () => {
        const result = score.scoreCandidate(
            { urgency: 5, importance: -2, confidence: 'x', actionability: 1 }
        );
        expect(result.urgency).toBe(1);
        expect(result.importance).toBe(0);
        expect(result.confidence).toBe(0);
    });
});

describe('dispositionFor', () => {
    test('maps scores onto the bands in order', () => {
        const t = config.THRESHOLDS;
        expect(score.dispositionFor(t.discard - 0.01)).toBe('discard');
        expect(score.dispositionFor(t.discard)).toBe('inbox');
        expect(score.dispositionFor(t.inbox)).toBe('mention');
        expect(score.dispositionFor(t.mention)).toBe('dm');
        expect(score.dispositionFor(t.dm)).toBe('urgent');
    });

    test('the bands stay ordered and cover the range the product can reach', () => {
        const t = config.THRESHOLDS;
        expect(t.discard).toBeLessThan(t.inbox);
        expect(t.inbox).toBeLessThan(t.mention);
        expect(t.mention).toBeLessThan(t.dm);
        // A near-perfect intervention must actually be able to interrupt:
        // four factors multiplied stay well below 1 even when all are high.
        const strongest = score.scoreCandidate(
            { urgency: 1, importance: 0.95, confidence: 0.95, actionability: 0.95 },
            config.INTERRUPTION.base
        );
        expect(strongest.score).toBeGreaterThan(t.dm);
    });

    test('respects caller-supplied (calibrated) thresholds', () => {
        const strict = { discard: 0.6, inbox: 0.8, mention: 0.9, dm: 0.95 };
        expect(score.dispositionFor(0.5, strict)).toBe('discard');
        expect(score.dispositionFor(0.7, strict)).toBe('inbox');
    });
});

describe('clampDisposition', () => {
    test('observe never reaches out, but still fills the inbox', () => {
        expect(score.clampDisposition('urgent', 'observe')).toBe('inbox');
        expect(score.clampDisposition('dm', 'observe')).toBe('inbox');
        expect(score.clampDisposition('inbox', 'observe')).toBe('inbox');
    });

    test('nudge may DM but never interrupt', () => {
        expect(score.clampDisposition('urgent', 'nudge')).toBe('dm');
        expect(score.clampDisposition('mention', 'nudge')).toBe('mention');
    });

    test('delegate is allowed the whole range', () => {
        expect(score.clampDisposition('urgent', 'delegate')).toBe('urgent');
    });

    test('a discarded candidate stays discarded whatever the level', () => {
        for (const level of config.INITIATIVE_LEVELS) {
            expect(score.clampDisposition('discard', level)).toBe('discard');
        }
    });
});

describe('initiativeAllows', () => {
    test('orders the spectrum', () => {
        expect(score.initiativeAllows('delegate', 'nudge')).toBe(true);
        expect(score.initiativeAllows('observe', 'nudge')).toBe(false);
        expect(score.initiativeAllows('nudge', 'nudge')).toBe(true);
        expect(score.initiativeAllows('nudge', 'assist')).toBe(false);
        expect(score.initiativeAllows('assist', 'delegate')).toBe(false);
    });
});

describe('calibrateThresholds', () => {
    test('does nothing without enough evidence', () => {
        expect(score.calibrateThresholds({ dismissed: 1, actedOn: 0, samples: 1 }))
            .toEqual(config.THRESHOLDS);
    });

    test('raises the bar for a category the person keeps dismissing', () => {
        const shifted = score.calibrateThresholds({ dismissed: 8, actedOn: 0, samples: 8 });
        expect(shifted.inbox).toBeGreaterThan(config.THRESHOLDS.inbox);
        expect(shifted.dm).toBeGreaterThan(config.THRESHOLDS.dm);
    });

    test('lowers the bar for a category the person acts on', () => {
        const shifted = score.calibrateThresholds({ dismissed: 0, actedOn: 8, samples: 8 });
        expect(shifted.inbox).toBeLessThan(config.THRESHOLDS.inbox);
    });

    test('bounds the shift and keeps every band inside (0, 1)', () => {
        const extreme = score.calibrateThresholds({ dismissed: 1000, actedOn: 0, samples: 1000 });
        expect(extreme.dm - config.THRESHOLDS.dm).toBeLessThanOrEqual(config.CALIBRATION.maxShift + 1e-9);
        for (const value of Object.values(extreme)) {
            expect(value).toBeGreaterThan(0);
            expect(value).toBeLessThan(1);
        }
    });
});
