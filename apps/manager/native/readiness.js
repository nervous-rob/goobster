/**
 * Is the native database up before the workers start? Only a cluster this
 * manager owns AND the installation is connected to is checked
 * (documentation/native_postgres.md); with no `native-postgres.json` this
 * answers "ready" without a single command, so every other installation
 * behaves as before.
 *
 * The check asks `pg_isready` (read only, from the client package) about the
 * recorded loopback port and, when that program is not there, opens a TCP
 * connection to it. `waitReady` is bounded: it returns a `DATABASE_NOT_READY`
 * verdict the supervisor shows instead of starting workers into a database
 * that refuses them.
 */

const nodeFs = require('node:fs');
const state = require('./state');
const { tcpProbe } = require('../docker/readiness');
const { lazy } = require('../lazy');

const lib = lazy('@goobster/core/db/native');

const NOT_READY = 'DATABASE_NOT_READY';
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 1000;

const sleep = (ms) => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

function createReadiness({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const deps = () => settings.nativeDeps || {};

    function connected(doc) {
        return require('./service').createNativeService({ settings, fs, now, logger }).connectedToOwned(doc);
    }

    async function isReady(doc) {
        const host = doc.cluster.bind === '0.0.0.0' ? '127.0.0.1' : doc.cluster.bind;
        const runner = deps().runner || lib.runner.createRunner({ env: { ...process.env, ...(settings.processEnv || {}) } });
        let answer;
        try {
            answer = await runner.run('pg_isready', ['-h', host, '-p', String(doc.cluster.port), '-t', '2']);
        } catch {
            answer = null;
        }
        if (answer && !answer.missing) {
            if (answer.code === 0) return { ready: true, reason: null };
            if (answer.code === 1) return { ready: false, reason: 'STARTING' };
            if (answer.code === 2) return { ready: false, reason: 'NOT_LISTENING' };
        }
        const listening = await (deps().tcpProbe || tcpProbe)(doc.cluster.port, host);
        return listening ? { ready: true, reason: null } : { ready: false, reason: 'NOT_LISTENING' };
    }

    /**
     * @param {{ ignoreConnection?: boolean }} [options] `ignoreConnection` asks about the owned cluster even before the installation is connected to it (right after provisioning)
     * @returns {Promise<{ owned: boolean, ready: boolean, code: string|null, reason: string|null }>} never throws
     */
    async function check({ ignoreConnection = false } = {}) {
        const doc = state.read(settings.storeDir, fs).doc;
        if (!doc) return { owned: false, ready: true, code: null, reason: null };
        if (!ignoreConnection && !connected(doc)) return { owned: false, ready: true, code: null, reason: null };
        const out = await isReady(doc);
        return out.ready ? { owned: true, ready: true, code: null, reason: null } : { owned: true, ready: false, code: NOT_READY, reason: out.reason };
    }

    async function waitReady({ timeoutMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS, ignoreConnection = false } = {}) {
        const deadline = Date.now() + timeoutMs;
        let last = await check({ ignoreConnection });
        while (!last.ready && Date.now() < deadline) {
            await (deps().sleep || sleep)(pollMs);
            last = await check({ ignoreConnection });
        }
        return last;
    }

    return { check, waitReady };
}

module.exports = { createReadiness, NOT_READY, DEFAULT_WAIT_MS, DEFAULT_POLL_MS };
