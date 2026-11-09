/**
 * The delegated assistant's periodic pass (ADR 0017), started by
 * runtime/coreRuntime.js as the `assistantSteward` step when the
 * `assistant` feature is active.
 *
 * Every few minutes, under one singleton lock so the bot and the api
 * service never both run it:
 *  1. persist expiry of overdue responsibilities (their open initiatives
 *     are cancelled in the same transaction);
 *  2. return RUNNING initiatives whose lease lapsed to QUEUED;
 *  3. reconcile linked sources against their durable cursors (this is what
 *     recovers a change whose event hint was missed, e.g. across a restart);
 *  4. file Inbox envelopes still owed by committed updates.
 * Every six hours it also applies retention: process observations 90 days,
 * terminal initiatives and settled updates 180 days.
 *
 * Domain events (`attention.*`, `mission.*`) only schedule an earlier
 * reconcile for the owner they name. Nothing here runs a model, a search
 * or a sandbox, and nothing here starts work: initiatives wait for their
 * owner (or the DA-3 runner) to be queued and claimed.
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');

const LOCK = 'assistant_steward';
const INTERVAL_MS = 5 * 60 * 1000;
const RETENTION_EVERY_MS = 6 * 60 * 60 * 1000;
const RETENTION_DAYS = { observations: 90, initiatives: 180, updates: 180 };

let timer = null;
let pending = null;
let lastRetentionAt = 0;

/**
 * One pass now (skips when another process holds the lock or the feature is off).
 * @param {{ now?: Date, retention?: boolean }} [options]
 */
async function sweep({ now = new Date(), retention = null } = {}) {
    if (features.enforcedOff('assistant')) return { skipped: true, reason: 'feature' };
    if (pending) return pending;
    const runRetention = retention ?? (now.getTime() - lastRetentionAt >= RETENTION_EVERY_MS);
    pending = db.withSingletonLock(LOCK, async () => {
        const responsibilities = require('./assistantResponsibilityService');
        const initiatives = require('./assistantInitiativeService');
        const updates = require('./assistantUpdateService');
        const processes = require('./assistantProcessService');
        const result = {
            expired: await responsibilities.expireDue({ now }),
            leasesReaped: await initiatives.reapExpiredLeases({ now }),
            reconcile: await initiatives.reconcile({ now }),
            envelopes: await updates.deliverPending({})
        };
        if (runRetention) {
            lastRetentionAt = now.getTime();
            result.retention = {
                processes: await processes.prune({ days: RETENTION_DAYS.observations, now }),
                initiatives: await initiatives.prune({ days: RETENTION_DAYS.initiatives, now }),
                updates: await updates.prune({ days: RETENTION_DAYS.updates, now })
            };
        }
        return result;
    }).then(outcome => (outcome.acquired ? { skipped: false, ...outcome.result } : { skipped: true, reason: 'lock' }))
        .finally(() => { pending = null; });
    return pending;
}

function start() {
    if (timer) return;
    const tick = () => sweep()
        .then((result) => {
            if (!result.skipped && (result.expired || result.reconcile?.proposed)) {
                logger.info?.(`[assistant] ${result.expired} responsibility(ies) expired, `
                    + `${result.reconcile.proposed} new opportunity(ies)`);
            }
        })
        .catch(error => logger.warn?.(`[assistant] steward pass failed: ${error.message}`));
    require('./assistantInitiativeService').listen();
    timer = setInterval(tick, INTERVAL_MS);
    timer.unref?.();
    void tick();
}

async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    try { require('./assistantInitiativeService').stopListening(); } catch { /* never started */ }
    await pending;
}

module.exports = { start, stop, sweep, INTERVAL_MS, LOCK, RETENTION_DAYS };
