/**
 * The bot's internal gateway API: /internal/gateway/* (reactive port spec
 * §6). This is how the api service reaches Discord - membership checks,
 * mutual guilds, member search, DM delivery - without a gateway connection
 * of its own (RemoteGateway is the client).
 *
 * Security model, in layers:
 *  - The compose `full` profile keeps the bot on the internal network and
 *    nginx never proxies /internal/*, so the surface is unreachable from
 *    outside the deployment.
 *  - Every request must carry the GOOBSTER_INTERNAL_TOKEN shared secret in
 *    the x-goobster-internal-token header (constant-time compared);
 *    anything else is 401. The router is only mounted at all when the
 *    token is configured.
 *  - Responses are plain JSON snapshots produced by LocalGateway - never
 *    live discord.js objects.
 */

const crypto = require('node:crypto');
const express = require('express');
const { LocalGateway } = require('@goobster/core/gateway');

const TOKEN_HEADER = 'x-goobster-internal-token';
const MAX_LOOKUP_IDS = 100;

/** Whether the internal gateway should be exposed at all. */
function internalGatewayEnabled() {
    return Boolean(process.env.GOOBSTER_INTERNAL_TOKEN);
}

/** Constant-time token comparison (defense in depth on a private network). */
function tokenMatches(presented, expected) {
    if (typeof presented !== 'string' || !presented || !expected) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Build the internal gateway router around the live client.
 * @param {Object} params - { client, logger }
 */
function createInternalGatewayApi({ client, logger = console }) {
    const gateway = new LocalGateway(client);
    const router = express.Router();

    router.use('/internal/gateway', (req, res, next) => {
        if (!tokenMatches(req.headers[TOKEN_HEADER], process.env.GOOBSTER_INTERNAL_TOKEN)) {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or bad internal token.' } });
            return;
        }
        next();
    });
    router.use('/internal/gateway', express.json({ limit: '256kb' }));

    /** Route wrapper: bot-not-ready is 503, everything else a logged 500. */
    function gatewayRoute(handler) {
        return async (req, res) => {
            if (!client?.user) {
                res.status(503).json({ error: { code: 'GATEWAY_UNAVAILABLE', message: 'The bot is not connected to Discord yet.' } });
                return;
            }
            try {
                res.json(await handler(req));
            } catch (error) {
                logger.error?.('[internal-gateway] route failed:', error.message);
                res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal gateway error.' } });
            }
        };
    }

    // Health answers even before the client is ready, so RemoteGateway's
    // available() reflects the truth instead of a 503.
    router.get('/internal/gateway/health', (req, res) => {
        res.json({ ok: true, available: Boolean(client?.user) });
    });

    router.get('/internal/gateway/bot-user', gatewayRoute(async () => ({
        botUser: await gateway.botUser()
    })));

    router.get('/internal/gateway/guilds/:guildId', gatewayRoute(async (req) => ({
        guild: await gateway.guildMeta(req.params.guildId)
    })));

    router.get('/internal/gateway/guilds/:guildId/members/:userId', gatewayRoute(async (req) =>
        gateway.getGuildMember(req.params.guildId, req.params.userId)
    ));

    router.get('/internal/gateway/guilds/:guildId/members/:userId/has-permission', gatewayRoute(async (req) => ({
        hasPermission: await gateway.memberHasPermission(
            req.params.guildId, req.params.userId, String(req.query.permission || ''))
    })));

    router.post('/internal/gateway/guilds/:guildId/members/lookup', gatewayRoute(async (req) => {
        const userIds = Array.isArray(req.body?.userIds)
            ? req.body.userIds.map(String).slice(0, MAX_LOOKUP_IDS)
            : [];
        return { members: await gateway.getGuildMembers(req.params.guildId, userIds) };
    }));

    router.get('/internal/gateway/guilds/:guildId/member-search', gatewayRoute(async (req) => ({
        members: await gateway.searchGuildMembers(req.params.guildId, {
            query: req.query.q ? String(req.query.q) : null,
            limit: req.query.limit ? Number(req.query.limit) : undefined
        })
    })));

    router.get('/internal/gateway/users/:userId', gatewayRoute(async (req) => ({
        user: await gateway.getUser(req.params.userId)
    })));

    router.get('/internal/gateway/users/:userId/mutual-guilds', gatewayRoute(async (req) => ({
        guilds: await gateway.listMutualGuilds(req.params.userId)
    })));

    router.get('/internal/gateway/users/:userId/dm-channel', gatewayRoute(async (req) => ({
        channelId: await gateway.resolveDmChannelId(req.params.userId)
    })));

    router.post('/internal/gateway/users/:userId/dm', gatewayRoute(async (req) =>
        gateway.sendDm(req.params.userId, req.body?.payload ?? '')
    ));

    router.post('/internal/gateway/channels/:channelId/messages', gatewayRoute(async (req) =>
        gateway.sendToChannel(req.params.channelId, req.body?.payload ?? '')
    ));

    router.use('/internal/gateway', (req, res) => {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such internal gateway route.' } });
    });

    return router;
}

module.exports = { createInternalGatewayApi, internalGatewayEnabled };
