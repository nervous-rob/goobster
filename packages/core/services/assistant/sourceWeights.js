/**
 * What feedback taught about a source adapter (DA-10, ADR 0031;
 * documentation/delegated_feedback.md).
 *
 * One row of `assistant_source_weights` belongs to one adapter of one
 * responsibility. It changes one thing: how many opportunities a day that
 * adapter may PROPOSE under that responsibility. It is read where the daily
 * proposal cap is taken (assistantInitiativeService._propose) and nowhere
 * else, so it cannot change what a grant allows, what a run may spend or
 * which tools a run has.
 *
 *  - `weight` is the explicit part. Each "less of this" moves it one step
 *    down `STEPS` (1, 0.5, 0.25, 0) and the cap is the adapter's usual cap
 *    times the weight, rounded, never below one while the weight is above
 *    zero. Only "less of this" reaches zero, and only a reset raises it.
 *  - `dismissals` and `acceptances` are the weak part: a proposal dismissed
 *    or left alone, a finding called "already knew" (dismissals); a proposal
 *    started, a result accepted, a finding called "useful" (acceptances).
 *    Every `WEAK_PER_STEP` dismissals not offset by an acceptance take one
 *    more off the cap, at most `WEAK_MAX / WEAK_PER_STEP` and never below
 *    one a day. Weak signals alone cannot silence a source.
 *  - Nothing here ever returns a cap above the adapter's own.
 *  - Deleting the row is the reset.
 *
 * Only an adapter that notices things by itself learns (`learns` in
 * ./sources/index.js). Work a person asked for is always taken.
 */

const db = require('../../db');
const { DEFAULT_MAX_PER_DAY } = require('./proposalCaps');

/** The weights "less of this" steps through, in order. */
const STEPS = [1, 0.5, 0.25, 0];
/** Net dismissals that take one proposal a day off the cap. */
const WEAK_PER_STEP = 5;
/** Net dismissals (or acceptances) counted at most, so the count can always be worked back. */
const WEAK_MAX = 10;
const SIGNALS = ['dismissals', 'acceptances'];
/** Rows of a responsibility that ended are kept this long. */
const RETENTION_DAYS = 180;

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

const sources = () => require('./sources');

/** Does feedback change this adapter's rate for an item with this origin? */
function learnsFrom(adapter, origin = null) {
    if (!adapter) return false;
    return typeof adapter.learns === 'function' ? Boolean(adapter.learns(origin)) : adapter.learns === true;
}

/** The position of a stored weight on `STEPS` (the nearest step at or below it). */
function stepOf(weight) {
    const value = Number(weight);
    if (!Number.isFinite(value)) return 0;
    const index = STEPS.findIndex(step => value >= step - 1e-9);
    return index === -1 ? STEPS.length - 1 : index;
}

/**
 * The cap a row leaves of a usual cap. Pure.
 * @param {number} base - the adapter's usual cap for a day
 * @param {{ weight: number, dismissals: number, acceptances: number }} row
 */
function scale(base, row) {
    const usual = Math.max(0, Math.trunc(Number(base) || 0));
    if (!row || usual === 0) return usual;
    const weight = STEPS[stepOf(row.weight)];
    if (weight === 0) return 0;
    const explicit = Math.max(1, Math.round(usual * weight));
    const net = Math.min(WEAK_MAX, Math.max(0, Number(row.dismissals || 0) - Number(row.acceptances || 0)));
    return Math.min(usual, Math.max(1, explicit - Math.floor(net / WEAK_PER_STEP)));
}

/** An adapter's usual daily cap: its own, or the default it gets once something was learned. */
function usualCap(adapter) {
    return Number.isInteger(adapter?.MAX_PER_DAY) ? adapter.MAX_PER_DAY : DEFAULT_MAX_PER_DAY;
}

async function get(responsibilityId, adapter) {
    return db.get(
        'SELECT * FROM assistant_source_weights WHERE responsibilityId = @rid AND adapter = @adapter',
        { rid: Number(responsibilityId), adapter: String(adapter) }
    );
}

/**
 * The daily proposal cap for one source right now (null = no cap).
 * An adapter with its own cap has it scaled. An adapter without one stays
 * uncapped until something lowered it, and then gets the default cap,
 * scaled. A source its adapter leaves uncapped on purpose (a request made
 * by name) and an adapter that does not learn are returned untouched.
 */
async function capFor({ responsibilityId, sourceKind, adapter, source = null }) {
    const own = typeof adapter?.dailyCap === 'function';
    const base = own ? (adapter.dailyCap(source) ?? null) : null;
    if (!learnsFrom(adapter, source?.origin)) return base;
    if (own && base == null) return null;
    const row = await get(responsibilityId, sourceKind);
    if (!row) return base;
    const usual = base ?? DEFAULT_MAX_PER_DAY;
    const scaled = scale(usual, row);
    return base == null && scaled >= usual ? null : scaled;
}

async function ensure(responsibility, adapter) {
    await db.run(
        `INSERT INTO assistant_source_weights (responsibilityId, ownerUserId, adapter)
         VALUES (@rid, @owner, @adapter)
         ON CONFLICT (responsibilityId, adapter) DO NOTHING`,
        { rid: Number(responsibility.id), owner: String(responsibility.ownerUserId), adapter: String(adapter) }
    );
}

/**
 * One explicit "less of this": the weight moves one step down.
 * @returns {Promise<{ changed: boolean, from: number, to: number }>} `changed: false` when it was already zero
 */
async function lower({ responsibility, adapter }) {
    await ensure(responsibility, adapter);
    const row = await get(responsibility.id, adapter);
    const at = stepOf(row.weight);
    const from = STEPS[at];
    if (at >= STEPS.length - 1) return { changed: false, from, to: from };
    const to = STEPS[at + 1];
    await db.run(
        `UPDATE assistant_source_weights SET weight = @to, updatedAt = @now
         WHERE responsibilityId = @rid AND adapter = @adapter`,
        { rid: Number(responsibility.id), adapter: String(adapter), to, now: utcText() }
    );
    return { changed: true, from, to };
}

/** Count one weak signal. The lead of one counter over the other stops at `WEAK_MAX`. */
async function count({ responsibility, adapter, signal }) {
    if (!SIGNALS.includes(signal)) throw new Error(`signal must be one of ${SIGNALS.join(', ')}`);
    const other = signal === 'dismissals' ? 'acceptances' : 'dismissals';
    await ensure(responsibility, adapter);
    await db.run(
        `UPDATE assistant_source_weights
         SET ${signal} = CASE WHEN ${signal} - ${other} >= @max THEN ${signal} ELSE ${signal} + 1 END, updatedAt = @now
         WHERE responsibilityId = @rid AND adapter = @adapter`,
        { rid: Number(responsibility.id), adapter: String(adapter), max: WEAK_MAX, now: utcText() }
    );
}

/** A row as its owner sees it: what was learned, and the rate it leaves. */
function describe(row) {
    const adapter = sources()[row.adapter] || null;
    const capped = typeof adapter?.dailyCap === 'function';
    const usual = usualCap(adapter);
    const cap = scale(usual, row);
    const step = stepOf(row.weight);
    return {
        responsibilityId: Number(row.responsibilityId),
        adapter: row.adapter,
        weight: STEPS[step],
        lowered: step,
        dismissals: Number(row.dismissals || 0),
        acceptances: Number(row.acceptances || 0),
        // What the adapter may propose in a day without anything learned (null = no daily limit).
        usual: capped ? usual : null,
        // What it may propose in a day now (null = still no daily limit).
        cap: !capped && cap >= usual ? null : cap,
        stopped: cap === 0,
        updatedAt: row.updatedAt
    };
}

/** Everything learned for one person, by responsibility and adapter. */
async function listFor(userId) {
    const rows = await db.all(
        'SELECT * FROM assistant_source_weights WHERE ownerUserId = @userId ORDER BY responsibilityId, adapter',
        { userId: String(userId) }
    );
    return rows.map(describe);
}

/** The reset: forget what was learned about one adapter (or every adapter) of a responsibility. */
async function reset({ userId, responsibilityId, adapter = null }) {
    const params = { userId: String(userId), rid: Number(responsibilityId) };
    let where = 'ownerUserId = @userId AND responsibilityId = @rid';
    if (adapter) {
        where += ' AND adapter = @adapter';
        params.adapter = String(adapter);
    }
    return (await db.run(`DELETE FROM assistant_source_weights WHERE ${where}`, params)).changes || 0;
}

/** Retention: rows whose responsibility is gone, or ended long ago. */
async function prune({ days = RETENTION_DAYS, now = new Date() } = {}) {
    const cutoff = utcText(new Date(now.getTime() - days * 86400000));
    return (await db.run(
        `DELETE FROM assistant_source_weights
         WHERE NOT EXISTS (SELECT 1 FROM assistant_responsibilities r WHERE r.id = assistant_source_weights.responsibilityId)
            OR EXISTS (SELECT 1 FROM assistant_responsibilities r
                       WHERE r.id = assistant_source_weights.responsibilityId
                         AND r.status IN ('COMPLETED', 'REVOKED', 'EXPIRED', 'ARCHIVED') AND r.updatedAt < @cutoff)`,
        { cutoff }
    )).changes || 0;
}

module.exports = {
    STEPS, WEAK_PER_STEP, WEAK_MAX, RETENTION_DAYS,
    learnsFrom, stepOf, scale, usualCap, get, capFor, lower, count, describe, listFor, reset, prune
};
