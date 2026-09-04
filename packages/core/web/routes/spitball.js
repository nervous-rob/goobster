/**
 * Portal routes: Spitball.
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */

const spitballLensConfig = require('../../config/spitballLensConfig');
const spitballConfig = require('../../config/spitballConfig');

function mountSpitball(app, ctx, h) {
    const { requireAuth, chatRoute, dashboardRoute } = h;


    app.get('/api/app/spitball/lenses', requireAuth, chatRoute(async () => ({
        lenses: spitballLensConfig.listLenses(),
        defaultLensId: spitballLensConfig.DEFAULT_LENS_ID,
        depths: spitballConfig.DEPTH_PRESETS,
        defaultDepth: spitballConfig.DEFAULT_DEPTH
    })));

    app.get('/api/app/spitball/expeditions', requireAuth, chatRoute(async (req) => ({
        expeditions: await ctx.spitball.listExpeditions({
            userId: req.webUser.userId,
            status: req.query.status || null,
            projectId: req.query.projectId || null
        })
    })));

    app.post('/api/app/spitball/expeditions', requireAuth, chatRoute(async (req) => {
        const expedition = await ctx.spitball.createExpedition({
            userId: req.webUser.userId,
            seed: req.body?.seed ?? req.body?.topic,
            lensId: req.body?.lensId ?? null,
            lensText: req.body?.lensText ?? null,
            intent: req.body?.intent ?? null,
            depth: req.body?.depth ?? undefined,
            projectId: req.body?.projectId ?? null
        });
        ctx.spitballRunner.kick(expedition.id);
        return expedition;
    }));

    // Everything the detail view renders in one shape: the expedition, its
    // cycles (with plan/coverage/leads), sources, and ranked Leads.
    app.get('/api/app/spitball/expeditions/:id', requireAuth, chatRoute(async (req) =>
        ctx.spitball.getExpeditionDetail(req.params.id, { userId: req.webUser.userId })
    ));

    app.get('/api/app/spitball/expeditions/:id/cycles', requireAuth, chatRoute(async (req) => ({
        cycles: await ctx.spitball.listCycles(req.params.id, { userId: req.webUser.userId })
    })));

    app.get('/api/app/spitball/expeditions/:id/sources', requireAuth, chatRoute(async (req) => ({
        sources: await ctx.spitball.listSources(req.params.id, { userId: req.webUser.userId })
    })));

    // The evidence layer: extracted claims (optionally per source)
    app.get('/api/app/spitball/expeditions/:id/claims', requireAuth, chatRoute(async (req) => ({
        claims: await ctx.spitball.listClaims(req.params.id, {
            userId: req.webUser.userId,
            sourceId: req.query.sourceId || null
        })
    })));

    // Personal notes: browse, create, edit, delete. Collection path is
    // registered before the evidence route so :nodeId never swallows "notes".
    app.get('/api/app/spitball/notes', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.listNotes({
            gateway: ctx.gateway,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId,
            q: req.query.q,
            type: req.query.type,
            tag: req.query.tag,
            source: req.query.source,
            limit: req.query.limit,
            offset: req.query.offset
        })
    ));

    app.post('/api/app/spitball/notes', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.createNote({
            gateway: ctx.gateway,
            scope: String(req.body?.scope || ''),
            userId: req.webUser.userId,
            label: req.body?.label,
            content: req.body?.content,
            type: req.body?.type,
            tags: req.body?.tags
        })
    ));

    app.patch('/api/app/spitball/notes/:nodeId', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.updateNote({
            gateway: ctx.gateway,
            scope: String(req.body?.scope || req.query.scope || ''),
            userId: req.webUser.userId,
            nodeId: req.params.nodeId,
            label: req.body?.label,
            content: req.body?.content,
            type: req.body?.type,
            tags: req.body?.tags
        })
    ));

    app.delete('/api/app/spitball/notes/:nodeId', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.deleteNote({
            gateway: ctx.gateway,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId,
            nodeId: req.params.nodeId
        })
    ));

    // "Why does Goobster believe this?" - a note's evidence trail
    // (Note -> Claim -> Source), for the Map's detail view
    app.get('/api/app/spitball/notes/:nodeId/evidence', requireAuth, chatRoute(async (req) =>
        ctx.spitball.getNoteEvidence(req.params.nodeId, { userId: req.webUser.userId })
    ));

    app.post('/api/app/spitball/expeditions/:id/pause', requireAuth, chatRoute(async (req) =>
        ctx.spitball.pauseExpedition(req.params.id, { userId: req.webUser.userId })
    ));

    app.post('/api/app/spitball/expeditions/:id/continue', requireAuth, chatRoute(async (req) => {
        const expedition = await ctx.spitball.continueExpedition(req.params.id, { userId: req.webUser.userId });
        ctx.spitballRunner.kick(expedition.id);
        return expedition;
    }));

    // Accept a "more cycles?" proposal on a completed expedition.
    app.post('/api/app/spitball/expeditions/:id/extend', requireAuth, chatRoute(async (req) => {
        const expedition = await ctx.spitball.extendExpedition(req.params.id, {
            userId: req.webUser.userId,
            extraCycles: req.body?.extraCycles ?? req.body?.cycles ?? null
        });
        ctx.spitballRunner.kick(expedition.id);
        return expedition;
    }));

    app.post('/api/app/spitball/expeditions/:id/cancel', requireAuth, chatRoute(async (req) =>
        ctx.spitball.cancelExpedition(req.params.id, { userId: req.webUser.userId })
    ));

    // --- MTGA deck library (import Arena deck exports into folders) ----------
    // User-scoped personal data, like tasks: no guild in any key, so plain
    // requireAuth is the whole access model. chatRoute already translates
    // MtgaError's status+code contract.

}

module.exports = { mountSpitball };
