/**
 * Streamable-HTTP MCP endpoint (stateless).
 *
 * One POST carries one JSON-RPC message and the response is a single
 * JSON object (or one SSE event when the client accepts only
 * `text/event-stream`). There is no session id: each request presents
 * its bearer token. GET and DELETE are refused because the server does
 * not push messages.
 *
 * Mount with `app.use('/mcp', createMcpApp())` only when mcp.enabled
 * is true, so a disabled server is an ordinary 404.
 */

const express = require('express');
const mcpConfig = require('../config/mcpConfig');
const mcpTokenService = require('../services/mcpTokenService');
const { consume } = require('./rateLimit');
const { handleMessage, rpcError } = require('./protocol');
const { surfaceFor } = require('./surface');
const { version } = require('../package.json');

const SERVER_INFO = { name: 'goobster', version };

function bearerToken(req) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match ? match[1] : null;
}

function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    let originHost;
    try {
        originHost = new URL(origin).host;
    } catch {
        return false;
    }
    return originHost === req.headers.host;
}

function protocolVersionAllowed(req) {
    const header = req.headers['mcp-protocol-version'];
    if (!header) return true;
    const { SUPPORTED_PROTOCOL_VERSIONS } = require('./protocol');
    return SUPPORTED_PROTOCOL_VERSIONS.includes(String(header));
}

function wantsEventStream(req) {
    const accept = String(req.headers.accept || '');
    if (!accept.trim()) return false;
    const types = accept.split(',').map(part => part.split(';')[0].trim().toLowerCase());
    const json = types.some(type => type === 'application/json' || type === '*/*');
    const stream = types.some(type => type === 'text/event-stream');
    return stream && !json;
}

function sendOutcome(req, res, outcome) {
    res.set('Cache-Control', 'no-store');
    if (outcome.kind === 'accept') {
        res.status(202).end();
        return;
    }
    const status = outcome.status || 200;
    if (wantsEventStream(req)) {
        res.status(status);
        res.set('Content-Type', 'text/event-stream');
        res.send(`event: message\ndata: ${JSON.stringify(outcome.body)}\n\n`);
        return;
    }
    res.status(status).json(outcome.body);
}

function createMcpApp({ logger = console } = {}) {
    const router = express.Router();
    router.use(express.json({ limit: '256kb', strict: true }));
    router.use((error, req, res, next) => {
        if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
            res.status(400).json(rpcError(null, -32700, 'Parse error'));
            return;
        }
        next(error);
    });

    const refuse = (req, res) => {
        res.set('Allow', 'POST');
        res.status(405).json(rpcError(null, -32601, 'Method not allowed'));
    };
    router.get('/', refuse);
    router.delete('/', refuse);

    router.post('/', async (req, res) => {
        if (!originAllowed(req)) {
            sendOutcome(req, res, {
                kind: 'response',
                status: 403,
                body: rpcError(req.body?.id ?? null, -32000, 'Cross-origin requests are not allowed.')
            });
            return;
        }
        if (!protocolVersionAllowed(req)) {
            sendOutcome(req, res, {
                kind: 'response',
                status: 400,
                body: rpcError(req.body?.id ?? null, -32600, 'Unsupported MCP-Protocol-Version.')
            });
            return;
        }
        const auth = await mcpTokenService.resolve(bearerToken(req));
        if (auth.status !== 'ok') {
            const expired = auth.status === 'expired';
            res.set('WWW-Authenticate', expired
                ? 'Bearer realm="goobster", error="invalid_token", error_description="The token expired"'
                : 'Bearer realm="goobster"');
            sendOutcome(req, res, {
                kind: 'response',
                status: 401,
                body: rpcError(req.body?.id ?? null, -32001, expired
                    ? 'This MCP token has expired. Create a new one in Settings \u2192 Connections.'
                    : 'Unauthorized')
            });
            return;
        }
        const { session } = auth;
        if (!consume(`mcp:${session.id}`, mcpConfig.requestsPerMinute)) {
            sendOutcome(req, res, {
                kind: 'response',
                status: 429,
                body: rpcError(req.body?.id ?? null, -32000, 'Too many MCP requests. Wait a minute and try again.')
            });
            return;
        }
        try {
            const outcome = await handleMessage(req.body, {
                serverInfo: SERVER_INFO,
                ...surfaceFor(session)
            });
            const method = req.body?.method;
            const toolName = method === 'tools/call' ? req.body?.params?.name : '';
            logger.debug?.(`MCP ${method || 'request'}${toolName ? ` ${toolName}` : ''}`);
            sendOutcome(req, res, outcome);
        } catch (error) {
            logger.error?.(`MCP request failed: ${error?.message || error}`);
            sendOutcome(req, res, {
                kind: 'response',
                status: 500,
                body: rpcError(req.body?.id ?? null, -32603, 'Internal error')
            });
        }
    });

    return router;
}

/**
 * Mount `/mcp` when the feature is enabled. Returns whether it mounted.
 * Both the bot and the api process call this so the two profiles agree.
 */
function mountMcpIfEnabled(app, { logger = console } = {}) {
    if (!mcpConfig.enabled) return false;
    app.use(mcpConfig.path, createMcpApp({ logger }));
    logger.info?.(`MCP server enabled at ${mcpConfig.path} (read-only)`);
    return true;
}

module.exports = { createMcpApp, mountMcpIfEnabled, SERVER_INFO };
