/**
 * Portal route: the installation's feature state, for the portal UI (#321).
 * Mounted by packages/core/web/appApi.js - do not require this file from apps.
 *
 * Core, signed-in only, never gated. It reports reason and warning codes
 * (no detail values, no state-file contents) so the client can hide what is
 * unavailable and say why without learning anything about the installation
 * a signed-in person could not already see.
 */

const { sanitizeStatus } = require('../featureGate');

function mountFeatures(app, ctx, h) {
    const { requireAuth } = h;

    app.get('/api/app/features', requireAuth, (req, res) => {
        res.json(sanitizeStatus(ctx.features.status()));
    });
}

module.exports = { mountFeatures };
