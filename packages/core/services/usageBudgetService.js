/** Token holds and cost attribution. Concurrency remains resourceAdmissionService's job. */
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const db = require('../db');
const defaults = require('../config/limitsConfig');
const state = require('./instanceStateService');
const admission = require('./resourceAdmissionService');
const workContext = require('../utils/workContext');
const capture = new AsyncLocalStorage();
const utc = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const ACCOUNT_LOCK = 'budget:account-policy';

class BudgetError extends Error {
    constructor(code, message, details = null, status = 429) {
        super(message); this.code = code; this.status = status; this.details = details;
    }
}
const lock = async (tx, resource) => {
    await tx.run('INSERT INTO admission_locks (resource) VALUES (@resource) ON CONFLICT DO NOTHING', { resource });
    await tx.run('UPDATE admission_locks SET resource = resource WHERE resource = @resource', { resource });
};
function validCount(n) { return Number.isSafeInteger(n) && n >= 0; }
function windowFor(policy, now = Date.now()) {
    const width = policy.windowHours * 3600000;
    const start = Math.floor(now / width) * width;
    return { windowStart: utc(start), resetsAt: new Date(start + width).toISOString() };
}

class UsageBudgetService {
    async policy() { return { ...defaults, ...await state.get('limits') }; }

    async setPolicy(changes) {
        const allowed = ['dailyTokens', 'windowHours', 'retentionDays'];
        if (!changes || !Object.keys(changes).length || Object.keys(changes).some(k => !allowed.includes(k))) {
            throw new BudgetError('BAD_LIMITS', 'Send dailyTokens, windowHours and/or retentionDays.', null, 400);
        }
        return db.transaction(async tx => {
            // Same lock as every account-creation path: clearing a cap cannot race sign-up.
            await lock(tx, ACCOUNT_LOCK);
            const next = { ...await this.policy(), ...changes };
            if (!(next.dailyTokens === null || (validCount(next.dailyTokens) && next.dailyTokens > 0))
                || !Number.isInteger(next.windowHours) || next.windowHours < 1 || next.windowHours > 24
                || !Number.isInteger(next.retentionDays) || next.retentionDays < 1 || next.retentionDays > 3650) {
                throw new BudgetError('BAD_LIMITS', 'Use a positive token cap (or null), 1–24 window hours, and 1–3650 retention days.', null, 400);
            }
            if (require('../config/identityConfig').requireAccount && next.dailyTokens === null
                && Number((await tx.get('SELECT COUNT(*) AS n FROM app_accounts')).n) > 1) {
                throw new BudgetError('DAILY_CAP_REQUIRED', 'A shared installation must keep a token cap. Set it in Host → Limits.', null, 409);
            }
            await state.set('limits', next);
            return next;
        });
    }

    /** Called inside the transaction that inserts the account. */
    async assertAccountCreation(tx, principalId = null) {
        await lock(tx, ACCOUNT_LOCK);
        if (!require('../config/identityConfig').requireAccount) return;
        if (principalId && await tx.get('SELECT principalId FROM app_accounts WHERE principalId = @principalId', { principalId })) return;
        if ((await this.policy()).dailyTokens !== null) return;
        if (Number((await tx.get('SELECT COUNT(*) AS n FROM app_accounts')).n) >= 1) {
            throw new BudgetError('DAILY_CAP_REQUIRED', 'Set a daily token cap in Host → Limits before opening a second account.', null, 409);
        }
    }

    async usedInWindow(payer, windowStart, tx = db) {
        const row = await tx.get(`SELECT COALESCE(SUM(CASE status WHEN 'held' THEN estimatedTokens
            WHEN 'settled' THEN actualTokens ELSE 0 END), 0) AS used FROM usage_reservations
            WHERE payer = @payer AND createdAt >= @windowStart`, { payer, windowStart });
        return Number(row.used);
    }

    async assertAvailable(payer) {
        const limits = await this.describe(payer);
        if (limits.dailyTokens !== null && limits.usedTokens >= limits.dailyTokens) {
            await require('./workFailureService').note({ kind: 'chat', workId: crypto.randomUUID(), actor: payer,
                phase: 'reserve', code: 'BUDGET_EXCEEDED', reason: 'The account token limit is used for this window.' });
            throw new BudgetError('BUDGET_EXCEEDED',
                `The account token limit (${limits.dailyTokens.toLocaleString()} tokens per ${limits.windowHours} hours) is used. The window resets at ${limits.resetsAt}.`, limits);
        }
    }

    async describe(payer) {
        const policy = await this.policy();
        const window = windowFor(policy);
        const usedTokens = await this.usedInWindow(payer, window.windowStart);
        const waiting = await db.get(`SELECT COUNT(*) AS n FROM execution_admissions
            WHERE resource = 'budget-wait' AND state = 'running' AND expiresAt > @now
            AND (actorId = @payer OR scopeId = @payer)`, { payer, now: Date.now() });
        return { ...policy, ...window, usedTokens, waitingRequests: Number(waiting.n),
            remainingTokens: policy.dailyTokens === null ? null : Math.max(0, policy.dailyTokens - usedTokens) };
    }

    async reserve({ payer, actor = null, work = {}, estimatedTokens, admissionId = null,
        idempotencyKey = crypto.randomUUID(), windowStart, cap, resetsAt, expiresAt } = {}) {
        if (!payer || !validCount(estimatedTokens)) throw new BudgetError('BAD_RESERVATION', 'A payer and a non-negative token estimate are required.', null, 400);
        const policy = await this.policy();
        const window = windowFor(policy);
        cap = cap === undefined ? policy.dailyTokens : cap;
        windowStart = windowStart || window.windowStart;
        resetsAt = resetsAt || window.resetsAt;
        if (cap !== null && (!validCount(cap) || cap === 0)) throw new BudgetError('BAD_LIMITS', 'The token cap must be positive or unset.', null, 400);
        return db.transaction(async tx => {
            await lock(tx, `budget:${payer}`);
            if (await tx.get('SELECT id FROM usage_reservations WHERE idempotencyKey = @key', { key: idempotencyKey })) {
                throw new BudgetError('BUDGET_DUPLICATE', 'This model request already has a reservation; it must not be sent again.', null, 409);
            }
            if (cap !== null) {
                const usedTokens = await this.usedInWindow(payer, windowStart, tx);
                if (usedTokens + estimatedTokens > cap) {
                    throw new BudgetError('BUDGET_EXCEEDED', `The account token limit (${cap.toLocaleString()} tokens per ${policy.windowHours} hours) cannot cover this request. The window resets at ${resetsAt}.`,
                        { dailyTokens: cap, windowHours: policy.windowHours, usedTokens, estimatedTokens, resetsAt });
                }
            }
            return tx.insert(`INSERT INTO usage_reservations
                (actor, payer, workKind, workId, admissionId, estimatedTokens, idempotencyKey, expiresAt)
                VALUES (@actor, @payer, @kind, @workId, @admissionId, @estimate, @key, @expiresAt)`, {
                actor, payer, kind: work.kind || 'chat', workId: String(work.id ?? idempotencyKey), admissionId,
                estimate: estimatedTokens, key: idempotencyKey, expiresAt: expiresAt || utc(Date.now() + 1800000)
            });
        });
    }

    async settle(id, { actualTokens, reconcile = false }) {
        if (!validCount(actualTokens)) throw new Error('Invalid actual token count');
        return db.run(`UPDATE usage_reservations SET status = 'settled', actualTokens = @actualTokens, reconcile = @reconcile
            WHERE id = @id AND status = 'held'`, { id, actualTokens, reconcile: reconcile ? 1 : 0 });
    }
    async release(id) {
        return db.run("UPDATE usage_reservations SET status = 'released' WHERE id = @id AND status = 'held'", { id });
    }
    async prune({ now = Date.now() } = {}) {
        const cutoff = utc(Number(new Date(now)) - (await this.policy()).retentionDays * 86400000);
        const released = await db.run(`UPDATE usage_reservations SET status = 'released'
            WHERE status = 'held' AND expiresAt <= @now`, { now: utc(now) });
        const removed = await db.run("DELETE FROM usage_reservations WHERE status <> 'held' AND createdAt < @cutoff", { cutoff });
        return { released: released.changes, removed: removed.changes };
    }

    /** Synchronous capture before best-effort usage_log I/O; one scope per provider call. */
    recordUsage({ operation, inputTokens, outputTokens, usageKnown = true }) {
        const current = capture.getStore();
        if (!current || operation !== 'chat' || !usageKnown) return;
        if (!validCount(inputTokens) || !validCount(outputTokens)) return;
        current.known = true;
        current.tokens += inputTokens + outputTokens;
    }

    async _reserveOrWait(options, { background, signal, onWaiting, waitMs }) {
        try { return await this.reserve(options); }
        catch (error) {
            if (error.code !== 'BUDGET_EXCEEDED' || !background || waitMs <= 0) throw error;
        }
        // Use existing database leases for bounded wait slots (64 total, four per actor).
        // Waiting for tokens never holds a model slot or a database transaction.
        return admission.run({ resource: 'budget-wait', actorId: options.actor, scopeId: options.payer, limit: 64, perActor: 4,
            waitMs: 0, leaseMs: waitMs + 30000, signal, fair: false }, async waitSignal => {
            const deadline = Date.now() + waitMs;
            try {
                for (;;) {
                    if (waitSignal.aborted) throw new admission.AdmissionError('CANCELLED', 'The request was cancelled.', 409);
                    await admission.assertActor(options.actor);
                    await admission.assertActor(options.payer === 'instance' ? null : options.payer);
                    try { return await this.reserve(options); }
                    catch (error) {
                        if (error.code !== 'BUDGET_EXCEEDED' || Date.now() >= deadline) throw error;
                        try { onWaiting?.(true, { reason: 'budget', ...error.details }); } catch { /* cosmetic */ }
                    }
                    await new Promise(resolve => {
                        const done = () => { clearTimeout(timer); waitSignal.removeEventListener('abort', done); resolve(); };
                        const timer = setTimeout(done, Math.min(100, Math.max(1, deadline - Date.now())));
                        waitSignal.addEventListener('abort', done, { once: true });
                    });
                }
            } finally { try { onWaiting?.(false, { reason: 'budget' }); } catch { /* cosmetic */ } }
        });
    }

    async run({ estimatedTokens, admissionOptions, background = false }, providerCall) {
        const ref = workContext.current();
        const actor = ref?.actor || admissionOptions.actorId || null;
        const payer = ref?.payer || actor || 'instance';
        const work = { kind: ref?.kind || 'chat', id: ref?.id || crypto.randomUUID() };
        const signal = admissionOptions.signal;
        if (signal?.aborted) throw new admission.AdmissionError('CANCELLED', 'The request was cancelled.', 409);
        await admission.assertActor(actor);
        await admission.assertActor(payer === 'instance' ? null : payer);
        let id;
        try {
            id = await this._reserveOrWait({ payer, actor, work, estimatedTokens,
                expiresAt: utc(Date.now() + admissionOptions.waitMs + admissionOptions.leaseMs + 30000) }, {
                background: background || ['expedition', 'job', 'automation', 'trigger', 'attention', 'persona', 'watch'].includes(work.kind),
                signal, onWaiting: admissionOptions.onWaiting, waitMs: admissionOptions.waitMs
            });
        } catch (error) {
            if (error.code === 'BUDGET_EXCEEDED') await require('./workFailureService').note({
                kind: work.kind, workId: work.id, actor, phase: 'reserve', code: error.code,
                reason: 'The account token limit cannot cover the next model request.'
            });
            throw error;
        }
        let started = false;
        const usage = { known: false, tokens: 0 };
        try {
            return await admission.run({ ...admissionOptions, actorId: actor }, async (providerSignal, lease) => {
                await db.run('UPDATE usage_reservations SET admissionId = @admissionId WHERE id = @id', { id, admissionId: lease.id });
                if (providerSignal.aborted) throw new admission.AdmissionError('CANCELLED', 'The request was cancelled.', 409);
                await admission.assertActor(payer === 'instance' ? null : payer);
                started = true;
                try { return await capture.run(usage, () => providerCall(providerSignal)); }
                finally {
                    // Missing usage, partial streams and timeouts are uncertain paid outcomes.
                    // Keep the estimate and flag them; never buy an automatic retry.
                    await this.settle(id, { actualTokens: usage.known ? usage.tokens : estimatedTokens, reconcile: !usage.known });
                }
            });
        } catch (error) {
            if (!started) await this.release(id);
            throw error;
        }
    }
}
module.exports = new UsageBudgetService();
module.exports.BudgetError = BudgetError;
module.exports.windowFor = windowFor;
