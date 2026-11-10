/**
 * The delegated assistant's periodic pass (ADR 0017), started by
 * runtime/coreRuntime.js as the `assistantSteward` step when the
 * `assistant` feature is active.
 *
 * A minute after start and then every five minutes, under one singleton
 * lock so the bot and the api service never both run it:
 *  1. persist expiry of overdue responsibilities (their open initiatives
 *     are cancelled in the same transaction);
 *  2. return RUNNING initiatives whose lease lapsed to QUEUED, and WAITING
 *     ones whose budget or dependency recheck time has come;
 *  3. reconcile linked sources against their durable cursors (this is what
 *     recovers a change whose event hint was missed, e.g. across a restart);
 *  4. adopt open project gates into canonical updates and resolve adopted
 *     ones whose gate closed (assistantGateService);
 *  5. file Inbox envelopes still owed by committed updates.
 * Each pass records its time in `instance_state` (`assistant_steward_pass`)
 * so the Home projection can say when its picture was last refreshed.
 * Every six hours it also applies retention: process observations 90 days,
 * terminal initiatives and settled updates 180 days, the daily proposal
 * counters 14 days and the chat-message labels 30 days.
 *
 * Domain events (`attention.*`, `mission.*`) only schedule an earlier
 * reconcile for the owner they name. The only model call here is the narrow
 * label DA-8 gives a personal-chat message (messageClassification.js, charged
 * to the responsibility's own budget, off while the host's stop-all is on).
 * Nothing here runs a search or a sandbox, and nothing here starts work:
 * initiatives wait for their owner (or the DA-3 runner) to be queued and
 * claimed.
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');

const LOCK = 'assistant_steward';
const { HEARTBEAT_KEY } = require('./assistantHomeService');
const INTERVAL_MS = 5 * 60 * 1000;
const RETENTION_EVERY_MS = 6 * 60 * 60 * 1000;
const RETENTION_DAYS = { observations: 90, initiatives: 180, updates: 180 };
// The first pass waits so it does not compete for pooled connections with
// the other startup sweeps that each hold one for a singleton lock.
const FIRST_PASS_DELAY_MS = 60 * 1000;

let timer = null;
let firstPass = null;
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
            children: await require('./assistantRunService').reconcileChildren({ now }),
            requeued: await initiatives.requeueDue({ now }),
            reconcile: await initiatives.reconcile({ now }),
            gates: await require('./assistantGateService').adoptProjectGates({}),
            envelopes: await updates.deliverPending({})
        };
        // Home says how fresh its picture is from this, in any process.
        await require('./instanceStateService').set(HEARTBEAT_KEY, { at: now.toISOString() });
        if (runRetention) {
            lastRetentionAt = now.getTime();
            result.retention = {
                processes: await processes.prune({ days: RETENTION_DAYS.observations, now }),
                runs: await require('./assistantRunService').prune({ days: RETENTION_DAYS.initiatives, now }),
                initiatives: await initiatives.prune({ days: RETENTION_DAYS.initiatives, now }),
                updates: await updates.prune({ days: RETENTION_DAYS.updates, now }),
                proposalCounters: await require('./assistant/proposalCaps').prune({ now }),
                messageLabels: await require('./assistant/messageClassification').prune({ now })
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
    firstPass = setTimeout(() => { firstPass = null; void tick(); }, FIRST_PASS_DELAY_MS);
    firstPass.unref?.();
}

async function stop() {
    if (timer) clearInterval(timer);
    if (firstPass) clearTimeout(firstPass);
    timer = null;
    firstPass = null;
    try { require('./assistantInitiativeService').stopListening(); } catch { /* never started */ }
    await pending;
}

module.exports = { start, stop, sweep, INTERVAL_MS, FIRST_PASS_DELAY_MS, LOCK, HEARTBEAT_KEY, RETENTION_DAYS };
