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
const incidents = require('../../services/assistantIncidentService');
const lifecycle = require('../../services/assistantProcessLifecycleService');
const gates = require('../../services/assistantGateService');
const control = require('../../services/assistantControlService');
const access = require('../../services/assistantAccessService');
const knowledgeChanges = require('../../services/knowledgeChangeSetService');
const knowledgeImpact = require('../../services/knowledgeImpactService');
const knowledgeGraph = require('../../services/knowledgeGraphService');
const { dmScopeId } = require('../../utils/dmScope');
const connectors = require('../../services/assistantConnectorService');

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

    // What delegating would do with the wider sources this responsibility names:
    // the cutoff, the history it will not act on, and today's proposal counts.
    app.get(`${base}/:id/sources`, requireAuth, route(async (req) => initiatives.sourcesOverview({
        userId: req.webUser.userId, id: req.params.id
    })));

    // What the host's policy means for this person: whether delegated work
    // is stopped, the budget a responsibility gets when it sets none (also
    // the most it can set), and which pilot capabilities they have.
    app.get('/api/app/assistant/access', requireAuth, route(async (req) => ({
        hostPaused: await control.isPaused(),
        budgetDefaults: await control.budgetDefaults(),
        ...(await access.describe(req.webUser.userId))
    })));

    // --- Outside connectors (DA-11d, ADR 0028) ------------------------------
    // The installed connectors as this person sees them: the manifest (what
    // each reads and writes, the owner's recorded decision) and whether their
    // own credential is connected. Empty unless the pilot gives them `reach`.
    // No token is ever returned.
    app.get('/api/app/assistant/connectors', requireAuth, route(async (req) => connectors.list(req.webUser.userId)));

    // Take a connector back: deletes this person's credential for it, so work
    // holding a grant on it is refused at its next call. Anyone may revoke
    // their own; it never needs the pilot.
    app.post('/api/app/assistant/connectors/:id/revoke', requireAuth, route(async (req) => connectors.revoke({
        userId: req.webUser.userId, connectorId: String(req.params.id)
    })));

    // --- Initiatives (attempts derived from linked sources) ----------------
    const initiativeBase = '/api/app/assistant/initiatives';
    // Each initiative carries `run` (or null): its execution summary. One
    // that came from a request in a conversation carries `origin` as the
    // viewer may see it now: the conversation, an excerpt of what they
    // asked and the link back, or `available: false`.
    const withOrigins = async (userId, list) => {
        const origins = await require('../../services/assistant/originRuns').origins({ userId, initiatives: list });
        return list.map(item => ({ ...item, origin: origins.get(item.id) || null }));
    };
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
        const described = await withOrigins(req.webUser.userId, listed.initiatives);
        return { initiatives: described.map(item => ({ ...item, run: runs.get(item.id) || null })) };
    }));

    // `run` is the execution record, when the runner has picked it up: what
    // it spent, what it concluded and which tools it called (not their output).
    app.get(`${initiativeBase}/:id`, requireAuth, route(async (req) => ({
        initiative: (await withOrigins(req.webUser.userId, [await initiatives.get({ userId: req.webUser.userId, id: req.params.id })]))[0],
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

    // --- Deciding a request where it is shown -------------------------------
    // { option, occurrence, revision, surface: home | inbox | chat | project | processes }
    // `:ref` is an update id, or `inbox-<item id>` for a request that lives
    // on its own Inbox item (a friend request, a request to join). The card
    // on Home, in the Inbox and in chat all post here; the owning domain
    // service decides. A settled, reopened or changed request answers 409
    // STALE_GATE with the current card in `details.current`.
    app.post('/api/app/assistant/gates/:ref/decide', requireAuth, route(async (req) => gates.decide({
        userId: req.webUser.userId,
        userName: req.webUser.userName || null,
        ref: req.params.ref,
        option: req.body?.option,
        occurrence: req.body?.occurrence,
        revision: req.body?.revision,
        surface: req.body?.surface,
        gateway: ctx.gateway
    })));


    // --- Delegated knowledge work (DA-11b, ADR 0027) -------------------------
    // What runs proposed, changed and archived in the person's own notes, and
    // the ways to undo it. Reading, reverting and restoring are the person's
    // own notes and are never behind the pilot gate: a change a run already
    // made must stay reversible even after the pilot closes. Applying or
    // dismissing a proposal is a gate decision (/gates/:ref/decide).
    const knowledgeBase = '/api/app/assistant/knowledge';
    const failed = (result, labels) => {
        const known = labels[result.code];
        const status = result.code === 'NOT_FOUND' ? 404 : 409;
        return Object.assign(new Error(known || 'That could not be done.'), { status, code: result.code });
    };

    app.get(knowledgeBase, requireAuth, route(async (req) => knowledgeChanges.overview({
        guildId: dmScopeId(req.webUser.userId), userId: req.webUser.userId, limit: req.query.limit
    })));

    app.post(`${knowledgeBase}/changes/:id/revert`, requireAuth, route(async (req) => knowledgeChanges.revert({
        id: req.params.id, userId: req.webUser.userId
    })));

    app.post(`${knowledgeBase}/notes/:id/restore`, requireAuth, route(async (req) => {
        const result = await knowledgeGraph.restoreNote({
            guildId: dmScopeId(req.webUser.userId), userId: req.webUser.userId, nodeId: req.params.id
        });
        if (!result.ok) {
            throw failed(result, {
                NOT_FOUND: 'No such note.',
                NOT_ARCHIVED: 'That note is not archived.',
                CAPACITY: 'Your notes are full. Archive or delete one first, then restore this one.'
            });
        }
        return result;
    }));

    app.post(`${knowledgeBase}/connections/:id/restore`, requireAuth, route(async (req) => {
        const result = await knowledgeGraph.restoreEdge({
            guildId: dmScopeId(req.webUser.userId), userId: req.webUser.userId, edgeId: req.params.id
        });
        if (!result.ok) {
            throw failed(result, { NOT_FOUND: 'No such connection.', NOT_RETRACTED: 'That connection is not retracted.' });
        }
        return result;
    }));

    // { sourceKind, sourceId, reason? }: a source was withdrawn. Files one
    // review of the notes and open project assumptions that rest on it;
    // deletes nothing. Behind the pilot gate (capability `reach`).
    app.post(`${knowledgeBase}/retractions`, requireAuth, route(async (req) => {
        if (!(await access.allows(req.webUser.userId, 'reach'))) {
            throw Object.assign(new Error('This is still in the owner-only pilot.'), { status: 403, code: access.REFUSAL_CODE });
        }
        return knowledgeImpact.reviewRetraction({
            userId: req.webUser.userId,
            guildId: dmScopeId(req.webUser.userId),
            sourceKind: String(req.body?.sourceKind || ''),
            sourceId: req.body?.sourceId,
            reason: req.body?.reason
        });
    }));

    // --- Process catalog (read model, contracts, lifecycle) ------------------
    // Reads: each process with how it is doing, what stewardship has done
    // with it and what the person may do next, and the incidents still open.
    const processBase = '/api/app/assistant/processes';
    app.get(processBase, requireAuth, route(async (req) => ({
        ...(await processes.list({ userId: req.webUser.userId })),
        ...(await incidents.list({ userId: req.webUser.userId }))
    })));

    app.get(`${processBase}/:kind/:id`, requireAuth, route(async (req) => processes.get({
        userId: req.webUser.userId, kind: req.params.kind, id: req.params.id, limit: req.query.limit
    })));

    // { purpose?, expectedCadenceSeconds?, freshnessSeconds?, quietResultOk?, criticality?,
    //   attentionItemId?, projectId?, reviewAt?, stopCondition?, dependsOn?: ["<kind>:<id>"],
    //   expectedRevision (to replace) }
    app.put(`${processBase}/:kind/:id/contract`, requireAuth, route(async (req) => processes.putContract({
        userId: req.webUser.userId, kind: req.params.kind, id: req.params.id, body: req.body
    })));

    app.delete(`${processBase}/:kind/:id/contract`, requireAuth, route(async (req) => processes.deleteContract({
        userId: req.webUser.userId, kind: req.params.kind, id: req.params.id
    })));

    // { action: pause | resume | archive | restore | keep | preview_cleanup | cleanup,
    //   expectedRevision? (the lifecycle revision shown; 0 when there is none),
    //   cleanupId?, manifestHash? (cleanup: the manifest that was previewed) }
    // The person acting on their own process. Nothing here deletes a
    // definition; `cleanup` removes only the rows its previewed manifest names.
    app.post(`${processBase}/:kind/:id/actions`, requireAuth, route(async (req) => lifecycle.act({
        userId: req.webUser.userId,
        kind: req.params.kind,
        id: req.params.id,
        action: String(req.body?.action || ''),
        expectedRevision: req.body?.expectedRevision,
        cleanupId: req.body?.cleanupId ?? null,
        manifestHash: req.body?.manifestHash ?? null
    })));
}

module.exports = { mountAssistant };
