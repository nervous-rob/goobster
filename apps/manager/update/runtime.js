/**
 * What the running manager does about updates on its own (documentation/manager_update.md):
 *
 * - at start, finish the apply a previous manager process handed over (`resume`): verify, cut
 *   over and release, or roll back, or enter recovery;
 * - on a timer, follow the policy: check, then (policy `download`) stage, then (policy `apply`
 *   and a manager-owned installation) apply inside the window. A manual check, stage or apply
 *   works whatever the mode is; the mode only says what happens without anyone asking.
 *
 * Nothing here runs unless the policy asks for it: an installation that never chose is `off`.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const release = require('../install/release');
const policyModule = require('./policy');
const wiring = require('./wiring');
const { createUpdateState } = require('./state');

const TICK_MS = 15 * 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const PRINCIPAL = 'manager:update';

function createUpdateRuntime({ manager, settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const storeDir = settings.storeDir;
    const deps = settings.updateDeps || {};
    const state = createUpdateState({ storeDir, fs, now });
    let timer = null;
    let running = false;
    let stopped = false;

    /** The release `<code>/current` holds, read at each worker launch (the supervisor's `releaseIdOf`). */
    function releaseIdOf() {
        const doc = manager.store.readInstallation();
        if (doc.status !== 'ok' || !doc.doc.roots || !doc.doc.release) return null;
        try {
            return release.loadManifest(path.join(doc.doc.roots.code, 'current'), fs).releaseId;
        } catch {
            return null;
        }
    }

    /** Finish a handoff left by an earlier manager process. Never throws. */
    async function resume() {
        const applier = wiring.applier(storeDir);
        if (!applier) return { resumed: false };
        try {
            const out = await applier.resume();
            if (out.resumed) logger.info?.(`[manager] update handoff finished: ${out.outcome || 'ok'}${out.code ? ` (${out.code})` : ''}`);
            return out;
        } catch (error) {
            logger.error?.(`[manager] the update handoff could not be finished: ${error && (error.code || error.name)}`);
            return { resumed: false, code: error && error.code ? error.code : 'RESUME_FAILED' };
        }
    }

    const auth = { principal: PRINCIPAL, via: 'local' };

    async function run(kind, input) {
        try {
            return await manager.engine.run(kind, input, auth);
        } catch (error) {
            logger.warn?.(`[manager] scheduled ${kind} did not run: ${error && (error.code || error.name)}`);
            return null;
        }
    }

    async function tick() {
        if (running || stopped) return;
        running = true;
        try {
            if (manager.currentState().state !== 'claimed') return;
            const read = manager.store.readInstallation();
            if (read.status !== 'ok' || !read.doc.release) return;
            const doc = read.doc;
            const policy = policyModule.current(doc);
            const effective = policyModule.effectiveMode(policy, doc.updater);
            if (state.read('handoff') || state.read('recovery')) return;

            const scheduled = state.read('scheduled');
            if (scheduled && state.read('staged')) {
                if (!policy.window || policyModule.inWindow(policy.window, now())) await run('update.apply', { when: 'now' });
                return;
            }
            if (effective.mode === 'off') return;

            const last = state.read('last-check');
            const interval = Number.isFinite(deps.checkEveryMs) ? deps.checkEveryMs : CHECK_EVERY_MS;
            const due = !last || now().getTime() - Date.parse(last.at) >= interval;
            if (due) {
                const checked = await run('update.check', {});
                if (!checked || !checked.result || checked.result.outcome !== 'available') return;
            } else if (!last || last.outcome !== 'available') {
                return;
            }
            if (effective.mode === 'check') return;

            const staged = state.read('staged');
            const offered = (state.read('last-check') || {}).latest;
            if (!staged || (offered && staged.version !== offered.version)) {
                const out = await run('update.stage', {});
                if (!out) return;
            }
            if (effective.mode !== 'apply') return;
            const inWindow = !policy.window || policyModule.inWindow(policy.window, now());
            await run('update.apply', { when: inWindow ? 'now' : 'window' });
        } catch (error) {
            logger.warn?.(`[manager] the update scheduler failed: ${error && (error.code || error.name)}`);
        } finally {
            running = false;
        }
    }

    function start() {
        if (timer || stopped) return;
        const every = Number.isFinite(deps.tickMs) ? deps.tickMs : TICK_MS;
        timer = setInterval(() => { tick(); }, every);
        timer.unref?.();
    }

    function stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { releaseIdOf, resume, tick, start, stop };
}

module.exports = { createUpdateRuntime, TICK_MS, CHECK_EVERY_MS, PRINCIPAL };
