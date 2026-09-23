/**
 * operator_audit: what the operator changed (roadmap #256).
 *
 * One row per operator action on accounts, invitations, sign-up, limits
 * and instance settings: who did it (`actor`), to whom or what (`target`),
 * and a small structured detail (a status, a role, a count) - never a
 * token, a password, an address or a message body. The Host room shows the
 * list; the pilot reads it to answer "who changed what, when".
 *
 * Writers call `record()` from the route (or the CLI) that performs the
 * change, after it succeeded. Recording is best-effort: it never throws.
 * Retention is one year (`prune()`); erasure nulls actor and target and
 * keeps the row. Full reference: documentation/work_ledger.md.
 */

const db = require('../db');
const logger = require('../utils/logger');

const RETENTION_DAYS = 365;
const MAX_DETAIL = 2000;

/** Every action the ledger accepts. Add here when a new operator route lands. */
const ACTIONS = new Set([
    'invite.create', 'invite.revoke',
    'account.grant', 'account.status', 'account.role', 'account.recovery',
    'signup.mail_test',
    'instance.resume', 'instance.restore', 'instance.pause',
    'limits.change'
]);

/** Keys that must never be persisted even when a caller passes them. */
const FORBIDDEN_DETAIL = new Set(['token', 'url', 'password', 'secret', 'email', 'to', 'address', 'loginName']);

function cleanDetail(detail) {
    if (!detail || typeof detail !== 'object') return null;
    const out = {};
    for (const [key, value] of Object.entries(detail)) {
        if (FORBIDDEN_DETAIL.has(key) || value === undefined) continue;
        out[key] = value;
    }
    const json = JSON.stringify(out);
    if (json === '{}') return null;
    return json.length > MAX_DETAIL ? JSON.stringify({ truncated: true }) : json;
}

class OperatorAuditService {
    constructor() {
        this.ACTIONS = ACTIONS;
        this.RETENTION_DAYS = RETENTION_DAYS;
    }

    /**
     * Record one operator action. Never throws.
     * @param {Object} params
     * @param {string} params.action - one of ACTIONS
     * @param {string|null} [params.actor] - operator principal id; null for a CLI
     * @param {string|null} [params.target] - affected principal / invite id
     * @param {Object|null} [params.detail] - small structured detail
     * @returns {Promise<number|null>} the row id, or null when nothing was written
     */
    async record({ action, actor = null, target = null, detail = null }) {
        try {
            if (!ACTIONS.has(action)) throw new Error(`unknown operator action '${action}'`);
            return await db.insert(
                `INSERT INTO operator_audit (action, actor, target, detailJson)
                 VALUES (@action, @actor, @target, @detailJson)`,
                {
                    action,
                    actor: actor == null ? null : String(actor),
                    target: target == null ? null : String(target),
                    detailJson: cleanDetail(detail)
                }
            );
        } catch (error) {
            logger.warn?.(`[operator_audit] Could not record ${action}: ${error.message}`);
            return null;
        }
    }

    /**
     * The audit list, newest first, with a keyset cursor.
     * @param {{ limit?: number, before?: number|null, target?: string|null, action?: string|null }} [options]
     * @returns {Promise<{ entries: Array, nextCursor: string|null }>}
     */
    async list({ limit = 50, before = null, target = null, action = null } = {}) {
        const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
        const where = [];
        const params = {};
        if (before != null && /^\d+$/.test(String(before))) {
            params.before = Number(before);
            where.push('id < @before');
        }
        if (target) {
            params.target = String(target);
            where.push('target = @target');
        }
        if (action) {
            params.action = String(action);
            where.push('action = @action');
        }
        const rows = await db.all(
            `SELECT id, action, actor, target, detailJson, createdAt FROM operator_audit
             ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY id DESC LIMIT ${bounded + 1}`,
            params
        );
        const page = rows.slice(0, bounded).map(row => ({
            id: Number(row.id),
            action: row.action,
            actor: row.actor,
            target: row.target,
            detail: row.detailJson ? safeParse(row.detailJson) : null,
            createdAt: row.createdAt
        }));
        return { entries: page, nextCursor: rows.length > bounded ? String(page[page.length - 1].id) : null };
    }

    /** Rows that mention a person (as actor or target) - the transparency report. */
    async listForUser(userId, { limit = 100 } = {}) {
        const rows = await db.all(
            `SELECT id, action, actor, target, detailJson, createdAt FROM operator_audit
             WHERE actor = @id OR target = @id ORDER BY id DESC LIMIT @limit`,
            { id: String(userId), limit: Math.max(1, Math.min(1000, Number(limit) || 100)) }
        );
        return rows.map(row => ({
            id: Number(row.id),
            action: row.action,
            role: row.actor === String(userId) ? 'actor' : 'target',
            detail: row.detailJson ? safeParse(row.detailJson) : null,
            createdAt: row.createdAt
        }));
    }

    /**
     * Retention sweep.
     * @returns {Promise<number>} rows removed
     */
    async prune({ days = RETENTION_DAYS, now = new Date() } = {}) {
        const cutoff = new Date(now.getTime() - Math.max(1, days) * 86_400_000);
        return (await db.run('DELETE FROM operator_audit WHERE createdAt < @cutoff', { cutoff })).changes;
    }

    /** Erasure: anonymize actor and target, keep the row. */
    async forgetUser(userId) {
        const id = String(userId);
        const actors = (await db.run('UPDATE operator_audit SET actor = NULL WHERE actor = @id', { id })).changes;
        const targets = (await db.run('UPDATE operator_audit SET target = NULL WHERE target = @id', { id })).changes;
        return actors + targets;
    }

    /** Post-erasure audit count. */
    async countForUser(userId) {
        const row = await db.get(
            'SELECT COUNT(*) AS c FROM operator_audit WHERE actor = @id OR target = @id',
            { id: String(userId) }
        );
        return Number(row?.c || 0);
    }
}

function safeParse(json) {
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}

module.exports = new OperatorAuditService();
module.exports.OperatorAuditService = OperatorAuditService;
module.exports.ACTIONS = ACTIONS;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
