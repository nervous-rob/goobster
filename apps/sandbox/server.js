/**
 * Sandbox-runner HTTP layer (Phase 5d). bot and api POST here instead of
 * executing snippets in-process, so only this container needs
 * security_opt: [seccomp:unconfined] for bubblewrap.
 *
 * Exported as a builder so tests can construct the app without listening.
 */

const crypto = require('node:crypto');
const express = require('express');
const sandboxService = require('@goobster/core/services/sandboxService');

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
 * @returns {import('express').Express}
 */
function createSandboxApp({ sandbox = sandboxService, logger = console } = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '2mb' }));

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
        try {
            const result = await sandbox.run({
                language: req.body?.language,
                code: req.body?.code,
                stdin: req.body?.stdin || '',
                userId: req.body?.userId || null,
                projectDir: req.body?.projectDir || null,
                runDir: req.body?.runDir || null
            });
            res.json(result);
        } catch (error) {
            if (error?.status && error?.code) {
                res.status(error.status).json({
                    error: { status: error.status, code: error.code, message: error.message }
                });
                return;
            }
            logger.error?.('[sandbox-runner] run failed:', error.message);
            res.status(500).json({ error: { code: 'INTERNAL', message: 'Sandbox run failed.' } });
        }
    });

    return app;
}

module.exports = { createSandboxApp, DEFAULT_SANDBOX_PORT };
