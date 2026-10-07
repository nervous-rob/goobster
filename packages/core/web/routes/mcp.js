/**
 * Portal routes for MCP access tokens.
 * Mounted by packages/core/web/appApi.js - do not require this file from apps.
 *
 * Creating and revoking a token is the signed-in person's own account
 * action. The plaintext secret is returned once from POST and is never
 * logged. The HTTP MCP endpoint is a separate opt-in (the `mcp` feature:
 * `mcp.enabled` or the feature state file); `enabled` in the GET answer is
 * the same value the endpoint serves by. These routes stay available so a
 * token can be ready (or revoked) while it is off.
 */

const mcpConfig = require('../../config/mcpConfig');
const mcpTokenService = require('../../services/mcpTokenService');
const requireOptional = require('../../utils/optionalModule').forModule(module);

/** The endpoint's own description, or the same shape off when the MCP server is not installed. */
function describeServer() {
    const tools = requireOptional('../../mcp/tools', { feature: 'mcp' });
    if (tools) return tools.describeServer();
    return { enabled: false, endpoint: mcpConfig.path, readOnly: true, tools: [], resources: true, installed: false };
}

function mountMcp(app, ctx, h) {
    const { requireAuth, mcpRoute } = h;

    app.get('/api/app/mcp', requireAuth, mcpRoute(async (req) => ({
        ...describeServer(),
        scopes: Object.values(mcpTokenService.SCOPES),
        defaultExpiryDays: mcpConfig.defaultTokenDays,
        maxExpiryDays: mcpConfig.maxTokenDays,
        tokens: await mcpTokenService.list({ userId: req.webUser.userId })
    })));

    app.post('/api/app/mcp/tokens', requireAuth, mcpRoute(async (req) => (
        mcpTokenService.create({
            userId: req.webUser.userId,
            label: req.body?.label,
            scope: req.body?.scope,
            expiresInDays: req.body?.expiresInDays
        })
    )));

    app.delete('/api/app/mcp/tokens/:id', requireAuth, mcpRoute(async (req) => (
        mcpTokenService.revoke({ userId: req.webUser.userId, id: req.params.id })
    )));
}

module.exports = { mountMcp };
