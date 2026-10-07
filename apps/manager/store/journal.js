/**
 * The operations journal (`operations/<id>.json`) and the pending audit log
 * (`operations/audit.jsonl`). Every record is redacted before it is written
 * and replaced atomically, so a crash leaves the previous version intact.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const files = require('./files');
const { scrub } = require('../engine/redact');

const OPERATION_VERSION = 1;
const AUDIT_VERSION = 1;
const STATUSES = ['planned', 'validated', 'applying', 'applied', 'failed', 'cancelled'];
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * @typedef {Object} OperationStep
 * @property {string} name
 * @property {'started'|'done'|'failed'|'skipped'} status
 * @property {string} at ISO-8601 UTC
 * @property {Object} [detail] non-secret structured detail
 */

/**
 * @typedef {Object} OperationRecord
 * @property {number} version
 * @property {string} id
 * @property {string} kind
 * @property {'planned'|'validated'|'applying'|'applied'|'failed'|'cancelled'} status
 * @property {string|null} actor principal id, or null for a local credential
 * @property {'bridge'|'setup'|'recovery'|'local'} via how the actor authenticated
 * @property {Object} plan redacted description of the change
 * @property {number|null} revision the target state's revision the plan was computed against
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {OperationStep[]} steps
 * @property {{ code: string, message: string }} [error]
 */

function createJournal({ store, fs = nodeFs, now = () => new Date() }) {
    const dir = store.paths.operations;
    const fileFor = (id) => path.join(dir, `${id}.json`);
    let auditQueue = Promise.resolve();
    const enqueue = (task) => {
        const run = auditQueue.then(task, task);
        auditQueue = run.catch(() => {});
        return run;
    };

    const isId = (id) => typeof id === 'string' && ID_RE.test(id);

    /** @returns {OperationRecord} */
    function create({ kind, actor = null, via, plan, revision = null }) {
        const at = now().toISOString();
        const record = {
            version: OPERATION_VERSION,
            id: crypto.randomUUID(),
            kind,
            status: 'planned',
            actor,
            via,
            plan: scrub(plan),
            revision,
            createdAt: at,
            updatedAt: at,
            steps: []
        };
        files.writeJsonAtomic(fileFor(record.id), record, fs);
        return record;
    }

    /** @returns {{ record: OperationRecord|null, problem: null|'MISSING'|'UNREADABLE'|'CORRUPT'|'UNSUPPORTED' }} */
    function read(id) {
        if (!isId(id)) return { record: null, problem: 'MISSING' };
        const result = files.readJson(fileFor(id), fs);
        if (!result.exists) return { record: null, problem: 'MISSING' };
        if (result.problem) return { record: null, problem: result.problem };
        const value = result.value;
        if (!files.isPlainObject(value) || typeof value.version !== 'number') return { record: null, problem: 'CORRUPT' };
        if (value.version !== OPERATION_VERSION) return { record: null, problem: 'UNSUPPORTED' };
        if (value.id !== id || !STATUSES.includes(value.status) || !Array.isArray(value.steps)) {
            return { record: null, problem: 'CORRUPT' };
        }
        return { record: value, problem: null };
    }

    /** Read, change and atomically replace one record. */
    function update(id, change) {
        const { record, problem } = read(id);
        if (!record) {
            const error = new Error(`operation ${id} cannot be updated (${problem})`);
            error.code = problem;
            throw error;
        }
        const next = change({ ...record, steps: record.steps.map(step => ({ ...step })) }) || record;
        next.updatedAt = now().toISOString();
        if (next.plan) next.plan = scrub(next.plan);
        next.steps = next.steps.map(step => (step.detail ? { ...step, detail: scrub(step.detail) } : step));
        if (next.error) next.error = { code: String(next.error.code), message: String(next.error.message) };
        files.writeJsonAtomic(fileFor(id), next, fs);
        return next;
    }

    function step(id, name, status, detail) {
        return update(id, (record) => {
            record.steps.push({ name, status, at: now().toISOString(), ...(detail ? { detail } : {}) });
            return record;
        });
    }

    /** Every record, newest first; unreadable files are listed with their problem, never repaired. */
    function list() {
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch {
            return [];
        }
        const out = [];
        for (const name of names) {
            const match = /^(.+)\.json$/.exec(name);
            if (!match || !isId(match[1])) continue;
            const { record, problem } = read(match[1]);
            out.push(record || { id: match[1], status: 'unreadable', problem });
        }
        return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }

    /**
     * Append one audit record: `{ action, actor, operationId, outcome }`.
     * Never a value, a credential or a label.
     */
    function appendAudit({ action, actor = null, operationId, outcome, via = null }) {
        const entry = {
            version: AUDIT_VERSION,
            action: String(action),
            actor: actor == null ? null : String(actor),
            operationId: String(operationId),
            outcome: String(outcome),
            via,
            at: now().toISOString(),
            reconciledAt: null
        };
        return enqueue(() => {
            const fd = fs.openSync(store.paths.audit, 'a', files.FILE_MODE);
            try {
                fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            return entry;
        });
    }

    /** @returns {{ entries: Object[], skipped: number }} lines that do not parse are counted, never dropped from disk. */
    function readAudit() {
        let text;
        try {
            text = fs.readFileSync(store.paths.audit, 'utf8');
        } catch (error) {
            if (error && error.code === 'ENOENT') return { entries: [], skipped: 0 };
            throw error;
        }
        const entries = [];
        let skipped = 0;
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const value = JSON.parse(line);
                if (files.isPlainObject(value) && value.version === AUDIT_VERSION && typeof value.operationId === 'string') {
                    entries.push(value);
                } else {
                    skipped++;
                }
            } catch {
                skipped++;
            }
        }
        return { entries, skipped };
    }

    /**
     * Stamp `reconciledAt` on the entries for `operationIds`. Rewrites the
     * log atomically and keeps every line it does not understand verbatim.
     */
    function markReconciled(operationIds, at = now().toISOString()) {
        const wanted = new Set(operationIds);
        return enqueue(() => {
            let text;
            try {
                text = fs.readFileSync(store.paths.audit, 'utf8');
            } catch (error) {
                if (error && error.code === 'ENOENT') return;
                throw error;
            }
            const lines = text.split('\n').filter(line => line.trim()).map((line) => {
                try {
                    const value = JSON.parse(line);
                    if (files.isPlainObject(value) && wanted.has(value.operationId) && !value.reconciledAt) {
                        return JSON.stringify({ ...value, reconciledAt: at });
                    }
                } catch { }
                return line;
            });
            files.writeAtomic(store.paths.audit, lines.length ? `${lines.join('\n')}\n` : '', fs);
        });
    }

    return { create, read, update, step, list, appendAudit, readAudit, markReconciled, isId };
}

module.exports = { createJournal, OPERATION_VERSION, AUDIT_VERSION, STATUSES };
