/**
 * The delegated-work runner (DA-3, ADR 0018), started by
 * runtime/coreRuntime.js as the `assistantRunner` step when the `assistant`
 * feature is active.
 *
 * Every 30 seconds it looks for QUEUED initiatives and executes them with
 * assistantRunService, within the host's caps (assistantControlService):
 * `runsPerAccount` running initiatives per person and `installationRuns`
 * across the installation - by default one and two, a Raspberry Pi's worth
 * of background work; foreground chat keeps priority at model admission.
 * While the host has stopped all delegated work it claims nothing. Claims
 * are serialized database transactions that re-check the flag and both
 * caps, so the bot and the api service can both run a runner without doing
 * the same work twice or exceeding a cap between them.
 *
 * It only ever takes what a person queued: a proposed initiative
 * (CANDIDATE) waits for its owner. Stopping the runner asks in-flight runs
 * to halt at their next tool call; their leases lapse and the steward
 * returns them to QUEUED, where they resume from their journals.
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');

const INTERVAL_MS = 30 * 1000;
const FIRST_TICK_DELAY_MS = 90 * 1000;
const SCAN = 25;

let timer = null;
let firstTick = null;
let stopping = false;
const inFlight = new Map();

/**
 * One pass: claim what the limits allow and start it. Resolves once the
 * claims are made; the runs continue in the background unless `wait`.
 * @param {{ wait?: boolean }} [options]
 * @returns {Promise<{ skipped?: string, started: number, results?: Object[] }>}
 */
async function tick({ wait = false } = {}) {
    if (stopping) return { skipped: 'stopping', started: 0 };
    if (features.enforcedOff('assistant')) return { skipped: 'feature', started: 0 };
    const initiatives = require('./assistantInitiativeService');
    const runs = require('./assistantRunService');
    const control = require('./assistantControlService');
    if (await control.isPaused()) return { skipped: 'paused', started: 0 };
    const caps = await control.caps();
    const load = await control.running();
    let free = caps.installationRuns - load.total;
    if (free <= 0) return { skipped: 'capacity', started: 0 };

    // Oldest first, one owner at a time, so one person cannot fill the cap.
    const queued = await db.all(
        `SELECT id, ownerUserId FROM assistant_initiatives WHERE status = 'QUEUED'
         ORDER BY updatedAt, id LIMIT ${SCAN}`,
        {}
    );
    const started = [];
    for (const row of queued) {
        if (free <= 0 || stopping) break;
        const owner = String(row.ownerUserId);
        if ((load.byOwner.get(owner) || 0) >= caps.runsPerAccount) continue;
        const claim = await initiatives.claim({ id: row.id });
        // Another process took the last slot, or the host stopped everything.
        if (!claim.ok && (claim.code === 'INSTALLATION_CAP' || claim.code === control.PAUSED_CODE)) break;
        if (!claim.ok) continue;
        load.byOwner.set(owner, (load.byOwner.get(owner) || 0) + 1);
        free -= 1;
        const work = runs.execute({ initiative: claim.initiative, leaseToken: claim.leaseToken, shouldStop: () => stopping })
            .catch((error) => {
                logger.warn?.(`[assistant runner] initiative ${row.id} ended unexpectedly: ${error.message}`);
                return { status: 'FAILED', stopCode: 'RUNNER_ERROR' };
            })
            .finally(() => inFlight.delete(row.id));
        inFlight.set(row.id, work);
        started.push(work);
    }
    if (wait) return { started: started.length, results: await Promise.all(started) };
    return { started: started.length };
}

function start() {
    if (timer) return;
    stopping = false;
    const pass = () => tick().catch(error => logger.warn?.(`[assistant runner] pass failed: ${error.message}`));
    timer = setInterval(pass, INTERVAL_MS);
    timer.unref?.();
    firstTick = setTimeout(() => { firstTick = null; void pass(); }, FIRST_TICK_DELAY_MS);
    firstTick.unref?.();
}

/** Stop claiming, ask in-flight runs to halt, and wait for them to settle. */
async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    if (firstTick) clearTimeout(firstTick);
    timer = null;
    firstTick = null;
    await Promise.allSettled([...inFlight.values()]);
}

/** Tests: clear the stopping flag between cases. */
function _reset() {
    stopping = false;
    inFlight.clear();
}

module.exports = { start, stop, tick, _reset, INTERVAL_MS };
