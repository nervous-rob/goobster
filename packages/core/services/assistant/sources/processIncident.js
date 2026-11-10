/**
 * Source adapter `process_incident` (DA-5c, ADR 0029): a process the
 * responsibility may repair that has an open incident of its own.
 *
 * It needs no source scope. The grant is the link: `process.repair` names
 * each process by reference, and only those are looked at. A process is
 * offered when `assistantProcessRepairService.plan()` says a repair is
 * possible now: it is switched on, it is the failing member of an open
 * incident of its own (not a shared outage, not a stall), nothing is being
 * verified or waiting for the person, a typed repair exists for its cause,
 * and attempts are left.
 *
 * It is a standing source: an incident that is open when the responsibility
 * first looks is the work that was delegated. One attempt is proposed per
 * incident and attempt number, so a repair that failed is followed by the
 * next attempt only while the grant's `repairAttempts` allows one, and an
 * attempt that was proposed is withdrawn once the incident recovers or the
 * attempts are used up.
 *
 * `capability: 'repair'` keeps all of it behind the pilot gate, and nothing
 * is read while the host's stop-all is on.
 */

const db = require('../../../db');
const access = require('./access');

const KIND = 'process_incident';
const OPERATION = 'process.repair';
const CAPABILITY = 'repair';
const MAX_PROCESSES = 50;

const repairs = () => require('../../assistantProcessRepairService');

/** The process references the responsibility's `process.repair` grants name. */
function granted(responsibility) {
    const refs = new Set();
    for (const resource of access.grants(responsibility, OPERATION, 'process')) {
        for (const ref of resource.ids || []) {
            if (typeof ref === 'string' && /^[a-z_]+:\d+$/.test(ref)) refs.add(ref);
        }
    }
    return [...refs].slice(0, MAX_PROCESSES);
}

/** What can be repaired now among the granted processes, as `{ entry, plan }` by reference. */
async function repairable(responsibility, refs, now) {
    const out = new Map();
    if (!refs.length) return out;
    const owner = responsibility.ownerUserId;
    const { processes } = await require('../../assistantProcessService').assess({ userId: owner, now });
    for (const ref of refs) {
        const entry = processes.find(candidate => candidate.ref === ref) || null;
        if (!(await access.permits(responsibility, OPERATION, { kind: 'process', id: ref }))) continue;
        const plan = await repairs().plan({ owner, entry, responsibilityId: responsibility.id, now });
        out.set(ref, { entry, plan });
    }
    return out;
}

module.exports = {
    KIND,
    OPERATION,
    capability: CAPABILITY,
    standing: true,

    async read(responsibility, { now = new Date() } = {}) {
        const found = await repairable(responsibility, granted(responsibility), now);
        const out = [];
        for (const [ref, { entry, plan }] of found) {
            if (!plan.ok) continue;
            out.push({
                sourceId: String(plan.incident.id),
                revision: `a${plan.used + 1}`,
                title: `Repair "${String(entry.described.name || 'a process').slice(0, 160)}"`,
                reason: 'a process this responsibility may repair keeps failing',
                category: 'schedule',
                origin: { kind: KIND, incidentId: Number(plan.incident.id), ref, attempt: plan.used + 1 }
            });
        }
        return out;
    },

    /** Proposed or queued attempts whose repair is no longer possible. */
    async stale(responsibility) {
        const out = [];
        for (const attempt of await access.openAttempts(db, responsibility, KIND)) {
            const located = await module.exports.locate(responsibility, attempt.origin);
            if (!located.ok) out.push({ id: attempt.id, code: located.code });
        }
        return out;
    },

    /**
     * The repair an attempt was proposed for, as it stands now.
     * @returns {Promise<{ ok: true, entry: Object, plan: Object } | { ok: false, code: string }>}
     */
    async locate(responsibility, originValue, { now = new Date() } = {}) {
        const origin = access.originOf(originValue);
        if (!origin || origin.kind !== KIND || typeof origin.ref !== 'string') return { ok: false, code: 'SOURCE_GONE' };
        if (!granted(responsibility).includes(origin.ref)) return { ok: false, code: 'SOURCE_NOT_COVERED' };
        const found = (await repairable(responsibility, [origin.ref], now)).get(origin.ref);
        if (!found) return { ok: false, code: 'SOURCE_NOT_COVERED' };
        if (!found.plan.ok) return { ok: false, code: found.plan.code };
        if (Number(found.plan.incident.id) !== Number(origin.incidentId)) return { ok: false, code: 'INCIDENT_CLOSED' };
        if (found.plan.used + 1 !== Number(origin.attempt)) return { ok: false, code: 'ATTEMPT_SUPERSEDED' };
        return { ok: true, entry: found.entry, plan: found.plan };
    }
};
