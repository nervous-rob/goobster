/**
 * Retention sweeps for the diagnostics and cost ledgers (roadmap #256):
 * work_failures (30 days), resource_events (90 days) and operator_audit
 * (one year). One pass every few hours under a singleton lock, so the bot
 * and the api service never sweep at the same time. Started by
 * runtime/coreRuntime.js with the other scheduled workers.
 */

const db = require('../db');
const logger = require('../utils/logger');

const LOCK = 'ledger_retention';
const INTERVAL_MS = 6 * 60 * 60 * 1000;

let timer = null;
let pending = null;

/**
 * Run one sweep now (skips when another process holds the lock).
 * @returns {Promise<{ skipped: boolean, workFailures?: number, resourceEvents?: number, operatorAudit?: number }>}
 */
async function sweep() {
    if (pending) return pending;
    pending = db.withSingletonLock(LOCK, async () => ({
        workFailures: await require('./workFailureService').prune(),
        resourceEvents: await require('./resourceEventService').prune(),
        operatorAudit: await require('./operatorAuditService').prune()
    })).then(outcome => (outcome.acquired ? { skipped: false, ...outcome.result } : { skipped: true }))
        .finally(() => { pending = null; });
    return pending;
}

function start() {
    if (timer) return;
    const tick = () => sweep()
        .then(result => {
            const removed = (result.workFailures || 0) + (result.resourceEvents || 0) + (result.operatorAudit || 0);
            if (!result.skipped && removed > 0) {
                logger.info?.(`[ledger retention] Removed ${result.workFailures} failure(s), `
                    + `${result.resourceEvents} resource event(s), ${result.operatorAudit} audit row(s) past retention`);
            }
        })
        .catch(error => logger.warn?.(`[ledger retention] ${error.message}`));
    timer = setInterval(tick, INTERVAL_MS);
    timer.unref?.();
    void tick();
}

async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await pending;
}

module.exports = { start, stop, sweep, INTERVAL_MS, LOCK };
