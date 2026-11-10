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
 *  5. open, reopen, settle and resolve process incidents
 *     (assistantIncidentService; a stall counts toward an incident only
 *     for time this installation was itself running), and for a process
 *     that outlived its purpose either pause it under a grant that names
 *     it or ask its owner (assistantProcessLifecycleService);
 *  6. file Inbox envelopes still owed by committed updates;
 *  7. send what the interruption rules allow beyond the portal: contacts
 *     still owed for open requests, and each person's digest when it is
 *     due (assistantDeliveryService, through Attention's contact path).
 * Each pass records its time in `instance_state` (`assistant_steward_pass`)
 * so the Home projection can say when its picture was last refreshed, and
 * since when passes have followed each other without a gap.
 * Every six hours it also applies retention: process observations 90 days,
 * terminal initiatives, settled updates, resolved incidents and lifecycle
 * records of processes that are running again 180 days, the daily proposal
 * counters 14 days, the chat-message labels 30 days, digests 90 days and
 * the contact ledger 30 days.
 *
 * Domain events (`attention.*`, `mission.*`) only schedule an earlier
 * reconcile for the owner they name. The only model call here is the narrow
 * label DA-8 gives a personal-chat message (messageClassification.js, charged
 * to the responsibility's own budget, off while the host's stop-all is on).
 * Nothing here runs a search or a sandbox, and nothing here starts work:
 * initiatives wait for their owner (or the DA-3 runner) to be queued and
 * claimed. The one thing it changes outside its own records is a pause or
 * archive of a process, and only where `authorize()` says a grant covers it.
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');

const LOCK = 'assistant_steward';
const { HEARTBEAT_KEY, STALE_AFTER_MS } = require('./assistantHomeService');
const INTERVAL_MS = 5 * 60 * 1000;
const RETENTION_EVERY_MS = 6 * 60 * 60 * 1000;
const RETENTION_DAYS = { observations: 90, initiatives: 180, updates: 180, incidents: 180, lifecycle: 180 };
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
        const instanceState = require('./instanceStateService');
        // Since when passes have followed each other without a gap. Across a
        // gap this installation was not running (stopped, paused, restored),
        // and a schedule that slipped then is not the process's fault.
        const beat = await instanceState.get(HEARTBEAT_KEY);
        const previous = Date.parse(beat?.at || '');
        const since = Date.parse(beat?.since || beat?.at || '');
        const continuous = Number.isFinite(previous) && now.getTime() - previous >= 0 && now.getTime() - previous <= STALE_AFTER_MS;
        const upSince = continuous && Number.isFinite(since) ? new Date(since) : now;
        const result = {
            expired: await responsibilities.expireDue({ now }),
            leasesReaped: await initiatives.reapExpiredLeases({ now }),
            children: await require('./assistantRunService').reconcileChildren({ now }),
            requeued: await initiatives.requeueDue({ now }),
            reconcile: await initiatives.reconcile({ now }),
            gates: await require('./assistantGateService').adoptProjectGates({}),
            incidents: await require('./assistantIncidentService').reconcile({ now, upSince }),
            envelopes: await updates.deliverPending({}),
            knowledgeProposalsExpired: await require('./knowledgeChangeSetService').expireOpen({ now }),
            connectorRequests: await require('./assistantConnectorRequestService').withdrawStale()
        };
        // After the envelopes: a contact or a digest points at a filed one.
        result.delivery = await require('./assistantDeliveryService').sweep({ now });
        // Home says how fresh its picture is from this, in any process.
        await instanceState.set(HEARTBEAT_KEY, { at: now.toISOString(), since: upSince.toISOString() });
        if (runRetention) {
            lastRetentionAt = now.getTime();
            result.retention = {
                processes: await processes.prune({ days: RETENTION_DAYS.observations, now }),
                incidents: await require('./assistantIncidentService').prune({ days: RETENTION_DAYS.incidents, now }),
                lifecycle: await require('./assistantProcessLifecycleService').prune({ days: RETENTION_DAYS.lifecycle, now }),
                runs: await require('./assistantRunService').prune({ days: RETENTION_DAYS.initiatives, now }),
                initiatives: await initiatives.prune({ days: RETENTION_DAYS.initiatives, now }),
                updates: await updates.prune({ days: RETENTION_DAYS.updates, now }),
                proposalCounters: await require('./assistant/proposalCaps').prune({ now }),
                messageLabels: await require('./assistant/messageClassification').prune({ now }),
                knowledgeChanges: await require('./knowledgeChangeSetService').prune({ now }),
                connectorRequests: await require('./assistantConnectorRequestService').prune({ days: RETENTION_DAYS.initiatives, now }),
                delivery: await require('./assistantDeliveryService').prune({ now })
            };
        }
        return result;
    }).then(outcome => (outcome.acquired ? { skipped: false, ...outcome.result } : { skipped: true, reason: 'lock' }))
        .finally(() => { pending = null; });
    return pending;
}

/**
 * @param {{ gateway?: Object }} [options] - the Discord gateway this process
 *   sends through; without one, outbound contact is the browser push only
 */
function start({ gateway = null } = {}) {
    if (timer) return;
    require('./assistantDeliveryService').attach({ gateway });
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
    try { require('./assistantDeliveryService').detach(); } catch { /* never attached */ }
    await pending;
}

module.exports = { start, stop, sweep, INTERVAL_MS, FIRST_PASS_DELAY_MS, LOCK, HEARTBEAT_KEY, RETENTION_DAYS };
