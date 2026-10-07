/**
 * Sandbox-runner HTTP layer (Phase 5d). bot and api POST here instead of
 * executing snippets in-process, so only this container needs
 * security_opt: [seccomp:unconfined] for bubblewrap.
 *
 * Exported as a builder so tests can construct the app without listening.
 *
 * Restart contract `cancel` (documentation/manager_lifecycle.md): once
 * this process stops new work, /run answers 503 RESTARTING; the runs
 * already going keep their own timeout inside the bound, and any still
 * going then are aborted and answered 503 INTERRUPTED, so the submitting
 * process notes them and nothing is replayed.
 */

const crypto = require('node:crypto');
const express = require('express');
const sandboxService = require('@goobster/core/services/sandboxService');
const lifecycle = require('@goobster/core/runtime/lifecycle');
const maintenance = require('@goobster/core/runtime/maintenance');

const TOKEN_HEADER = 'x-goobster-internal-token';
const DEFAULT_SANDBOX_PORT = 3200;

function tokenMatches(presented, expected) {
    if (typeof presented !== 'string' || !presented || !expected) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * @param {Object} [params]
 * @param {Object} [params.sandbox] - sandboxService-shaped override
 * @param {Object} [params.logger]
 * @param {Object} [params.worker] - the process lifecycle (newWorkPaused)
 * @returns {import('express').Express & { drainRuns: Function }}
 */
function createSandboxApp({ sandbox = sandboxService, logger = console, worker = lifecycle } = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2mb' }));

    const inflight = new Map();
    const canceledUntil = new Map();
    const CANCELED_TTL_MS = 60_000;

    function pruneCanceled(now = Date.now()) {
        for (const [id, exp] of canceledUntil) {
            if (exp <= now) canceledUntil.delete(id);
        }
    }

    function rememberCanceled(runId) {
        canceledUntil.set(runId, Date.now() + CANCELED_TTL_MS);
        if (canceledUntil.size > 256) pruneCanceled();
    }

    function consumeCanceled(runId) {
        const exp = canceledUntil.get(runId);
        if (exp == null) return false;
        canceledUntil.delete(runId);
        return exp > Date.now();
    }

    function abortRun(runId) {
        rememberCanceled(runId);
        const entry = inflight.get(runId);
        if (!entry) return false;
        entry.controller.abort();
        return true;
    }

    app.get('/health', (_req, res) => {
        res.json({
            status: 'healthy',
            service: 'sandbox',
            enabled: Boolean(sandbox.enabled),
            timestamp: new Date().toISOString()
        });
    });

    app.post('/run', async (req, res) => {
        if (!tokenMatches(req.headers[TOKEN_HEADER], process.env.GOOBSTER_INTERNAL_TOKEN)) {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or bad internal token.' } });
            return;
        }
        if (maintenance.isActive()) {
            res.set('Retry-After', String(maintenance.RETRY_AFTER_SECONDS));
            res.status(503).json({ error: { status: 503, code: 'MAINTENANCE', message: 'The sandbox runner is in maintenance; run the code again in a few minutes.' } });
            return;
        }
        if (worker.newWorkPaused()) {
            res.status(503).json({ error: { status: 503, code: 'RESTARTING', message: 'The sandbox runner is restarting; run the code again in a minute.' } });
            return;
        }
        const runId = typeof req.body?.runId === 'string' && req.body.runId.trim()
            ? req.body.runId.trim().slice(0, 128)
            : crypto.randomUUID();
        if (consumeCanceled(runId)) {
            res.status(200).json({
                ok: false, aborted: true, runId,
                stdout: '', stderr: '', exitCode: null, timedOut: false, files: []
            });
            return;
        }
        const controller = new AbortController();
        let settled;
        const entry = { controller, interrupted: false, done: new Promise((resolve) => { settled = resolve; }) };
        inflight.set(runId, entry);
        const onClose = () => {
            if (!res.writableEnded) controller.abort();
        };
        // IncomingMessage `close` fires after the body is consumed.
        // The response `close` is the client-disconnect signal.
        res.on('close', onClose);
        try {
            const result = await sandbox.run({
                language: req.body?.language,
                code: req.body?.code,
                stdin: req.body?.stdin || '',
                userId: req.body?.userId || null,
                projectDir: req.body?.projectDir || null,
                runDir: req.body?.runDir || null,
                signal: controller.signal,
                // The submitting process records the ledger rows: it knows
                // which piece of work this run belongs to.
                record: false
            });
            if (!res.headersSent) res.json({ ...result, runId });
        } catch (error) {
            if (entry.interrupted) {
                if (!res.headersSent) {
                    res.status(503).json({ error: { status: 503, code: 'INTERRUPTED', message: 'The sandbox runner restarted before the run finished.' } });
                }
                return;
            }
            if (error?.code === 'ABORTED' || controller.signal.aborted) {
                if (!res.headersSent) {
                    res.status(200).json({
                        ok: false, aborted: true, runId,
                        stdout: '', stderr: '', exitCode: null, timedOut: false, files: []
                    });
                }
                return;
            }
            if (error?.status && error?.code) {
                res.status(error.status).json({
                    error: { status: error.status, code: error.code, message: error.message }
                });
                return;
            }
            logger.error?.('[sandbox-runner] run failed:', error.message);
            res.status(500).json({ error: { code: 'INTERNAL', message: 'Sandbox run failed.' } });
        } finally {
            res.off('close', onClose);
            inflight.delete(runId);
            settled();
        }
    });

    app.post('/cancel', (req, res) => {
        if (!tokenMatches(req.headers[TOKEN_HEADER], process.env.GOOBSTER_INTERNAL_TOKEN)) {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or bad internal token.' } });
            return;
        }
        const runId = typeof req.body?.runId === 'string' ? req.body.runId.trim() : '';
        if (!runId) {
            res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'runId is required.' } });
            return;
        }
        res.json({ ok: true, found: abortRun(runId) });
    });

    /**
     * Wait at most `boundMs` for the runs in flight, then cut the rest
     * (INTERRUPTED). Resolves with how many were cut.
     */
    app.drainRuns = async (boundMs) => {
        const [result] = await lifecycle.settle([{
            name: 'sandboxRun',
            drain: () => Promise.all([...inflight.values()].map(item => item.done))
        }], boundMs);
        if (result.outcome === 'settled') return 0;
        const cut = [...inflight.values()];
        for (const item of cut) {
            item.interrupted = true;
            item.controller.abort();
        }
        await Promise.allSettled(cut.map(item => item.done));
        return cut.length;
    };

    return app;
}

/**
 * Listen, acknowledge the revision this start runs, and own the shutdown:
 * stop new work, drain inside the sandboxRun bound, close, exit.
 * @returns {{ app: Object, server: import('node:http').Server, shutdown: Function }}
 */
function startSandboxRunner({
    port = Number(process.env.GOOBSTER_SANDBOX_PORT) || DEFAULT_SANDBOX_PORT,
    logger = console,
    sandbox = sandboxService,
    worker = lifecycle,
    proc = process,
    exit = code => process.exit(code)
} = {}) {
    worker.boot({ worker: 'sandbox', log: logger });
    const app = createSandboxApp({ sandbox, logger, worker });
    const server = app.listen(port, () => {
        logger.info?.(`Goobster sandbox-runner listening on port ${port}`);
        worker.acknowledgeReady();
    });
    worker.onPauseNewWork(() => sandbox.pauseNewWork?.());
    // Maintenance barrier: admission is closed (503 MAINTENANCE) before this
    // runs; the runs in flight keep their own timeout inside the bound.
    worker.onMaintenance?.({
        name: 'sandbox',
        drain: ({ boundMs }) => app.drainRuns(lifecycle.contractBoundMs('sandboxRun', boundMs))
    });

    let shuttingDown = null;
    const runShutdown = async (exitCode) => {
        worker.pauseNewWork({ reason: 'shutdown' });
        try {
            const cut = await app.drainRuns(lifecycle.contractBoundMs('sandboxRun', worker.drainBoundMs()));
            if (cut > 0) logger.warn?.(`[sandbox-runner] shutdown bound reached; ${cut} run(s) interrupted`);
        } catch (error) {
            logger.error?.('[sandbox-runner] drain failed:', error?.message || error);
        }
        await new Promise((resolve) => {
            server.close(resolve);
            server.closeIdleConnections?.();
        });
        exit(exitCode);
    };
    const shutdown = ({ exitCode = 0 } = {}) => {
        if (!shuttingDown) shuttingDown = runShutdown(exitCode);
        return shuttingDown;
    };
    proc.on('SIGINT', () => shutdown({ exitCode: 0 }));
    proc.on('SIGTERM', () => shutdown({ exitCode: 0 }));
    worker.install({ shutdown, proc });
    return { app, server, shutdown };
}

module.exports = { createSandboxApp, startSandboxRunner, DEFAULT_SANDBOX_PORT };
