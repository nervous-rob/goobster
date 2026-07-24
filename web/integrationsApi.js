/**
 * Webhook receivers for the developer integrations, mounted on the public
 * health server (like the Activity API) because GitHub and Cursor must be
 * able to reach them — typically via a cloudflared tunnel on a Pi.
 *
 * Each receiver is enabled only when its shared secret is configured, and
 * every delivery is HMAC-verified against the raw body before parsing.
 */

const crypto = require('node:crypto');
const express = require('express');
const integrationsConfig = require('../config/integrationsConfig');
const repoWatchService = require('../services/repoWatchService');

/**
 * Constant-time check of an HMAC-SHA256 signature header ("sha256=<hex>").
 * @returns {boolean}
 */
function verifySignature(secret, rawBody, signatureHeader) {
    if (!secret || !signatureHeader) return false;
    // Guard against an upstream body parser having consumed the raw body:
    // HMAC verification is only meaningful over the exact bytes on the wire.
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') return false;
    const provided = String(signatureHeader).replace(/^sha256=/i, '').trim();
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const providedBuffer = Buffer.from(provided, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (providedBuffer.length !== expectedBuffer.length || providedBuffer.length === 0) return false;
    return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/** True when at least one webhook receiver has a secret configured. */
function integrationsWebhooksEnabled() {
    return Boolean(integrationsConfig.github.webhookSecret || integrationsConfig.cursor.webhookSecret);
}

/**
 * Build the express app exposing POST /api/webhooks/github and
 * POST /api/webhooks/cursor. Receivers ACK fast (202) and process async.
 *
 * @param {{client: import('discord.js').Client, logger?: object}} params
 */
function createIntegrationsApp({ client, logger = console }) {
    const app = express();
    app.disable('x-powered-by');

    // Raw body is required for signature verification; parse JSON afterwards.
    const rawJson = express.raw({ type: () => true, limit: '1mb' });

    app.post('/api/webhooks/github', rawJson, (req, res) => {
        const secret = integrationsConfig.github.webhookSecret;
        if (!secret) {
            res.status(503).json({ error: 'GitHub webhook receiver is not configured.' });
            return;
        }
        if (!verifySignature(secret, req.body, req.headers['x-hub-signature-256'])) {
            logger.warn?.('Rejected GitHub webhook with a bad or missing signature.');
            res.status(401).json({ error: 'Invalid signature.' });
            return;
        }

        let payload;
        try {
            payload = JSON.parse(req.body.toString('utf8'));
        } catch {
            res.status(400).json({ error: 'Invalid JSON payload.' });
            return;
        }

        const event = String(req.headers['x-github-event'] || '');
        res.status(202).json({ ok: true });

        repoWatchService.handleEvent({ client, event, payload, logger }).catch(error => {
            logger.error?.('GitHub webhook processing failed:', error);
        });
    });

    app.post('/api/webhooks/cursor', rawJson, (req, res) => {
        const secret = integrationsConfig.cursor.webhookSecret;
        if (!secret) {
            res.status(503).json({ error: 'Cursor webhook receiver is not configured.' });
            return;
        }
        if (!verifySignature(secret, req.body, req.headers['x-webhook-signature'])) {
            logger.warn?.('Rejected Cursor webhook with a bad or missing signature.');
            res.status(401).json({ error: 'Invalid signature.' });
            return;
        }

        let payload;
        try {
            payload = JSON.parse(req.body.toString('utf8'));
        } catch {
            res.status(400).json({ error: 'Invalid JSON payload.' });
            return;
        }

        res.status(202).json({ ok: true });

        // The tracker is attached to the client once the bot is ready; the
        // poller remains the safety net if a delivery arrives before that.
        const tracker = client.agentTrackerService;
        if (payload.event === 'statusChange' && payload.id && tracker) {
            tracker.applyUpdate({
                agentId: payload.id,
                status: payload.status,
                summary: payload.summary || null,
                prUrl: payload.target?.prUrl || null,
                branch: payload.target?.branchName || null
            }).catch(error => {
                logger.error?.('Cursor webhook processing failed:', error);
            });
        }
    });

    return app;
}

module.exports = { createIntegrationsApp, integrationsWebhooksEnabled, verifySignature };
