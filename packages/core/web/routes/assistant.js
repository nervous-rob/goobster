/**
 * Portal routes: delegated responsibilities (DA-1a, ADR 0016), their
 * initiatives, canonical updates and the process catalog (DA-1b/c/d,
 * ADR 0017). Mounted by
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
const initiatives = require('../../services/assistantInitiativeService');
const updates = require('../../services/assistantUpdateService');
const processes = require('../../services/assistantProcessService');

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

    // --- Initiatives (attempts derived from linked sources) ----------------
    const initiativeBase = '/api/app/assistant/initiatives';
    // Each initiative carries `run` (or null): its execution summary.
    app.get(initiativeBase, requireAuth, route(async (req) => {
        const listed = await initiatives.list({
            userId: req.webUser.userId,
            responsibilityId: req.query.responsibilityId ? Number(req.query.responsibilityId) : null,
            status: req.query.status ? String(req.query.status) : null,
            limit: req.query.limit
        });
        const runs = await require('../../services/assistantRunService').summaries({
            userId: req.webUser.userId, initiativeIds: listed.initiatives.map(item => item.id)
        });
        return { initiatives: listed.initiatives.map(item => ({ ...item, run: runs.get(item.id) || null })) };
    }));

    // `run` is the execution record, when the runner has picked it up: what
    // it spent, what it concluded and which tools it called (not their output).
    app.get(`${initiativeBase}/:id`, requireAuth, route(async (req) => ({
        initiative: await initiatives.get({ userId: req.webUser.userId, id: req.params.id }),
        run: await require('../../services/assistantRunService').forInitiative({ userId: req.webUser.userId, initiativeId: req.params.id })
    })));

    // { action: queue | cancel | retry | accept | reject, expectedRevision }
    app.post(`${initiativeBase}/:id/actions`, requireAuth, route(async (req) => initiatives.act({
        userId: req.webUser.userId,
        id: req.params.id,
        action: String(req.body?.action || ''),
        expectedRevision: req.body?.expectedRevision
    })));

    // --- Canonical updates ---------------------------------------------------
    // A read: it never acknowledges, delivers or resolves anything.
    app.get('/api/app/assistant/updates', requireAuth, route(async (req) => updates.list({
        userId: req.webUser.userId,
        component: req.query.component ? String(req.query.component) : null,
        responsibilityId: req.query.responsibilityId || null,
        cursor: req.query.cursor ? String(req.query.cursor) : null,
        limit: req.query.limit
    })));

    // { items: [{ id, revision }] } - exact revisions, idempotent.
    app.post('/api/app/assistant/updates/acknowledge', requireAuth, route(async (req) => updates.acknowledge({
        userId: req.webUser.userId,
        items: req.body?.items
    })));

    // { until } - hide an open gate from Needs you; it stays open.
    app.post('/api/app/assistant/updates/:id/snooze', requireAuth, route(async (req) => ({
        snoozed: await updates.snooze({ userId: req.webUser.userId, id: req.params.id, until: req.body?.until })
    })));

    // --- Process catalog (read model + contracts) ---------------------------
    const processBase = '/api/app/assistant/processes';
    app.get(processBase, requireAuth, route(async (req) => processes.list({ userId: req.webUser.userId })));

    app.get(`${processBase}/:kind/:id`, requireAuth, route(async (req) => processes.get({
        userId: req.webUser.userId, kind: req.params.kind, id: req.params.id, limit: req.query.limit
    })));

    // { purpose?, expectedCadenceSeconds?, freshnessSeconds?, quietResultOk?, criticality?,
    //   attentionItemId?, projectId?, reviewAt?, stopCondition?, expectedRevision (to replace) }
    app.put(`${processBase}/:kind/:id/contract`, requireAuth, route(async (req) => processes.putContract({
        userId: req.webUser.userId, kind: req.params.kind, id: req.params.id, body: req.body
    })));

    app.delete(`${processBase}/:kind/:id/contract`, requireAuth, route(async (req) => processes.deleteContract({
        userId: req.webUser.userId, kind: req.params.kind, id: req.params.id
    })));
}

module.exports = { mountAssistant };
