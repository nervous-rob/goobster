/**
 * Portal routes: delegated responsibilities (DA-1a, ADR 0016). Mounted by
 * packages/core/web/appApi.js as an optional route module of the
 * `assistant` feature - do not require this file from apps.
 *
 * Every route acts as the signed-in person: the owner, authorizer, actor
 * and payer of a responsibility come from the session, never the body.
 * Another person's id answers 404. Edits and lifecycle actions carry
 * `expectedRevision` and answer 409 REVISION_CONFLICT when it is stale.
 * The feature gate (inventory routeRules) refuses the whole prefix when the
 * feature is off.
 */

const responsibilities = require('../../services/assistantResponsibilityService');

function mountAssistant(app, ctx, h) {
    const { requireAuth, assistantRoute: route } = h;
    const base = '/api/app/assistant/responsibilities';

    app.get(base, requireAuth, route(async (req) => ({
        ...(await responsibilities.list({
            userId: req.webUser.userId,
            status: req.query.status ? String(req.query.status) : null,
            limit: req.query.limit
        })),
        vocabulary: responsibilities.vocabulary()
    })));

    // { title, outcome?, operations?, scopes?, budgets?, rules?, expiresAt?,
    //   attentionItemId?, projectId?, planId?, activate?: true }
    // Idempotency-Key (header) or idempotencyKey (body) replays a retried create.
    app.post(base, requireAuth, route(async (req) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const { activate, ...fields } = body;
        return responsibilities.create({
            userId: req.webUser.userId,
            body: fields,
            activate: activate === true,
            idempotencyKey: req.get('Idempotency-Key') || null
        });
    }));

    app.get(`${base}/:id`, requireAuth, route(async (req) => ({
        responsibility: await responsibilities.get({ userId: req.webUser.userId, id: req.params.id }),
        ...(await responsibilities.revisions({ userId: req.webUser.userId, id: req.params.id }))
    })));

    app.patch(`${base}/:id`, requireAuth, route(async (req) => {
        const { expectedRevision, ...fields } = req.body && typeof req.body === 'object' ? req.body : {};
        return responsibilities.update({
            userId: req.webUser.userId,
            id: req.params.id,
            expectedRevision,
            body: fields
        });
    }));

    // { action: activate | pause | resume | complete | revoke | archive, expectedRevision }
    app.post(`${base}/:id/actions`, requireAuth, route(async (req) => responsibilities.act({
        userId: req.webUser.userId,
        id: req.params.id,
        action: String(req.body?.action || ''),
        expectedRevision: req.body?.expectedRevision
    })));
}

module.exports = { mountAssistant };
