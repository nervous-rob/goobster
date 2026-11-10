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
 * Activating or resuming a responsibility, and deciding a request from a
 * chat card, also carry a human confirmation receipt minted here for the
 * session's person (ADR 0023): a model tool call has no session and cannot
 * mint one.
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
const confirmations = require('../../services/assistantConfirmationService');
const control = require('../../services/assistantControlService');
const access = require('../../services/assistantAccessService');
const connectors = require('../../services/assistantConnectorService');
const { AssistantResponsibilityError } = responsibilities;

/** Actions that turn authority on: the route takes them only with a receipt. */
const CONFIRMED_ACTIONS = ['activate', 'resume'];
const confirmationRequired = (message) => new AssistantResponsibilityError('HUMAN_CONFIRMATION_REQUIRED', message, 403);

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
    //   attentionItemId?, projectId?, planId? }
    // Idempotency-Key (header) or idempotencyKey (body) replays a retried create.
    // Always a draft: activation is a separate, confirmed action on what the
    // draft was normalized to (`activate: true` is refused).
    app.post(base, requireAuth, route(async (req) => {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const { activate, ...fields } = body;
        if (activate !== undefined && activate !== false && activate !== null) {
            throw confirmationRequired('A responsibility is created as a draft. Review it, then activate it with a confirmation.');
        }
        return responsibilities.create({
            userId: req.webUser.userId,
            body: fields,
            activate: false,
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

    // { action: activate | pause | resume | complete | revoke | archive, expectedRevision, receipt? }
    // activate and resume need `receipt`: the confirmation minted for this
    // person, this responsibility, this revision and the grant as shown
    // (POST /api/app/assistant/confirmations). It is spent by the action.
    app.post(`${base}/:id/actions`, requireAuth, route(async (req) => {
        const action = String(req.body?.action || '');
        const receipt = typeof req.body?.receipt === 'string' && req.body.receipt ? req.body.receipt : null;
        if (CONFIRMED_ACTIONS.includes(action) && !receipt) {
            throw confirmationRequired(`To ${action} a responsibility, confirm it: this needs the confirmation receipt for what you were shown.`);
        }
        return responsibilities.act({
            userId: req.webUser.userId,
            id: req.params.id,
            action,
            expectedRevision: req.body?.expectedRevision,
            receipt: CONFIRMED_ACTIONS.includes(action) ? receipt : null
        });
    }));

    // { action: keep | discard, expectedRevision } - the person's answer to a
    // draft proposed in a conversation, other than turning it on. `keep`
    // leaves it in Responsibilities as a draft; `discard` deletes it and its
    // history (only a proposal that never ran).
    app.post(`${base}/:id/proposal`, requireAuth, route(async (req) => {
        const action = String(req.body?.action || '');
        const params = { userId: req.webUser.userId, id: req.params.id, expectedRevision: req.body?.expectedRevision };
        if (action === 'keep') return responsibilities.keepProposal(params);
        if (action === 'discard') return responsibilities.discardProposal(params);
        throw new AssistantResponsibilityError('INVALID_ACTION', 'action must be keep or discard.', 400);
    }));

    // --- Human confirmation receipts (ADR 0023) -----------------------------
    // { subject: responsibility, id, action: activate | resume, revision, surface: portal | chat }
    // { subject: gate, id: <gate ref>, action: decide, occurrence, revision, surface: chat }
    // Minted for the session's person when a confirmation is rendered to
    // them. Answers { receipt, expiresAt, surface, shown }: `shown` is what
    // the receipt is bound to, and what the confirmation displays. Single
    // use, 15 minutes; a stale revision answers 409.
    app.post('/api/app/assistant/confirmations', requireAuth, route(async (req) => confirmations.mint({
        userId: req.webUser.userId,
        subject: String(req.body?.subject || ''),
        id: req.body?.id,
        action: String(req.body?.action || ''),
        revision: req.body?.revision,
        occurrence: req.body?.occurrence,
        surface: String(req.body?.surface || '')
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
    // The current decision card for a gate reference, as this person: what a
    // chat card renders. A read; 404 when there is none they may act on.
    app.get('/api/app/assistant/gates/:ref', requireAuth, route(async (req) => {
        const card = await gates.card({ userId: req.webUser.userId, ref: req.params.ref });
        if (!card) throw new gates.AssistantGateError(404, 'NOT_FOUND', 'No such request.');
        return { card };
    }));

    // { option, occurrence, revision, surface: home | inbox | chat, receipt? }
    // `chat` needs `receipt`: the confirmation minted when the chat card was
    // rendered to this person, spent by the decision.
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
        receipt: typeof req.body?.receipt === 'string' && req.body.receipt ? req.body.receipt : null,
        gateway: ctx.gateway
    })));

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
