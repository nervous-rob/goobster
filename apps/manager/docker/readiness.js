/**
 * Is the database up before the workers start? Only a Docker database this
 * manager owns AND the installation is connected to is checked (documentation/
 * docker_postgres.md); with no `docker-postgres.json` this answers "ready"
 * without a single command, so every other installation behaves as before.
 * The native cluster's own check (native/readiness.js) is asked whenever no
 * Docker database is the one in use, so this is the supervisor's one gate.
 *
 * The check asks Docker for the container's own health (`pg_isready` runs inside
 * it) and, as the fallback when the daemon is not answering, a TCP connection to
 * the published port. `waitReady` is bounded: it returns a `DATABASE_NOT_READY`
 * verdict the supervisor shows instead of starting workers into a database that
 * refuses them.
 */

const net = require('node:net');
const nodeFs = require('node:fs');
const state = require('./state');
const { createDockerService } = require('./service');

const NOT_READY = 'DATABASE_NOT_READY';
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 1000;

function tcpProbe(port, host, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host, timeout: timeoutMs });
        const done = (value) => { socket.destroy(); resolve(value); };
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

const sleep = (ms) => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

function createReadiness({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const service = () => createDockerService({ settings, fs, now, logger });
    const deps = () => settings.dockerDeps || {};

    /** @returns {Promise<{ owned: boolean, ready: boolean, code: string|null, reason: string|null }>} never throws */
    async function check() {
        const doc = state.read(settings.storeDir, fs).doc;
        if (!doc) return require('../native/readiness').createReadiness({ settings, fs, now, logger }).check();
        const dockerService = service();
        if (!dockerService.connectedToOwned(doc)) return require('../native/readiness').createReadiness({ settings, fs, now, logger }).check();
        const host = doc.request.bind === '0.0.0.0' ? '127.0.0.1' : doc.request.bind;
        let container;
        try {
            container = await dockerService.containersFor(doc.installationId).container();
        } catch {
            container = null;
        }
        if (container && container.exists) {
            if (!container.running) return { owned: true, ready: false, code: NOT_READY, reason: 'CONTAINER_STOPPED' };
            if (container.health === 'starting') return { owned: true, ready: false, code: NOT_READY, reason: 'STARTING' };
            if (container.health === 'unhealthy') return { owned: true, ready: false, code: NOT_READY, reason: 'UNHEALTHY' };
        } else if (container && !container.exists) {
            return { owned: true, ready: false, code: NOT_READY, reason: 'CONTAINER_MISSING' };
        }
        const listening = await (deps().tcpProbe || tcpProbe)(doc.request.port, host);
        if (!listening) return { owned: true, ready: false, code: NOT_READY, reason: 'NOT_LISTENING' };
        return { owned: true, ready: true, code: null, reason: null };
    }

    async function waitReady({ timeoutMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS } = {}) {
        const deadline = Date.now() + timeoutMs;
        let last = await check();
        while (!last.ready && Date.now() < deadline) {
            await (deps().sleep || sleep)(pollMs);
            last = await check();
        }
        return last;
    }

    return { check, waitReady };
}

module.exports = { createReadiness, NOT_READY, DEFAULT_WAIT_MS, DEFAULT_POLL_MS, tcpProbe };
