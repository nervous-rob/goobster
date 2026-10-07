/**
 * The core runtime lifecycle (shared-instance Increment C, spec §6).
 *
 * Everything Goobster does on a schedule or in reaction to an event -
 * automations, follow-up delivery, the attention system, project triggers,
 * expedition pickup, memory consolidation, knowledge reflection - used to
 * be started inside the bot's ClientReady handler, which made a Discord
 * login the precondition for the assistant existing at all. This module
 * owns that startup order instead, and takes the Discord client as an
 * optional input:
 *
 *  - with a live client (the bot, the lite deployment) it starts the full
 *    set, including the Discord-bound workers (guild heartbeat, monologue,
 *    agent tracker, exchange risk engine);
 *  - with only a gateway (the api service in standalone mode, or a
 *    Discord-less installation) it starts the gateway-safe set and a
 *    follow-up ticker, so scheduled results still arrive - in the inbox.
 *
 * Every worker is optional and soft-fails the same way it always did: a
 * missing dependency logs a warning and disables that worker, never the
 * process. `stop()` tears down in reverse. Workers coordinate through the
 * database singleton locks, so running the runtime in two processes at
 * once (bot + api) is safe - the second one skips passes, it does not
 * double-run them.
 *
 * Feature gating (installer P1.3, documentation/feature_state.md): a step
 * owned by a feature that is not active is not started. The one-owner steps
 * pass `{ feature }`; the runtime asks the inventory (`runtimeSteps`) and
 * records `{ name, status: 'skipped', reason: 'feature', feature }` in
 * `runtime.report`, distinct from a failure and from `paused`. Bundled core
 * steps (automation, heartbeat, personal heartbeat) always start; the
 * branches that belong to a feature are switched off inside them
 * (`applyBundledFeatureGates`). A feature step whose module is not in a
 * reduced payload (documentation/packaging.md) reports
 * `{ status: 'skipped', reason: 'absent', feature }` the same way.
 *
 * A **paused** instance (the state a restore leaves behind, see
 * documentation/backup_and_restore.md) starts only the event bus and
 * history retention; the startup catch-up and every scheduled worker wait
 * until the operator resumes from the Host room, then start on their own
 * without a process restart.
 */

const { toGateway } = require('../gateway');
const { requireSurface, surfaceActive } = require('../features/gate');
const requireOptional = require('../utils/optionalModule').forModule(module);

const FOLLOWUP_INTERVAL_MS = 60 * 1000;
/**
 * Attention candidate generators that read a feature's tables, keyed by
 * generator name; the owner is whoever the inventory says owns the table.
 */
const ATTENTION_GENERATOR_TABLES = {
    observatory_job: 'observatory_jobs',
    research_outcome: 'spitball_expeditions',
    project_mission: 'project_missions'
};
/** How often a paused process re-reads the instance pause flag. */
const PAUSE_POLL_MS = 10 * 1000;
/** A step returns this when its feature's module is not in the payload. */
const ABSENT = Symbol('absent');

/**
 * @typedef {Object} CoreRuntimeOptions
 * @property {Object|null} [client] - live discord.js client (ready), or null
 * @property {Object|null} [gateway] - DiscordGateway to use when there is no client
 * @property {Object} [logger]
 * @property {boolean} [schedulers=true] - start the periodic workers
 *   (false = only the one-shot startup reconciliation and event bus)
 * @property {boolean} [discordWorkers] - start the Discord-bound workers;
 *   defaults to `Boolean(client)`
 * @property {number} [pausePollMs] - how often a paused process re-reads
 *   the pause flag (documentation/backup_and_restore.md)
 * @property {Object} [deps] - test seam: module overrides by name
 */

/**
 * Start the core runtime. Resolves once startup has been attempted for
 * every worker; returns a handle whose `stop()` shuts them down.
 * @param {CoreRuntimeOptions} [options]
 * @returns {Promise<{ started: string[], skipped: string[], stop: () => Promise<void>, services: Object }>}
 */
async function startCoreRuntime({
    client = null,
    gateway = null,
    logger = console,
    schedulers = true,
    discordWorkers = undefined,
    pausePollMs = PAUSE_POLL_MS,
    deps = {}
} = {}) {
    const resolvedGateway = toGateway(gateway || client);
    const withDiscord = discordWorkers === undefined ? Boolean(client) : Boolean(discordWorkers);
    // Callers that only have a gateway pass it where a client is expected;
    // every consumer normalizes through toGateway, so this is the one
    // handle the whole runtime shares.
    const clientOrGateway = client || resolvedGateway;
    const load = (name, fallback) => deps[name] || fallback();

    const started = [];
    const skipped = [];
    const featureSkipped = [];
    const report = [];
    const services = {};
    const stoppers = [];

    /**
     * Run one startup step; a failure disables that worker only. A step whose
     * owning feature is not active is never invoked: the callback does not
     * run, nothing is constructed, and the report says why.
     * @param {string} name   the inventory `runtimeSteps` key
     * @param {Function} fn
     * @param {{ feature?: string }} [options] the single owning feature, for
     *   steps that belong to one (checked against the inventory by the specs)
     */
    const step = async (name, fn, { feature } = {}) => {
        let blocked;
        try {
            blocked = requireSurface('runtimeStep', name);
        } catch (error) {
            // An unclaimed step is a developer error (the inventory spec
            // fails in CI); at runtime it fails closed without taking the
            // process down.
            skipped.push(name);
            report.push({ name, status: 'failed', reason: error?.code || 'GATE_ERROR' });
            logger.error?.(`[runtime] ${name} not started: ${error?.message || error}`);
            return;
        }
        if (blocked) {
            featureSkipped.push(name);
            report.push({ name, status: 'skipped', reason: 'feature', feature: blocked.feature || feature });
            logger.info?.(`[runtime] ${name} not started: feature ${blocked.feature || feature} is not active`);
            return;
        }
        try {
            const outcome = await fn();
            if (outcome === ABSENT) {
                featureSkipped.push(name);
                report.push({ name, status: 'skipped', reason: 'absent', feature });
                logger.info?.(`[runtime] ${name} not started: feature ${feature} is not installed`);
            } else if (outcome === false) {
                skipped.push(name);
                report.push({ name, status: 'skipped', reason: 'declined' });
            } else {
                started.push(name);
                report.push({ name, status: 'started' });
            }
        } catch (error) {
            skipped.push(name);
            report.push({ name, status: 'failed', reason: 'error' });
            logger.error?.(`[runtime] ${name} failed to start: ${error?.message || error}`);
            logger.info?.(`[runtime] Continuing without ${name}`);
        }
    };

    /**
     * Switch off the feature-owned branches inside the bundled core workers
     * without constructing, subclassing or editing them: each override is a
     * no-op on this instance only, applied before `start()`.
     */
    const applyBundledFeatureGates = {
        automation(automation) {
            if (!surfaceActive('runtimeStep', 'projectTriggerCatchUp')) {
                automation._pollProjectTriggers = async () => {};
            }
        },
        heartbeat(heartbeat) {
            if (!surfaceActive('runtimeStep', 'agentTracker')) {
                heartbeat._agentProposalRepos = async () => [];
                heartbeat._proposeAgent = async () => false;
            }
        },
        personalHeartbeat() {
            const gated = Object.entries(ATTENTION_GENERATOR_TABLES)
                .filter(([, table]) => !surfaceActive('table', table));
            if (gated.length === 0) return;
            const attentionService = load('attentionService', () => require('../services/attentionService'));
            for (const [name] of gated) {
                const known = attentionService.listGenerators().find(generator => generator.name === name);
                attentionService.registerGenerator(name, {
                    description: known?.description || '',
                    run: async () => []
                });
            }
        }
    };

    // --- Always: the event bus and history retention ----------------------
    await step('eventBus', () => {
        const eventBus = load('eventBusService', () => require('../services/eventBusService'));
        eventBus.start();
        stoppers.push(async () => { await eventBus.close?.(); });
    });
    await step('chatHistoryRetention', () => {
        const retention = load('chatHistoryRetentionService', () => require('../services/chatHistoryRetentionService'));
        retention.start();
        stoppers.push(async () => { await retention.stop?.(); });
    });

    if (schedulers) await step('accountExports', () => {
        const exports = load('accountExportService', () => require('../services/accountExportService'));
        exports.start();
        stoppers.push(async () => { await exports.stop(); });
    });

    // --- Paused? (a restored instance comes back this way) -----------------
    // No autonomous work or startup catch-up runs until the operator
    // resumes from the Host room; interactive exports and retention remain available. The flag
    // is in the database, so every process sees the same answer and picks
    // the work up on its own once it clears.
    const instanceState = load('instanceStateService', () => require('../services/instanceStateService'));
    let paused = false;
    try {
        paused = await instanceState.isPaused();
    } catch (error) {
        logger.warn?.(`[runtime] Could not read the instance pause flag (${error?.message || error}); starting normally`);
    }
    if (paused) {
        const pause = await instanceState.getPause().catch(() => null);
        logger.warn?.(`[runtime] Instance is PAUSED${pause ? ` since ${pause.since} UTC (${pause.reason})` : ''}: `
            + 'scheduled work and startup catch-up are on hold until the operator resumes it from the Host room.');
        skipped.push('paused');
        report.push({ name: 'paused', status: 'skipped', reason: 'paused' });
        let starting = false;
        const watch = setInterval(async () => {
            if (starting) return;
            let stillPaused = true;
            try {
                stillPaused = await instanceState.isPaused();
            } catch { /* database hiccup - ask again next tick */ }
            if (stillPaused) return;
            starting = true;
            clearInterval(watch);
            logger.info?.('[runtime] Instance resumed - starting the workers now');
            try {
                await startWorkers();
                logger.info?.(`[runtime] Started after resume: ${started.join(', ') || 'nothing'}`);
            } catch (error) {
                logger.error?.(`[runtime] Start after resume failed: ${error?.message || error}`);
            }
        }, pausePollMs);
        watch.unref?.();
        stoppers.push(async () => clearInterval(watch));
        return finish();
    }

    await startWorkers();
    return finish();

    /** Everything a running (not paused) instance does beyond the event bus. */
    async function startWorkers() {
        // --- One-shot startup reconciliation (idempotent, lock-guarded) --------
        await step('selfDocs', async () => {
            const selfDocsService = load('selfDocsService', () => require('../services/selfDocsService'));
            const seeded = await selfDocsService.seedOnStartup({ logger });
            if (seeded?.acquired) {
                const changed = seeded.inserted + seeded.updated + seeded.deleted;
                logger.info?.(`[runtime] Self-docs: ${seeded.docs} document(s), ${seeded.chunks} chunk(s)`
                    + (changed > 0
                        ? ` (${seeded.inserted} new, ${seeded.updated} updated, ${seeded.deleted} removed)`
                        : ' (unchanged)'));
            }
        });
        await step('workshopPinMigration', async () => {
            const migration = load('workshopPinMigration', () => requireOptional('../services/workshopPinMigration', { feature: 'projects' }));
            if (!migration) return ABSENT;
            const migrated = await migration.runOnStartup();
            if (migrated?.acquired && (migrated.migrated > 0 || migrated.linked > 0)) {
                logger.info?.(`[runtime] Workshop: migrated ${migrated.migrated} pin(s) `
                    + `(${migrated.linked} already-linked) across ${migrated.users} user(s)`);
            }
        }, { feature: 'projects' });
        await step('observatoryResume', async () => {
            const observatoryService = load('observatoryService', () => requireOptional('../services/observatoryService', { feature: 'projects' }));
            if (!observatoryService) return ABSENT;
            const resumed = await observatoryService.autoResumeInterrupted({ client: clientOrGateway });
            if (resumed?.length > 0) {
                logger.info?.(`[runtime] Observatory: auto-resumed ${resumed.length} interrupted job(s): ${resumed.join(', ')}`);
            }
        }, { feature: 'observatory' });
        await step('missionReconcile', async () => {
            const missions = load('projectMissionService', () => requireOptional('../services/projectMissionService', { feature: 'projects' }));
            if (!missions) return ABSENT;
            // Another process may still be launching a child. Starting this
            // process is not evidence that every STARTING claim was abandoned;
            // use the same stale threshold as periodic reconciliation.
            const starting = await missions.reconcileStartingSteps();
            const running = await missions.reconcileRunningSteps();
            if (starting > 0 || running > 0) {
                logger.info?.(`[runtime] Missions: reconciled ${starting} STARTING and ${running} RUNNING step(s) left by a previous process`);
            }
        }, { feature: 'projects' });
        await step('projectTriggerCatchUp', async () => {
            const triggers = load('projectTriggerService', () => requireOptional('../services/projectTriggerService', { feature: 'projects' }));
            if (!triggers) return ABSENT;
            const caughtUp = await triggers.catchUpEventTriggers({ client: clientOrGateway });
            if (caughtUp > 0) {
                logger.info?.(`[runtime] Observatory: caught up ${caughtUp} project trigger fire(s) missed during downtime`);
            }
        }, { feature: 'projects' });

        if (!schedulers) {
            logger.info?.('[runtime] Schedulers off for this process (another process runs them)');
            return;
        }

        // --- Gateway-safe periodic workers ------------------------------------
        await step('automation', () => {
            const AutomationService = load('AutomationService', () => require('../services/automationService'));
            const automation = new AutomationService(client, { gateway: resolvedGateway });
            applyBundledFeatureGates.automation(automation);
            automation.start();
            services.automation = automation;
            stoppers.push(async () => automation.stop());
        });
        await step('followupDelivery', () => {
            // The bot's HeartbeatService already runs this pass on its own
            // minute timer; a process without a client needs its own ticker.
            if (client) return false;
            const followupDelivery = load('followupDeliveryService', () => require('../services/followupDeliveryService'));
            const timer = setInterval(() => {
                followupDelivery.deliverDue({ gateway: resolvedGateway })
                    .catch(error => logger.error?.(`[runtime] Follow-up pass failed: ${error.message}`));
            }, FOLLOWUP_INTERVAL_MS);
            timer.unref?.();
            services.followupTimer = timer;
            stoppers.push(async () => clearInterval(timer));
        });
        await step('personalHeartbeat', () => {
            const PersonalHeartbeatService = load('PersonalHeartbeatService', () => require('../services/personalHeartbeatService'));
            applyBundledFeatureGates.personalHeartbeat();
            const personal = new PersonalHeartbeatService(client, { gateway: resolvedGateway });
            personal.start();
            services.personalHeartbeat = personal;
            stoppers.push(async () => personal.stop());
        });
        await step('spitballExpeditions', async () => {
            const runner = load('spitballExpeditionRunner', () => requireOptional('../services/spitballExpeditionRunner', { feature: 'expeditions' }));
            if (!runner) return ABSENT;
            const kicked = await runner.start();
            if (kicked?.length > 0) {
                logger.info?.(`[runtime] Spitball: picked up ${kicked.length} queued expedition(s): ${kicked.join(', ')}`);
            }
            stoppers.push(async () => { await runner.stop?.(); });
        }, { feature: 'expeditions' });
        await step('memoryConsolidation', () => {
            const consolidation = load('memoryConsolidationService', () => require('../services/memoryConsolidationService'));
            consolidation.start();
            stoppers.push(async () => consolidation.stop?.());
        });
        await step('knowledgeReflection', () => {
            const reflection = load('knowledgeReflectionService', () => require('../services/knowledgeReflectionService'));
            reflection.start();
            stoppers.push(async () => reflection.stop?.());
        });
        await step('ledgerRetention', () => {
            // work_failures / resource_events / operator_audit retention
            // (documentation/work_ledger.md); lock-guarded like the rest.
            const ledgerRetention = load('ledgerRetentionService', () => require('../services/ledgerRetentionService'));
            ledgerRetention.start();
            stoppers.push(async () => ledgerRetention.stop?.());
        });

        // --- Discord-bound workers (need the live client) ---------------------
        if (withDiscord && client) {
            await step('heartbeat', () => {
                const HeartbeatService = load('HeartbeatService', () => require('../services/heartbeatService'));
                const heartbeat = new HeartbeatService(client);
                applyBundledFeatureGates.heartbeat(heartbeat);
                heartbeat.start();
                services.heartbeat = heartbeat;
                stoppers.push(async () => heartbeat.stop());
            });
            await step('agentTracker', () => {
                const AgentTrackerService = load('AgentTrackerService', () => requireOptional('../services/agentTrackerService', { feature: 'cursor' }));
                if (!AgentTrackerService) return ABSENT;
                const tracker = new AgentTrackerService(client);
                tracker.start();
                services.agentTracker = tracker;
                stoppers.push(async () => tracker.stop());
            }, { feature: 'cursor' });
            await step('monologue', () => {
                const MonologueService = load('MonologueService', () => require('../services/monologueService'));
                const monologue = new MonologueService(client);
                monologue.start();
                services.monologue = monologue;
                stoppers.push(async () => monologue.stop());
            });
            await step('exchangeRiskEngine', () => {
                const RiskEngine = load('RiskEngine', () => requireOptional('../services/exchange/riskEngine', { feature: 'exchange' }));
                if (!RiskEngine) return ABSENT;
                const engine = new RiskEngine(client);
                engine.start();
                services.exchangeRiskEngine = engine;
                stoppers.push(async () => engine.stop());
            }, { feature: 'exchange' });
        } else {
            skipped.push('heartbeat', 'agentTracker', 'monologue', 'exchangeRiskEngine');
            logger.info?.('[runtime] Discord-bound workers not started (no live client in this process)');
        }
    }

    function finish() {
        logger.info?.(`[runtime] Started: ${started.join(', ') || 'nothing'}`
            + (skipped.length > 0 ? ` | Skipped: ${skipped.join(', ')}` : '')
            + (featureSkipped.length > 0 ? ` | Feature off: ${featureSkipped.join(', ')}` : ''));
        let stopped = false;
        return {
            started,
            skipped,
            /** Steps left alone because their owning feature is not active (never a failure, never `paused`). */
            featureSkipped,
            /** One `{ name, status, reason?, feature? }` per step attempted, in order. */
            report,
            /** True when the process came up against a paused instance. */
            pausedAtStart: paused,
            services,
            gateway: resolvedGateway,
            async stop() {
                if (stopped) return;
                stopped = true;
                for (const stopper of stoppers.reverse()) {
                    try {
                        await stopper();
                    } catch (error) {
                        logger.error?.(`[runtime] Stop failed: ${error?.message || error}`);
                    }
                }
            }
        };
    }
}

module.exports = { startCoreRuntime, FOLLOWUP_INTERVAL_MS, PAUSE_POLL_MS, ATTENTION_GENERATOR_TABLES };
