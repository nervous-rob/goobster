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
 */

const { toGateway } = require('../gateway');

const FOLLOWUP_INTERVAL_MS = 60 * 1000;

/**
 * @typedef {Object} CoreRuntimeOptions
 * @property {Object|null} [client] - live discord.js client (ready), or null
 * @property {Object|null} [gateway] - DiscordGateway to use when there is no client
 * @property {Object} [logger]
 * @property {boolean} [schedulers=true] - start the periodic workers
 *   (false = only the one-shot startup reconciliation and event bus)
 * @property {boolean} [discordWorkers] - start the Discord-bound workers;
 *   defaults to `Boolean(client)`
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
    const services = {};
    const stoppers = [];

    /** Run one startup step; a failure disables that worker only. */
    const step = async (name, fn) => {
        try {
            const outcome = await fn();
            if (outcome === false) {
                skipped.push(name);
            } else {
                started.push(name);
            }
        } catch (error) {
            skipped.push(name);
            logger.error?.(`[runtime] ${name} failed to start: ${error?.message || error}`);
            logger.info?.(`[runtime] Continuing without ${name}`);
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
        const migration = load('workshopPinMigration', () => require('../services/workshopPinMigration'));
        const migrated = await migration.runOnStartup();
        if (migrated?.acquired && (migrated.migrated > 0 || migrated.linked > 0)) {
            logger.info?.(`[runtime] Workshop: migrated ${migrated.migrated} pin(s) `
                + `(${migrated.linked} already-linked) across ${migrated.users} user(s)`);
        }
    });
    await step('observatoryResume', async () => {
        const observatoryService = load('observatoryService', () => require('../services/observatoryService'));
        const resumed = await observatoryService.autoResumeInterrupted({ client: clientOrGateway });
        if (resumed?.length > 0) {
            logger.info?.(`[runtime] Observatory: auto-resumed ${resumed.length} interrupted job(s): ${resumed.join(', ')}`);
        }
    });
    await step('missionReconcile', async () => {
        const missions = load('projectMissionService', () => require('../services/projectMissionService'));
        const starting = await missions.reconcileStartingSteps({ olderThanMs: 0 });
        const running = await missions.reconcileRunningSteps();
        if (starting > 0 || running > 0) {
            logger.info?.(`[runtime] Missions: reconciled ${starting} STARTING and ${running} RUNNING step(s) left by a previous process`);
        }
    });
    await step('projectTriggerCatchUp', async () => {
        const triggers = load('projectTriggerService', () => require('../services/projectTriggerService'));
        const caughtUp = await triggers.catchUpEventTriggers({ client: clientOrGateway });
        if (caughtUp > 0) {
            logger.info?.(`[runtime] Observatory: caught up ${caughtUp} project trigger fire(s) missed during downtime`);
        }
    });

    if (!schedulers) {
        logger.info?.('[runtime] Schedulers off for this process (another process runs them)');
        return finish();
    }

    // --- Gateway-safe periodic workers ------------------------------------
    await step('automation', () => {
        const AutomationService = load('AutomationService', () => require('../services/automationService'));
        const automation = new AutomationService(client, { gateway: resolvedGateway });
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
        const personal = new PersonalHeartbeatService(client, { gateway: resolvedGateway });
        personal.start();
        services.personalHeartbeat = personal;
        stoppers.push(async () => personal.stop());
    });
    await step('spitballExpeditions', async () => {
        const runner = load('spitballExpeditionRunner', () => require('../services/spitballExpeditionRunner'));
        const kicked = await runner.start();
        if (kicked?.length > 0) {
            logger.info?.(`[runtime] Spitball: picked up ${kicked.length} queued expedition(s): ${kicked.join(', ')}`);
        }
        stoppers.push(async () => { await runner.stop?.(); });
    });
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

    // --- Discord-bound workers (need the live client) ---------------------
    if (withDiscord && client) {
        await step('heartbeat', () => {
            const HeartbeatService = load('HeartbeatService', () => require('../services/heartbeatService'));
            const heartbeat = new HeartbeatService(client);
            heartbeat.start();
            services.heartbeat = heartbeat;
            stoppers.push(async () => heartbeat.stop());
        });
        await step('agentTracker', () => {
            const AgentTrackerService = load('AgentTrackerService', () => require('../services/agentTrackerService'));
            const tracker = new AgentTrackerService(client);
            tracker.start();
            services.agentTracker = tracker;
            stoppers.push(async () => tracker.stop());
        });
        await step('monologue', () => {
            const MonologueService = load('MonologueService', () => require('../services/monologueService'));
            const monologue = new MonologueService(client);
            monologue.start();
            services.monologue = monologue;
            stoppers.push(async () => monologue.stop());
        });
        await step('exchangeRiskEngine', () => {
            const RiskEngine = load('RiskEngine', () => require('../services/exchange/riskEngine'));
            const engine = new RiskEngine(client);
            engine.start();
            services.exchangeRiskEngine = engine;
            stoppers.push(async () => engine.stop());
        });
    } else {
        skipped.push('heartbeat', 'agentTracker', 'monologue', 'exchangeRiskEngine');
        logger.info?.('[runtime] Discord-bound workers not started (no live client in this process)');
    }

    return finish();

    function finish() {
        logger.info?.(`[runtime] Started: ${started.join(', ') || 'nothing'}`
            + (skipped.length > 0 ? ` | Skipped: ${skipped.join(', ')}` : ''));
        let stopped = false;
        return {
            started,
            skipped,
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

module.exports = { startCoreRuntime, FOLLOWUP_INTERVAL_MS };
