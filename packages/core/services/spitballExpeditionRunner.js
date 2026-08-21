/**
 * The Spitball Expedition runner: the durable orchestrator that drives an
 * Expedition through its Cycles (spec: documentation/spitball_expeditions.md
 * §31/§40). Same philosophy as the Observatory job loop:
 *
 *  - Durable rows own the truth; the runner holds only transient in-process
 *    handles (which expedition ids this process is currently driving).
 *  - Claim-before-run: a QUEUED expedition is claimed with an atomic status
 *    UPDATE, so a duplicated kick or a second process can never double-run
 *    one cycle.
 *  - The recursive loop is explicit code, not prompt-implied: after every
 *    completed cycle the deterministic continuation policy
 *    (spitballExpeditionService.decideContinuation) decides whether the next
 *    cycle may run, and the compact frontier state (buildFrontierInput) is
 *    what carries forward - never the previous model transcript.
 *  - Restart safety: orphaned RUNNING expeditions are parked PAUSED at
 *    startup (research spend should not silently resume), their interrupted
 *    cycle is CANCELLED, and QUEUED ones are picked back up.
 *
 * The semantic work lives behind the injected pipeline
 * (services/spitballResearchPipeline.js); the runner never talks to models
 * or search providers itself.
 */

const db = require('../db');
const logger = require('../utils/logger');
const expeditionService = require('./spitballExpeditionService');
const defaultPipeline = require('./spitballResearchPipeline');

class SpitballExpeditionRunner {
    /**
     * @param {Object} [deps]
     * @param {Object} [deps.service] - spitballExpeditionService (tests inject)
     * @param {Object} [deps.pipeline] - { runCycle } (tests inject a mock)
     * @param {Object} [deps.reflection] - { runScope } (defaults to the real
     *   knowledgeReflectionService, resolved lazily; tests inject a mock)
     */
    constructor({ service = expeditionService, pipeline = defaultPipeline, reflection = null } = {}) {
        this.service = service;
        this.pipeline = pipeline;
        this._reflection = reflection;
        /** @type {Map<number, Promise<void>>} live run loops by expedition id */
        this._live = new Map();
    }

    get reflection() {
        if (!this._reflection) {
            this._reflection = require('./knowledgeReflectionService');
        }
        return this._reflection;
    }

    /**
     * Startup: park orphans and pick QUEUED expeditions back up. Runs under a
     * singleton lock so a second process skips instead of double-claiming
     * (claims are atomic anyway; the lock just avoids duplicate reap logs).
     * @returns {Promise<number[]>} expedition ids kicked
     */
    async start() {
        if (!this.service.enabled) return [];
        const outcome = await db.withSingletonLock('spitball_expedition_startup', async () => {
            const parked = await this.service.reapOrphans(new Set(this._live.keys()));
            for (const id of parked) {
                logger.info?.(`[spitball] Parked expedition #${id} (interrupted by restart) - the owner can continue it`);
            }
            return this.service.listQueuedIds();
        });
        if (!outcome.acquired) return [];
        const kicked = [];
        for (const id of outcome.result) {
            this.kick(id);
            kicked.push(id);
        }
        return kicked;
    }

    /**
     * Fire-and-forget: start driving an expedition if nobody is. Safe to call
     * repeatedly (create, continue, restart pickup) - the claim decides.
     * @param {number} expeditionId
     */
    kick(expeditionId) {
        const id = Number(expeditionId);
        if (!Number.isFinite(id) || this._live.has(id)) return;
        const loop = this._runLoop(id)
            .catch(error => logger.error?.(`[spitball] Expedition #${id} loop crashed: ${error.message}`))
            .finally(() => this._live.delete(id));
        this._live.set(id, loop);
    }

    /** Await the live loop for an expedition (tests). */
    async waitFor(expeditionId) {
        const loop = this._live.get(Number(expeditionId));
        if (loop) await loop;
    }

    /** @returns {boolean} whether this process is driving the expedition */
    isLive(expeditionId) {
        return this._live.has(Number(expeditionId));
    }

    /**
     * Post-ingestion reflection at the cycle boundary (spec §21): once a
     * cycle has committed enough fresh notes, run weave/tidy over the
     * expedition's scope so the new research gets connected into the existing
     * graph before the next frontier is built. Batched per cycle, never per
     * write; a reflection failure costs connectivity, never the expedition.
     */
    async _maybeReflect(expedition, cycle) {
        const knob = this.service.config.cycleReflection;
        if (!knob?.enabled) return;
        if ((cycle.notesCreated + cycle.notesMerged) < knob.minNotesForWeave) return;
        try {
            await this.service.heartbeat(expedition.id);
            await this.reflection.runScope({
                guildId: expedition.guildId,
                scopeKey: expedition.scopeKey,
                subjectType: 'USER',
                subjectId: expedition.userId,
                passes: ['weave', 'tidy'],
                trigger: 'scheduled',
                requestedBy: 'spitball'
            });
        } catch (error) {
            logger.warn?.(`[spitball] Post-cycle reflection for expedition #${expedition.id} failed: ${error.message}`);
        }
    }

    async _runLoop(expeditionId) {
        const claimed = await this.service.claimForRun(expeditionId);
        if (!claimed) return;

        while (true) {
            const expedition = await this.service.getById(expeditionId);
            if (!expedition || expedition.status !== 'RUNNING') return; // paused/cancelled externally

            const frontierInput = await this.service.buildFrontierInput(expedition);
            const cycle = await this.service.startCycle(expeditionId, { frontierInput });

            let result;
            try {
                result = await this.pipeline.runCycle({
                    expedition,
                    cycle,
                    frontierInput,
                    heartbeat: () => this.service.heartbeat(expeditionId)
                });
            } catch (error) {
                const message = error?.message || 'The research cycle failed.';
                await this.service.finishCycle(cycle.id, { status: 'FAILED', error: message });
                await this.service.failExpedition(expeditionId, { error: message });
                return;
            }

            const finished = await this.service.finishCycle(cycle.id, {
                status: 'COMPLETED',
                counters: result?.counters || {},
                plan: result?.plan || null,
                coverage: result?.coverage || null,
                leads: result?.leads || null,
                noveltyScore: result?.noveltyScore ?? result?.coverage?.noveltyScore ?? null,
                coverageScore: result?.coverageScore ?? result?.coverage?.coverageScore ?? null
            });
            // finishCycle returns null when the cycle was cancelled from under
            // us (user cancel marks RUNNING cycles); the expedition status
            // check below ends the loop.
            if (finished && finished.status === 'COMPLETED') {
                await this._maybeReflect(expedition, finished);
            }
            const fresh = await this.service.getById(expeditionId);
            if (!fresh || fresh.status !== 'RUNNING') return;

            const earlier = (await this.service.listCycles(expeditionId, { userId: fresh.userId }))
                .filter(c => c.id !== cycle.id);
            const decision = this.service.decideContinuation({
                expedition: fresh,
                cycle: finished || cycle,
                leads: result?.leads || [],
                recentCycles: earlier
            });
            if (!decision.continue) {
                await this.service.completeExpedition(expeditionId, {
                    stopReason: decision.reason,
                    summary: result?.coverage?.summary || null
                });
                return;
            }
        }
    }
}

module.exports = new SpitballExpeditionRunner();
module.exports.SpitballExpeditionRunner = SpitballExpeditionRunner;
