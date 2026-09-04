/**
 * Portal routes: Workspace.
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */

const { LOOKUP_BATCH_DEFAULT } = require('../../services/mtgaCardService');

function mountWorkspace(app, ctx, h) {
    const {
        requireAuth, chatRoute, dashboardRoute, exchangeRoute,
        appletRoute, integrationRoute
    } = h;


    app.get('/api/app/mtga/library', requireAuth, chatRoute(async (req) => ({
        folders: await ctx.mtga.listFolders(req.webUser.userId),
        decks: await ctx.mtga.listDecks({ userId: req.webUser.userId })
    })));

    app.post('/api/app/mtga/folders', requireAuth, chatRoute(async (req) =>
        ctx.mtga.createFolder({ userId: req.webUser.userId, name: req.body?.name })
    ));

    app.patch('/api/app/mtga/folders/:folderId', requireAuth, chatRoute(async (req) =>
        ctx.mtga.renameFolder({
            userId: req.webUser.userId,
            folderId: req.params.folderId,
            name: req.body?.name
        })
    ));

    // Deleting a folder never deletes its decks - they fall back to Unfiled
    app.delete('/api/app/mtga/folders/:folderId', requireAuth, chatRoute(async (req) =>
        ctx.mtga.deleteFolder({ userId: req.webUser.userId, folderId: req.params.folderId })
    ));

    // Paste Arena's "Export to clipboard" text (one deck, or several
    // back-to-back) into a folder
    app.post('/api/app/mtga/decks/import', requireAuth, chatRoute(async (req) =>
        ctx.mtga.importDecks({
            userId: req.webUser.userId,
            text: req.body?.text,
            folderId: req.body?.folderId ?? null,
            name: req.body?.name ?? null,
            format: req.body?.format ?? null
        })
    ));

    // Parse a Player.log excerpt into a pickable deck list (no Scryfall).
    app.post('/api/app/mtga/decks/preview-log', requireAuth, chatRoute(async (req) =>
        ctx.mtga.previewFromLog({ text: req.body?.text })
    ));

    // Import selected decks from Arena's Player.log (the client sends only
    // the deck-bearing lines). First import resolves card ids through
    // Scryfall in polite batches (`status: 'resolving'` until the catalog
    // is warm); re-imports are idempotent (content-hash dedupe) and instant.
    app.post('/api/app/mtga/decks/import-log', requireAuth, chatRoute(async (req) =>
        ctx.mtga.importFromLog({
            userId: req.webUser.userId,
            text: req.body?.text,
            folderId: req.body?.folderId ?? null,
            deckKeys: req.body?.deckKeys ?? null,
            lookupBudget: req.body?.lookupBudget ?? LOOKUP_BATCH_DEFAULT
        })
    ));

    app.get('/api/app/mtga/decks/:deckId', requireAuth, chatRoute(async (req) =>
        ctx.mtga.getDeck({ userId: req.webUser.userId, deckId: req.params.deckId })
    ));

    // Rename and/or move between folders (folderId null = Unfiled)
    app.patch('/api/app/mtga/decks/:deckId', requireAuth, chatRoute(async (req) =>
        ctx.mtga.updateDeck({
            userId: req.webUser.userId,
            deckId: req.params.deckId,
            name: 'name' in (req.body || {}) ? req.body.name : undefined,
            folderId: 'folderId' in (req.body || {}) ? req.body.folderId : undefined
        })
    ));

    app.delete('/api/app/mtga/decks/:deckId', requireAuth, chatRoute(async (req) =>
        ctx.mtga.deleteDeck({ userId: req.webUser.userId, deckId: req.params.deckId })
    ));

    // The verbatim Arena export text (copy back into Arena's import box)
    app.get('/api/app/mtga/decks/:deckId/export', requireAuth, chatRoute(async (req) =>
        ctx.mtga.exportDeck({ userId: req.webUser.userId, deckId: req.params.deckId })
    ));

    // --- Personal usage stats -------------------------------------------------

    app.get('/api/app/usage', requireAuth, chatRoute(async (req) =>
        ctx.dashboard.getUsageStats({
            userId: req.webUser.userId,
            days: req.query.days ? Number(req.query.days) : undefined
        })
    ));

    // --- Platform integrations (Notion, GitHub, ...) -------------------------
    // The catalog with per-user connection status (tokens never included)
    app.get('/api/app/integrations', requireAuth, integrationRoute(async (req) => ({
        integrations: await ctx.integrations.list(req.webUser.userId)
    })));

    // Connect (or replace): verifies the token live against the provider
    app.post('/api/app/integrations/:provider', requireAuth, integrationRoute(async (req) =>
        ctx.integrations.connect({
            userId: req.webUser.userId,
            provider: req.params.provider,
            token: req.body?.token
        })
    ));

    app.delete('/api/app/integrations/:provider', requireAuth, integrationRoute(async (req) =>
        ctx.integrations.disconnect({
            userId: req.webUser.userId,
            provider: req.params.provider
        })
    ));

    // --- Memory dashboard --------------------------------------------------
    app.get('/api/app/memory/report', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.getReport({
            gateway: ctx.gateway,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId
        })
    ));

    app.get('/api/app/memory/memories', requireAuth, dashboardRoute(async (req) => ({
        memories: await ctx.dashboard.listMemories({
            gateway: ctx.gateway,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId,
            limit: req.query.limit
        })
    })));

    app.delete('/api/app/memory/memories/:memoryId', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.deleteMemory({
            gateway: ctx.gateway,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId,
            memoryId: req.params.memoryId
        })
    ));

    app.get('/api/app/memory/facts', requireAuth, dashboardRoute(async (req) => ({
        facts: await ctx.dashboard.listFacts({
            gateway: ctx.gateway,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId
        })
    })));

    app.delete('/api/app/memory/facts/:factId', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.deleteFact({
            gateway: ctx.gateway,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId,
            factId: req.params.factId
        })
    ));

    // Memory retention for the user's own DM scope (view + set); setting
    // purges immediately, like /privacy retention.
    app.get('/api/app/memory/retention', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.getRetention({
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId
        })
    ));

    app.put('/api/app/memory/retention', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.setRetention({
            scope: String(req.body?.scope || ''),
            userId: req.webUser.userId,
            days: req.body?.days
        })
    ));

    app.get('/api/app/graph', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.getGraph({
            gateway: ctx.gateway,
            guildId: String(req.query.guildId || ''),
            userId: req.webUser.userId
        })
    ));

    // Companion Home (facts, watching, pickup) — chat is a verb from here.
    app.get('/api/app/home', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.getHome({
            gateway: ctx.gateway,
            userId: req.webUser.userId
        })
    ));

    // Personal constellation (you + facts + memories) for the Library map.
    app.get('/api/app/memory/constellation', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.getConstellation({
            gateway: ctx.gateway,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId
        })
    ));

    // Reflection: the "Reflect" button. POST starts a knowledge-enrichment
    // run (returns the run row immediately; passes execute in background);
    // GET polls the latest run for the scope/target.
    app.get('/api/app/memory/reflection', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.getReflection({
            gateway: ctx.gateway,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId,
            target: String(req.query.target || 'personal')
        })
    ));

    app.post('/api/app/memory/reflection', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.startReflection({
            gateway: ctx.gateway,
            scope: String(req.body?.scope || ''),
            userId: req.webUser.userId,
            target: String(req.body?.target || 'personal')
        })
    ));

    // Web face of /forget-me. Type FORGET ME. Sessions die inside the call.
    app.post('/api/app/privacy/forget', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.forgetMe({
            userId: req.webUser.userId,
            extraNames: [req.webUser.userName].filter(Boolean),
            confirm: req.body?.confirm,
            gateway: ctx.gateway
        })
    ));

    // --- The Assistant Inbox (attention) -------------------------------------

    // Everything the Noticed pane renders in one shape: the initiative
    // policy, the inbox, the ledger of open loops, armed watches, and the
    // calibration the user's own dismissals produced.
    app.get('/api/app/attention', requireAuth, chatRoute(async (req) =>
        ctx.attention.getOverview({ userId: req.webUser.userId })
    ));

    // Opt in. Nothing in the attention system runs for somebody without it.
    app.post('/api/app/attention/enroll', requireAuth, chatRoute(async (req) =>
        ctx.attention.enroll({
            userId: req.webUser.userId,
            initiative: req.body?.initiative || null
        })
    ));

    app.post('/api/app/attention/disable', requireAuth, chatRoute(async (req) =>
        ctx.attention.disable({ userId: req.webUser.userId })
    ));

    app.patch('/api/app/attention/policy', requireAuth, chatRoute(async (req) =>
        ctx.attention.updatePolicy({
            userId: req.webUser.userId,
            initiative: req.body?.initiative || null,
            maxContactsPerDay: req.body?.maxContactsPerDay ?? null,
            contactCooldownMinutes: req.body?.contactCooldownMinutes ?? null,
            quietStartMinute: req.body?.quietStartMinute,
            quietEndMinute: req.body?.quietEndMinute,
            boundary: req.body?.boundary || null
        })
    ));

    // Dismissal is feedback, not a delete: it raises the bar for that
    // category next time, which is why there is no plain remove route.
    app.post('/api/app/attention/notices/:noticeId', requireAuth, chatRoute(async (req) =>
        ctx.attention.actOnNotice({
            userId: req.webUser.userId,
            noticeId: req.params.noticeId,
            action: String(req.body?.action || ''),
            snoozeHours: req.body?.snoozeHours ?? null
        })
    ));

    // "Why do you think this?" - the evidence behind one open loop.
    app.get('/api/app/attention/items/:itemId', requireAuth, chatRoute(async (req) =>
        ctx.attention.getItemProvenance({
            userId: req.webUser.userId,
            itemId: req.params.itemId
        })
    ));

    app.post('/api/app/attention/items/:itemId/resolve', requireAuth, chatRoute(async (req) =>
        ctx.attention.resolveItem({
            userId: req.webUser.userId,
            itemId: req.params.itemId,
            state: String(req.body?.state || 'resolved')
        })
    ));

    app.delete('/api/app/attention/watches/:watchId', requireAuth, chatRoute(async (req) =>
        ctx.attention.cancelWatch({
            userId: req.webUser.userId,
            watchId: req.params.watchId
        })
    ));
    app.get('/api/app/applets', requireAuth, appletRoute(async (req) =>
        ctx.applets.listWorkshop(req.webUser.userId)
    ));

    app.post('/api/app/applets', requireAuth, appletRoute(async (req) =>
        ctx.applets.pin({
            userId: req.webUser.userId,
            title: req.body?.title,
            language: req.body?.language,
            source: req.body?.source,
            conversationId: req.body?.conversationId,
            messageId: req.body?.messageId,
            grants: req.body?.grants
        })
    ));

    // Promote a pin (or a discovered fence) into a versioned project asset.
    // Registered before /:appletId so "promote" is never captured as an id.
    app.post('/api/app/applets/promote', requireAuth, appletRoute(async (req) =>
        ctx.applets.promote({
            userId: req.webUser.userId,
            appletId: req.body?.appletId,
            project: req.body?.project,
            name: req.body?.name,
            slug: req.body?.slug,
            language: req.body?.language,
            source: req.body?.source,
            conversationId: req.body?.conversationId,
            messageId: req.body?.messageId,
            grants: req.body?.grants,
            origin: req.body?.origin || 'portal'
        })
    ));

    app.post('/api/app/applets/:appletId/promote', requireAuth, appletRoute(async (req) =>
        ctx.applets.promote({
            userId: req.webUser.userId,
            appletId: req.params.appletId,
            project: req.body?.project,
            name: req.body?.name,
            slug: req.body?.slug,
            origin: req.body?.origin || 'portal'
        })
    ));

    app.get('/api/app/applets/:appletId', requireAuth, appletRoute(async (req) =>
        ctx.applets.get({ userId: req.webUser.userId, appletId: req.params.appletId })
    ));

    app.patch('/api/app/applets/:appletId', requireAuth, appletRoute(async (req) =>
        ctx.applets.update({
            userId: req.webUser.userId,
            appletId: req.params.appletId,
            title: req.body?.title,
            touchOpened: req.body?.touchOpened === true,
            grants: req.body?.grants
        })
    ));

    app.delete('/api/app/applets/:appletId', requireAuth, appletRoute(async (req) =>
        ctx.applets.unpin({ userId: req.webUser.userId, appletId: req.params.appletId })
    ));

    // --- The Jimbucks Exchange (browser trading terminal) --------------------
    /** The guild + caller identity every exchange call is scoped to. */
    function exchangeScope(req, guildId = req.query.guildId) {
        return {
            gateway: ctx.gateway,
            guildId: String(guildId || ''),
            userId: req.webUser.userId
        };
    }

    app.get('/api/app/exchange/overview', requireAuth, exchangeRoute((req) =>
        ctx.exchange.overview(exchangeScope(req))
    ));

    app.get('/api/app/exchange/quote', requireAuth, exchangeRoute((req) =>
        ctx.exchange.quote({ ...exchangeScope(req), symbol: String(req.query.symbol || '') })
    ));

    app.get('/api/app/exchange/history', requireAuth, exchangeRoute((req) =>
        ctx.exchange.history({
            ...exchangeScope(req),
            symbol: String(req.query.symbol || ''),
            range: req.query.range ? String(req.query.range) : undefined
        })
    ));

    app.get('/api/app/exchange/search', requireAuth, exchangeRoute(async (req) => ({
        results: await ctx.exchange.search({ ...exchangeScope(req), query: String(req.query.q || '') })
    })));

    // Buy / sell longs, or short / cover (the margin feature gates itself)
    app.post('/api/app/exchange/trade', requireAuth, exchangeRoute((req) =>
        ctx.exchange.tradeStock({
            ...exchangeScope(req, req.body?.guildId),
            side: req.body?.side,
            symbol: req.body?.symbol,
            units: req.body?.units
        })
    ));

    app.get('/api/app/exchange/chain', requireAuth, exchangeRoute((req) =>
        ctx.exchange.chain({
            ...exchangeScope(req),
            symbol: String(req.query.symbol || ''),
            expiry: req.query.expiry ? String(req.query.expiry) : null
        })
    ));

    app.post('/api/app/exchange/options', requireAuth, exchangeRoute((req) =>
        ctx.exchange.tradeOption({
            ...exchangeScope(req, req.body?.guildId),
            action: req.body?.action,
            symbol: req.body?.symbol,
            optionType: req.body?.optionType,
            strike: req.body?.strike,
            expiry: req.body?.expiry,
            contracts: req.body?.contracts,
            positionId: req.body?.positionId
        })
    ));

    app.get('/api/app/exchange/orders', requireAuth, exchangeRoute(async (req) => ({
        orders: await ctx.exchange.listOrders(exchangeScope(req))
    })));

    app.post('/api/app/exchange/orders', requireAuth, exchangeRoute((req) =>
        ctx.exchange.placeOrder({
            ...exchangeScope(req, req.body?.guildId),
            symbol: req.body?.symbol,
            side: req.body?.side,
            orderType: req.body?.orderType,
            units: req.body?.units,
            limitPrice: req.body?.limitPrice,
            stopPrice: req.body?.stopPrice,
            trailPercent: req.body?.trailPercent
        })
    ));

    app.delete('/api/app/exchange/orders/:orderId', requireAuth, exchangeRoute((req) =>
        ctx.exchange.cancelOrder({ ...exchangeScope(req), orderId: req.params.orderId })
    ));

    app.get('/api/app/exchange/leaderboard', requireAuth, exchangeRoute((req) =>
        ctx.exchange.leaderboard(exchangeScope(req))
    ));
}

module.exports = { mountWorkspace };
