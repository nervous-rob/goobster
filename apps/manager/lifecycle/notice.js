/**
 * The Inbox notice of a scheduled restart. Delivered through
 * `inboxService.deliver()` (the Inbox is the record; never a raw DM) only
 * when the application database is there and reachable, and only to a
 * person: a portal operator principal. A local manager session
 * (`local:setup`, `local:recovery`) has no Inbox. Never throws; the
 * countdown does not depend on it.
 */

const NOTICE_TIMEOUT_MS = 5000;

/**
 * @param {Object} params
 * @param {Object} params.settings
 * @param {() => Promise<{ reachable: boolean|null, reason: string|null }>} params.probe
 * @param {string|null} params.actor
 * @param {{ revision: number, operationId: string, graceSeconds: number, deadline: string }} params.pending
 * @param {() => Object} [params.loadInbox]
 * @param {() => Object} [params.loadDb]
 * @returns {Promise<{ delivered: boolean, reason: string|null }>}
 */
async function announce({
    settings,
    probe,
    actor,
    pending,
    loadInbox = () => require('@goobster/core/services/inboxService'),
    loadDb = () => require('@goobster/core/db'),
    closeAfter = true
}) {
    if (!settings.reconcile) return { delivered: false, reason: 'RECONCILE_DISABLED' };
    if (typeof actor !== 'string' || !actor || actor.startsWith('local:')) return { delivered: false, reason: 'NO_RECIPIENT' };
    let reachability;
    try {
        reachability = await probe();
    } catch {
        return { delivered: false, reason: 'APP_DB_UNREACHABLE' };
    }
    if (!reachability || reachability.reachable !== true || reachability.reason === 'SQLITE_EMPTY') {
        return { delivered: false, reason: (reachability && reachability.reason) || 'APP_DB_UNREACHABLE' };
    }
    let db = null;
    try {
        db = loadDb();
        const delivery = loadInbox().deliver({
            userId: actor,
            kind: 'system',
            title: `Goobster restarts in ${pending.graceSeconds} seconds`,
            body: `A change is being applied. New feature work pauses at ${pending.deadline} (UTC), the workers restart at revision ${pending.revision}, and the change is kept only if every worker comes back healthy.`,
            source: { type: 'manager.lifecycle', id: pending.operationId },
            dedupeKey: `manager.lifecycle:${pending.operationId}`
        });
        delivery.catch(() => {});
        let timer;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), NOTICE_TIMEOUT_MS); });
        try {
            const raced = await Promise.race([delivery.then(() => 'ok'), timeout]);
            return raced === 'ok' ? { delivered: true, reason: null } : { delivered: false, reason: 'NOTICE_TIMEOUT' };
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return { delivered: false, reason: 'NOTICE_FAILED' };
    } finally {
        if (closeAfter && db && typeof db.closeConnection === 'function') {
            try { await db.closeConnection(); } catch { }
        }
    }
}

module.exports = { announce, NOTICE_TIMEOUT_MS };
