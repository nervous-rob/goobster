/**
 * The update status document (GET /update/status, `update status`): what is installed, the
 * policy and what it effectively allows, the last check, what is staged, whether an apply is
 * waiting for its handoff or for a decision, and how the last one ended. Versions, release ids,
 * codes and times only: the source is named by kind (and a GitHub repository), never by an
 * address or a path.
 */

const nodeFs = require('node:fs');
const policyModule = require('./policy');
const { createUpdateState } = require('./state');
const wiring = require('./wiring');

function describeSource(policy) {
    const source = policyModule.sourceOf(policy);
    return { kind: source.kind, ...(source.kind === 'github-release' ? { owner: source.owner, repo: source.repo } : {}) };
}

function buildStatus({ manager, settings, fs = nodeFs, now = () => new Date() }) {
    const read = manager.store.readInstallation();
    if (read.status !== 'ok') return { available: false, code: 'NOT_INSTALLED' };
    const doc = read.doc;
    if (!doc.release) return { available: false, code: 'NO_RELEASE_RECORDED' };
    const state = createUpdateState({ storeDir: settings.storeDir, fs, now });
    const policy = policyModule.current(doc);
    const effective = policyModule.effectiveMode(policy, doc.updater);
    const applier = wiring.applier(settings.storeDir);
    const staged = state.read('staged');
    const lastCheck = state.read('last-check');
    const inFlight = applier ? applier.statusOf() : { handoff: null, watchdog: null, recovery: null, scheduled: null, lastApply: state.read('last-apply') };
    return {
        available: true,
        installed: { version: doc.release.version, releaseId: doc.release.releaseId, target: doc.release.target, features: doc.release.features },
        updater: doc.updater ? doc.updater.kind : null,
        policy: {
            channel: policy.channel,
            mode: policy.mode,
            effectiveMode: effective.mode,
            ...(effective.capped ? { capped: 'apply is honoured only while the manager is the updater' } : {}),
            ...(policy.window ? { window: policy.window } : {}),
            source: describeSource(policy)
        },
        lastCheck: lastCheck ? { at: lastCheck.at, outcome: lastCheck.outcome, ...(lastCheck.code ? { code: lastCheck.code } : {}), ...(lastCheck.latest ? { latest: lastCheck.latest } : {}) } : null,
        staged: staged ? { version: staged.version, releaseId: staged.releaseId, schemaChanging: Boolean(staged.schemaChanging), stagedAt: staged.stagedAt, stale: staged.fromReleaseId !== doc.release.releaseId } : null,
        handoff: inFlight.handoff,
        watchdog: inFlight.watchdog,
        recovery: inFlight.recovery,
        scheduled: inFlight.scheduled ? { opensAt: inFlight.scheduled.opensAt, requestedAt: inFlight.scheduled.requestedAt } : null,
        lastApply: inFlight.lastApply,
        handoffAvailability: applier ? applier.handoffAvailability(doc) : null
    };
}

module.exports = { buildStatus };
