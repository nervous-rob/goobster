/** Installation-wide concurrency admission; usageBudgetService layers token reservations on top. */
const crypto = require('node:crypto');
const db = require('../db');

class AdmissionError extends Error {
    constructor(code, message, status = 429) { super(message); this.code = code; this.status = status; }
}

async function assertActor(actorId) {
    if (!actorId) return;
    const row = await db.get('SELECT status FROM app_accounts WHERE principalId = @id', { id: actorId });
    if ((row && row.status !== 'active') || (!row && String(actorId).startsWith('usr_'))) {
        throw new AdmissionError('ACCOUNT_DISABLED', 'This account cannot start work.', 403);
    }
}

class ResourceAdmissionService {
    async acquire({ resource, actorId = null, scopeId = null, limit = 1, perActor = 1,
        scopeLimit = null, rateLimit = null, windowMs = 300000, leaseMs = 60000,
        waitMs = 0, maxQueued = 64, maxQueuedPerActor = 4, signal = null, onWaiting = null, fair = true } = {}) {
        const id = crypto.randomUUID();
        const actor = actorId ? String(actorId) : null;
        const deadline = Date.now() + waitMs;
        const ttl = Math.max(1000, leaseMs);
        const check = async () => {
            if (signal?.aborted) throw new AdmissionError('CANCELLED', 'The request was cancelled.', 409);
            await assertActor(actor);
        };
        const locked = fn => db.transaction(async tx => {
            await tx.run('INSERT INTO admission_locks (resource) VALUES (@resource) ON CONFLICT DO NOTHING', { resource });
            await tx.run('UPDATE admission_locks SET resource = resource WHERE resource = @resource', { resource });
            await tx.run('DELETE FROM execution_admissions WHERE resource = @resource AND expiresAt <= @now', { resource, now: Date.now() });
            return fn(tx);
        });
        await locked(async tx => {
            await check();
            const queued = await tx.all("SELECT actorId FROM execution_admissions WHERE resource = @resource AND state = 'queued'", { resource });
            if (queued.length >= maxQueued || queued.filter(r => r.actorId === actor).length >= maxQueuedPerActor) {
                throw new AdmissionError('QUEUE_FULL', 'The execution queue is full. Try again after current work finishes.');
            }
            await tx.run(`INSERT INTO execution_admissions (id, resource, actorId, scopeId, state, createdAt, expiresAt)
                VALUES (@id, @resource, @actor, @scopeId, 'queued', @now, @expires)`, {
                id, resource, actor, scopeId, now: Date.now(), expires: deadline + ttl
            });
        });
        let waiting = false;
        const notify = value => { try { onWaiting?.(value); } catch { /* progress must not break admission */ } };
        try {
            for (;;) {
                const claimed = await locked(async tx => {
                    await check();
                    const now = Date.now();
                    const rows = await tx.all('SELECT * FROM execution_admissions WHERE resource = @resource', { resource });
                    const active = rows.filter(r => r.state === 'running');
                    const candidates = rows.filter(r => r.state === 'queued'
                        && active.filter(a => a.actorId === r.actorId).length < perActor
                        && (!scopeLimit || !r.scopeId || active.filter(a => a.scopeId === r.scopeId).length < scopeLimit));
                    // Least-recently admitted eligible account first; FIFO within
                    // that account. A recursive producer cannot jump another user.
                    const lastStart = actor => Math.max(0, ...rows.filter(r => r.actorId === actor).map(r => Number(r.startedAt) || 0));
                    candidates.sort((a, b) => lastStart(a.actorId) - lastStart(b.actorId) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
                    // Budget wait slots admit any eligible caller immediately; model/sandbox
                    // queues retain the default account-fair ordering.
                    if (active.length >= limit || (fair ? candidates[0]?.id !== id : !candidates.some(r => r.id === id))) return false;
                    if (rateLimit && rows.filter(r => r.actorId === actor && Number(r.startedAt) > now - windowMs).length >= rateLimit) {
                        throw new AdmissionError('RATE_LIMITED', 'Your code-run allowance is used for this window. Try again later.');
                    }
                    const result = await tx.run(`UPDATE execution_admissions SET state = 'running', startedAt = @now, expiresAt = @expires
                        WHERE id = @id AND state = 'queued'`, { id, now, expires: now + ttl });
                    return result.changes > 0;
                });
                if (claimed) { if (waiting) notify(false); break; }
                if (Date.now() >= deadline) throw new AdmissionError('BUSY', 'Execution capacity is busy. Try again when current work finishes.');
                if (!waiting) { waiting = true; notify(true); }
                await new Promise(resolve => {
                    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
                    const timer = setTimeout(finish, Math.min(100, Math.max(1, deadline - Date.now())));
                    signal?.addEventListener('abort', finish, { once: true });
                });
            }
        } catch (error) {
            await db.run('DELETE FROM execution_admissions WHERE id = @id', { id });
            throw error;
        }
        let released = false;
        return {
            id,
            async renew() {
                if (!db.isOpen) throw new AdmissionError('LEASE_LOST', 'The database connection closed.', 409);
                await check();
                const now = Date.now();
                const result = await db.run(`UPDATE execution_admissions SET expiresAt = @expires
                    WHERE id = @id AND state = 'running' AND expiresAt > @now`, { id, now, expires: now + ttl });
                if (!result.changes) throw new AdmissionError('LEASE_LOST', 'Execution ownership was lost.', 409);
            },
            async release() {
                if (released) return;
                released = true;
                if (!db.isOpen) return; // shutdown/crash recovery uses expiry
                await db.run(`UPDATE execution_admissions SET state = 'finished', expiresAt = @expires WHERE id = @id`, {
                    id, expires: Date.now() + Math.max(windowMs, 60000)
                });
            }
        };
    }

    async run(options, work) {
        const controller = new AbortController();
        const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        const lease = await this.acquire({ ...options, signal });
        let renewing = false;
        const timer = setInterval(async () => {
            if (renewing) return;
            renewing = true;
            try { await lease.renew(); } catch { controller.abort(); } finally { renewing = false; }
        }, Math.min(1000, Math.max(250, (options.leaseMs || 60000) / 3)));
        timer.unref?.();
        try { return await work(signal, lease); }
        finally { clearInterval(timer); await lease.release(); }
    }
}

module.exports = new ResourceAdmissionService();
module.exports.ResourceAdmissionService = ResourceAdmissionService;
module.exports.AdmissionError = AdmissionError;
module.exports.assertActor = assertActor;
