/**
 * Portal routes for MCP access tokens.
 * Mounted by packages/core/web/appApi.js - do not require this file from apps.
 *
 * Creating and revoking a token is the signed-in person's own account
 * action. The plaintext secret is returned once from POST and is never
 * logged. The HTTP MCP endpoint is a separate opt-in (`mcp.enabled`);
 * these routes stay available so a token can be ready before that switch.
 */

const mcpConfig = require('../../config/mcpConfig');
const mcpTokenService = require('../../services/mcpTokenService');
const { describeServer } = require('../../mcp/tools');

function mountMcp(app, ctx, h) {
    const { requireAuth, mcpRoute } = h;

    app.get('/api/app/mcp', requireAuth, mcpRoute(async (req) => ({
        ...describeServer(),
        enabled: mcpConfig.enabled,
        tokens: await mcpTokenService.list({ userId: req.webUser.userId })
    })));

    app.post('/api/app/mcp/tokens', requireAuth, mcpRoute(async (req) => (
        mcpTokenService.create({ userId: req.webUser.userId, label: req.body?.label })
    )));

    app.delete('/api/app/mcp/tokens/:id', requireAuth, mcpRoute(async (req) => (
        mcpTokenService.revoke({ userId: req.webUser.userId, id: req.params.id })
    )));
}

module.exports = { mountMcp };
