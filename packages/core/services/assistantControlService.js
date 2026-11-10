/**
 * The host's controls over delegated work (DA-12a): the caps policy, the
 * stop-all flag and the installation-wide view.
 *
 *  - **Caps** are five numbers. `installationRuns` and `runsPerAccount`
 *    bound how many runs execute at once; the three `default*` numbers are
 *    a responsibility's daily budget when it sets none, and the most its
 *    own budget can allow. Fresh-install values come from
 *    config/assistantConfig.js; what the host sets is stored in
 *    `instance_state.assistantCaps` and wins.
 *  - **Stop-all** is `instance_state.assistantPaused`. The runner, the
 *    claim, every run's heartbeat and `authorize()` read it from the
 *    database, so the bot and the api service agree and running work halts
 *    at its next step. Nothing is cancelled: halted work waits and
 *    continues from its journal after a resume.
 *  - **The view** is counts, states, spend and codes. It never reads a
 *    title, a prompt, a result or a journal text, and names accounts by id.
 *
 * Neither record holds a person's id: who changed what is in
 * `operator_audit`, written by the route. Spec:
 * documentation/delegated_operations.md.
 */

const db = require('../db');
const defaults = require('../config/assistantConfig');
const state = require('./instanceStateService');

const KEY_CAPS = 'assistantCaps';
const KEY_PAUSED = 'assistantPaused';
const CLAIM_LOCK = 'assistant:claims';
const FIELDS = Object.keys(defaults.BOUNDS);
const PAUSED_CODE = 'ASSISTANT_PAUSED';
const VIEW_DAYS = 14;
const VIEW_ACCOUNTS = 100;

class AssistantControlError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'AssistantControlError';
        this.code = code;
        this.status = status;
    }
}

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function ageSeconds(text, now) {
    if (!text) return null;
    const at = Date.parse(`${String(text).replace(' ', 'T')}Z`);
    return Number.isFinite(at) ? Math.max(0, Math.round((now.getTime() - at) / 1000)) : null;
}

const inBounds = (field, value) => Number.isSafeInteger(value)
    && value >= defaults.BOUNDS[field].min && value <= defaults.BOUNDS[field].max;

const byCount = (rows, key = 'code') => rows
    .map(row => ({ [key]: row[key], count: Number(row.n) }))
    .sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key])));

class AssistantControlService {
    constructor() {
        this.FIELDS = FIELDS;
        this.BOUNDS = defaults.BOUNDS;
        this.PAUSED_CODE = PAUSED_CODE;
    }

    // --- Caps ----------------------------------------------------------------

    /** What the host stored, with anything out of bounds dropped. */
    async _overrides() {
        const stored = await state.get(KEY_CAPS);
        const out = {};
        if (!stored || typeof stored !== 'object') return out;
        for (const field of FIELDS) {
            if (inBounds(field, stored[field])) out[field] = stored[field];
        }
        return out;
    }

    /** The caps in force. @returns {Promise<Object<string, number>>} */
    async caps() {
        const overrides = await this._overrides();
        return Object.fromEntries(FIELDS.map(field => [field, overrides[field] ?? defaults[field]]));
    }

    /** Caps with where each number comes from, for the Host room. */
    async describeCaps() {
        const overrides = await this._overrides();
        return {
            caps: Object.fromEntries(FIELDS.map(field => [field, overrides[field] ?? defaults[field]])),
            defaults: Object.fromEntries(FIELDS.map(field => [field, defaults[field]])),
            hostSet: FIELDS.filter(field => overrides[field] !== undefined),
            bounds: defaults.BOUNDS
        };
    }

    /** A responsibility's daily budget defaults (and ceilings), by budget key. */
    async budgetDefaults() {
        const caps = await this.caps();
        return { modelTokens: caps.defaultModelTokens, searches: caps.defaultSearches, computeSeconds: caps.defaultComputeSeconds };
    }

    /**
     * Change caps. A number sets a cap; null clears the host's value so the
     * configured default applies again. Takes effect at the next claim and
     * the next run; a run already working keeps the budget it started with.
     * @param {Object<string, number|null>} changes
     * @returns {Promise<{ caps: Object, changed: Object<string, number|null> }>}
     */
    async setCaps(changes) {
        const keys = changes && typeof changes === 'object' && !Array.isArray(changes) ? Object.keys(changes) : [];
        if (!keys.length || keys.some(key => !FIELDS.includes(key))) {
            throw new AssistantControlError('BAD_CAPS', `Send one or more of ${FIELDS.join(', ')}.`);
        }
        for (const key of keys) {
            if (changes[key] !== null && !inBounds(key, changes[key])) {
                const { min, max } = defaults.BOUNDS[key];
                throw new AssistantControlError('BAD_CAPS', `${key} must be a whole number from ${min} to ${max}, or null for the default.`);
            }
        }
        return db.transaction(async () => {
            // Same lock as a claim: a cap never changes under a half-made claim.
            await this.lockClaims();
            const next = await this._overrides();
            const changed = {};
            for (const key of keys) {
                const was = next[key] ?? null;
                if (changes[key] === null) delete next[key];
                else next[key] = changes[key];
                if (was !== changes[key]) changed[key] = changes[key];
            }
            if (Object.keys(changed).length) await state.set(KEY_CAPS, next);
            const after = await this.caps();
            return { caps: after, changed };
        });
    }

    // --- Stop-all ---------------------------------------------------------------

    /** @returns {Promise<{ since: string }|null>} */
    async getPause() {
        const value = await state.get(KEY_PAUSED);
        return value && typeof value === 'object' && value.since ? { since: String(value.since) } : null;
    }

    /** @returns {Promise<boolean>} */
    async isPaused() {
        return (await this.getPause()) !== null;
    }

    /**
     * Stop all delegated work. Idempotent: a second call keeps the first
     * record and reports `changed: false`.
     */
    async pauseAll({ now = new Date() } = {}) {
        return db.transaction(async () => {
            await this.lockClaims();
            const existing = await this.getPause();
            if (existing) return { paused: existing, changed: false };
            const record = { since: utcText(now) };
            await state.set(KEY_PAUSED, record);
            return { paused: record, changed: true };
        });
    }

    /**
     * Let delegated work start again. Work the stop halted goes back to the
     * queue; it was queued by its owner once already.
     */
    async resumeAll({ now = new Date() } = {}) {
        return db.transaction(async () => {
            await this.lockClaims();
            const existing = await this.getPause();
            if (!existing) return { paused: null, changed: false, requeued: 0 };
            await state.remove(KEY_PAUSED);
            const result = await db.run(
                `UPDATE assistant_initiatives
                 SET status = 'QUEUED', waitReason = NULL, stopCode = NULL, recheckAfter = NULL,
                     revision = revision + 1, updatedAt = @now
                 WHERE status = 'WAITING' AND stopCode = @code`,
                { now: utcText(now), code: PAUSED_CODE }
            );
            return { paused: null, changed: true, requeued: result.changes || 0, pausedSince: existing.since };
        });
    }

    // --- Admission ----------------------------------------------------------------

    /**
     * Serialize claims (and cap changes) across processes. Call first inside
     * the claim's transaction; the row lock is held until it commits.
     */
    async lockClaims() {
        await db.run('INSERT INTO admission_locks (resource) VALUES (@resource) ON CONFLICT (resource) DO NOTHING', { resource: CLAIM_LOCK });
        await db.run('UPDATE admission_locks SET resource = resource WHERE resource = @resource', { resource: CLAIM_LOCK });
    }

    /**
     * May one more run start for this account now? Call inside the claim's
     * transaction, after `lockClaims()`.
     * @returns {Promise<{ ok: true } | { ok: false, code: 'ASSISTANT_PAUSED'|'INSTALLATION_CAP'|'ACCOUNT_CAP' }>}
     */
    async admit({ ownerUserId, now = new Date() }) {
        if (await this.isPaused()) return { ok: false, code: PAUSED_CODE };
        const caps = await this.caps();
        const load = await this.running({ now });
        if (load.total >= caps.installationRuns) return { ok: false, code: 'INSTALLATION_CAP' };
        if ((load.byOwner.get(String(ownerUserId)) || 0) >= caps.runsPerAccount) return { ok: false, code: 'ACCOUNT_CAP' };
        return { ok: true };
    }

    /** Initiatives holding a live lease right now, per owner. */
    async running({ now = new Date() } = {}) {
        const rows = await db.all(
            `SELECT ownerUserId, COUNT(*) AS n FROM assistant_initiatives
             WHERE status = 'RUNNING' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > @now
             GROUP BY ownerUserId`,
            { now: utcText(now) }
        );
        const byOwner = new Map(rows.map(row => [String(row.ownerUserId), Number(row.n)]));
        return { byOwner, total: [...byOwner.values()].reduce((sum, n) => sum + n, 0) };
    }

    // --- The host view ------------------------------------------------------------

    /**
     * Delegated work across the installation: counts, states, spend and
     * codes only. No title, prompt, result or journal text is selected.
     * @param {{ days?: number, now?: Date }} [options]
     */
    async overview({ days = VIEW_DAYS, now = new Date() } = {}) {
        const window = Math.max(1, Math.min(90, Math.trunc(Number(days)) || VIEW_DAYS));
        const since = utcText(new Date(now.getTime() - window * 86_400_000));
        const today = `${now.toISOString().slice(0, 10)} 00:00:00`;
        const counts = rows => Object.fromEntries(rows.map(row => [row.status, Number(row.n)]));

        const responsibilities = await db.all('SELECT status, COUNT(*) AS n FROM assistant_responsibilities GROUP BY status', {});
        const initiatives = await db.all('SELECT status, COUNT(*) AS n FROM assistant_initiatives GROUP BY status', {});
        const oldest = await db.all(
            `SELECT status, MIN(updatedAt) AS oldest FROM assistant_initiatives
             WHERE status IN ('QUEUED', 'WAITING') GROUP BY status`,
            {}
        );
        const perDay = await db.all(
            `SELECT substr(startedAt, 1, 10) AS day, COUNT(*) AS runs, COALESCE(SUM(tokensUsed), 0) AS tokens,
                    COALESCE(SUM(searches), 0) AS searches, COALESCE(SUM(computeSeconds), 0) AS compute
             FROM assistant_runs WHERE startedAt >= @since
             GROUP BY substr(startedAt, 1, 10) ORDER BY substr(startedAt, 1, 10) DESC`,
            { since }
        );
        const failures = await db.all(
            `SELECT stopCode AS code, COUNT(*) AS n FROM assistant_runs
             WHERE status IN ('FAILED', 'REVIEW') AND stopCode IS NOT NULL AND updatedAt >= @since
             GROUP BY stopCode`,
            { since }
        );
        const waiting = await db.all(
            `SELECT COALESCE(stopCode, waitReason) AS code, COUNT(*) AS n FROM assistant_initiatives
             WHERE status = 'WAITING' GROUP BY COALESCE(stopCode, waitReason)`,
            {}
        );
        const refusals = await db.all(
            `SELECT refusalCode AS code, COUNT(*) AS n FROM assistant_run_operations
             WHERE status = 'REFUSED' AND refusalCode IS NOT NULL AND createdAt >= @since
             GROUP BY refusalCode`,
            { since }
        );

        const accounts = new Map();
        const account = (id) => {
            const key = String(id);
            if (!accounts.has(key)) {
                accounts.set(key, { id: key, activeResponsibilities: 0, queued: 0, running: 0, waiting: 0, runsToday: 0, tokensToday: 0 });
            }
            return accounts.get(key);
        };
        for (const row of await db.all(
            "SELECT ownerUserId, COUNT(*) AS n FROM assistant_responsibilities WHERE status = 'ACTIVE' GROUP BY ownerUserId", {}
        )) account(row.ownerUserId).activeResponsibilities = Number(row.n);
        for (const row of await db.all(
            `SELECT ownerUserId, status, COUNT(*) AS n FROM assistant_initiatives
             WHERE status IN ('QUEUED', 'RUNNING', 'WAITING') GROUP BY ownerUserId, status`,
            {}
        )) account(row.ownerUserId)[row.status.toLowerCase()] = Number(row.n);
        for (const row of await db.all(
            `SELECT ownerUserId, COUNT(*) AS n, COALESCE(SUM(tokensUsed), 0) AS tokens FROM assistant_runs
             WHERE startedAt >= @today GROUP BY ownerUserId`,
            { today }
        )) Object.assign(account(row.ownerUserId), { runsToday: Number(row.n), tokensToday: Number(row.tokens) });
        const listed = [...accounts.values()]
            .sort((a, b) => b.running - a.running || b.tokensToday - a.tokensToday || b.queued - a.queued || a.id.localeCompare(b.id));

        const oldestBy = Object.fromEntries(oldest.map(row => [row.status, row.oldest]));
        const load = await this.running({ now });
        return {
            asOf: now.toISOString(),
            windowDays: window,
            paused: await this.getPause(),
            ...(await this.describeCaps()),
            responsibilities: { byStatus: counts(responsibilities) },
            work: {
                byStatus: counts(initiatives),
                running: load.total,
                oldestQueuedSeconds: ageSeconds(oldestBy.QUEUED, now),
                oldestWaitingSeconds: ageSeconds(oldestBy.WAITING, now),
                waitingByCode: byCount(waiting.map(row => ({ ...row, code: row.code || 'unknown' })))
            },
            runs: {
                perDay: perDay.map(row => ({
                    day: row.day, runs: Number(row.runs), tokens: Number(row.tokens),
                    searches: Number(row.searches), computeSeconds: Number(row.compute)
                })),
                failures: byCount(failures),
                refusals: byCount(refusals)
            },
            accounts: listed.slice(0, VIEW_ACCOUNTS),
            accountsOmitted: Math.max(0, listed.length - VIEW_ACCOUNTS)
        };
    }
}

module.exports = new AssistantControlService();
module.exports.AssistantControlService = AssistantControlService;
module.exports.AssistantControlError = AssistantControlError;
module.exports.KEY_CAPS = KEY_CAPS;
module.exports.KEY_PAUSED = KEY_PAUSED;
module.exports.PAUSED_CODE = PAUSED_CODE;
