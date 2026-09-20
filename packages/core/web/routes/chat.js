/**
 * Portal routes: Study chat (conversations, history, shares, turns).
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */

const { streamWebChatTurn, streamLiveTurnProgress } = require('../appStream');
const { safeFileResponseHeaders } = require('../../utils/safeFileResponse');

function mountChat(app, ctx, h) {
    const { requireAuth, chatRoute, sendError } = h;

    // --- Chat -------------------------------------------------------------
    // Personalized new-chat suggestions (cache-first; a stale cache is
    // refreshed in the background - the empty state never waits on a model)
    app.get('/api/app/chat/suggestions', requireAuth, chatRoute(async (req) =>
        ctx.suggestions.getSuggestions({ userId: req.webUser.userId })
    ));

    app.get('/api/app/chat/conversations', requireAuth, chatRoute(async (req) => ({
        conversations: await ctx.chat.listConversations(req.webUser.userId)
    })));

    app.post('/api/app/chat/conversations', requireAuth, chatRoute(async (req) =>
        ctx.chat.createConversation(req.webUser.userId)
    ));

    app.patch('/api/app/chat/conversations/:conversationId', requireAuth, chatRoute(async (req) =>
        ctx.chat.renameConversation({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId,
            title: req.body?.title
        })
    ));

    app.delete('/api/app/chat/conversations/:conversationId', requireAuth, chatRoute(async (req) =>
        ctx.chat.deleteConversation({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId
        })
    ));

    app.get('/api/app/chat/history', requireAuth, chatRoute(async (req) => ({
        messages: await ctx.chat.getHistory({
            userId: req.webUser.userId,
            conversationId: req.query.conversationId ? Number(req.query.conversationId) : null,
            limit: req.query.limit,
            beforeId: req.query.beforeId ? Number(req.query.beforeId) : null
        })
    })));

    // Edit & resend / regenerate primitive: drop a message and everything
    // after it, then the client sends a fresh turn.
    app.post('/api/app/chat/truncate', requireAuth, chatRoute(async (req) =>
        ctx.chat.truncateFrom({
            userId: req.webUser.userId,
            conversationId: req.body?.conversationId,
            messageId: req.body?.messageId
        })
    ));

    // Branch: fork the conversation at a message (history before it is
    // copied into a fresh conversation; the original stays intact). The
    // client then sends the edited text as the branch's next turn.
    app.post('/api/app/chat/conversations/:conversationId/branch', requireAuth, chatRoute(async (req) =>
        ctx.chat.branchFrom({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId,
            messageId: req.body?.messageId
        })
    ));

    // Read-only share links: create (idempotent), inspect, revoke.
    app.post('/api/app/chat/conversations/:conversationId/share', requireAuth, chatRoute(async (req) =>
        ctx.chat.createShareLink({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId
        })
    ));

    app.get('/api/app/chat/conversations/:conversationId/share', requireAuth, chatRoute(async (req) =>
        ctx.chat.getShareLink({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId
        })
    ));

    app.delete('/api/app/chat/conversations/:conversationId/share', requireAuth, chatRoute(async (req) =>
        ctx.chat.revokeShareLink({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId
        })
    ));

    // Public share endpoint - deliberately NO auth: the unguessable token
    // is the capability, and it reads exactly one conversation's text.
    app.get('/api/app/share/:token', chatRoute(async (req) =>
        ctx.chat.getSharedConversation(req.params.token)
    ));

    // Stop the in-flight turn (the agent loop halts at the next round
    // boundary; partial text is kept, ChatGPT-style).
    app.post('/api/app/chat/stop', requireAuth, chatRoute(async (req) => ({
        stopped: await ctx.chat.stopTurn(req.webUser.userId)
    })));

    // Is a reply still generating for this user? Lets the client rediscover
    // (and restore progress for) an in-flight turn after a reload or from
    // another conversation - the per-user lock spans all of them.
    app.get('/api/app/chat/turn', requireAuth, chatRoute(async (req) =>
        ctx.chat.turnStatus(req.webUser.userId, {
            client: ctx.client,
            gateway: ctx.gateway,
            userName: req.webUser.userName
        })
    ));

    // Reattach to the in-flight turn's thoughts/tools/draft. Disconnect
    // only stops writing; the turn itself keeps running.
    app.get('/api/app/chat/turn/stream', requireAuth, async (req, res) => {
        try {
            Promise.resolve(ctx.chat.turnStatus?.(req.webUser.userId, {
                client: ctx.client,
                gateway: ctx.gateway,
                userName: req.webUser.userName
            })).catch(() => {});
            const rawTurnId = req.query?.turnId;
            const expectedTurnId = typeof rawTurnId === 'string' && rawTurnId.trim()
                ? rawTurnId.trim()
                : null;
            await streamLiveTurnProgress(res, {
                userId: req.webUser.userId,
                chat: ctx.chat,
                expectedTurnId
            });
        } catch (error) {
            if (res.headersSent) return;
            const status = error.status || 500;
            sendError(res, status, error.code || 'INTERNAL',
                status === 500 ? 'Something went wrong.' : error.message,
                error.details || null);
        }
    });

    app.get('/api/app/chat/queue', requireAuth, chatRoute(async (req) =>
        ctx.chat.listQueue(req.webUser.userId, {
            client: ctx.client,
            gateway: ctx.gateway,
            userName: req.webUser.userName
        })
    ));

    app.post('/api/app/chat/queue', requireAuth, chatRoute(async (req) => {
        const files = await ctx.chat.extractDocumentFiles(req.body?.files ?? null);
        return ctx.chat.enqueue({
            client: ctx.client,
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            userName: req.webUser.userName,
            message: req.body?.message,
            conversationId: req.body?.conversationId ?? null,
            images: req.body?.images ?? null,
            files,
            incognito: req.body?.incognito === true
        });
    }));

    app.delete('/api/app/chat/queue/:id', requireAuth, chatRoute(async (req) =>
        ctx.chat.removeQueued(req.webUser.userId, req.params.id)
    ));

    app.patch('/api/app/chat/queue', requireAuth, chatRoute(async (req) =>
        ctx.chat.reorderQueue(req.webUser.userId, req.body?.ids)
    ));

    // AI settings for the user's web/DM scope (same storage as /aisettings
    // and /thoughtfulmode, so Discord DMs follow along): provider, model,
    // reasoning effort, and the Thoughtful Mode preset shortcut.
    app.get('/api/app/chat/settings', requireAuth, chatRoute((req) =>
        ctx.chat.getAiSettings(req.webUser.userId)
    ));

    app.patch('/api/app/chat/settings', requireAuth, chatRoute((req) => {
        if (typeof req.body?.thoughtful === 'boolean') {
            return ctx.chat.setThoughtful({
                userId: req.webUser.userId,
                thoughtful: req.body.thoughtful === true
            });
        }
        return ctx.chat.setAiSettings({
            userId: req.webUser.userId,
            provider: 'provider' in (req.body || {}) ? req.body.provider : undefined,
            model: 'model' in (req.body || {}) ? req.body.model : undefined,
            reasoningEffort: 'reasoningEffort' in (req.body || {}) ? req.body.reasoningEffort : undefined,
            customInstructions: 'customInstructions' in (req.body || {}) ? req.body.customInstructions : undefined
        });
    }));

    // Models the provider's API key can actually use (live listing, cached)
    // - populates the settings modal's model dropdown.
    app.get('/api/app/chat/models', requireAuth, chatRoute(async (req) => ({
        models: await ctx.chat.listModels(req.query.provider ? String(req.query.provider) : undefined)
    })));

    // Full-text search across every message in the user's web conversations
    // (the sidebar search box; results deep-link to a message).
    app.get('/api/app/chat/search', requireAuth, chatRoute(async (req) => ({
        results: await ctx.chat.searchMessages({
            userId: req.webUser.userId,
            query: String(req.query.q || ''),
            limit: req.query.limit ? Number(req.query.limit) : undefined
        })
    })));

    // Leaving incognito mode drops the transient window immediately.
    app.delete('/api/app/chat/incognito', requireAuth, chatRoute(async (req) =>
        ctx.chat.clearIncognito(req.webUser.userId)
    ));

    // One chat turn, streamed back as Server-Sent Events:
    //   typing {}                     the bot started working
    //   delta  { text }               raw streamed token delta
    //   tool   { phase, id, name, cached, argsPreview } on start /
    //          { phase, id, name, isError, cached, resultPreview, durationMs }
    //          on result - per-tool progress (activity chips + tooltips)
    //   message{ content, attachments, isError }  a completed bot message
    //   done   { ok }                 the turn finished
    //   error  { code, message }      the turn failed mid-stream
    app.post('/api/app/chat', requireAuth, async (req, res) => {
        let turn;
        try {
            // PDFs arrive as base64 and become text entries before the turn
            // starts, so extraction failures stay proper HTTP errors.
            const files = await ctx.chat.extractDocumentFiles(req.body?.files ?? null);
            turn = await ctx.chat.startTurn({
                client: ctx.client,
                gateway: ctx.gateway,
                userId: req.webUser.userId,
                userName: req.webUser.userName,
                message: req.body?.message,
                conversationId: req.body?.conversationId ?? null,
                images: req.body?.images ?? null,
                files,
                incognito: req.body?.incognito === true,
                // Voice chat marks its turns so the reply is written for speech.
                spoken: req.body?.spoken === true
            });
        } catch (error) {
            // Validation failures happen before the stream starts, so they
            // can still be proper HTTP errors (400/409/429/503).
            const status = error.status || 500;
            sendError(res, status, error.code || 'INTERNAL',
                status === 500 ? 'Something went wrong.' : error.message,
                error.details || null);
            return;
        }

        await streamWebChatTurn(res, turn, ctx);
    });
    // Generated files (image tool output) - owner-only, persisted registry
    app.get('/api/app/files/:fileId', requireAuth, async (req, res) => {
        const file = await ctx.chat.getFile(req.params.fileId, req.webUser.userId);
        if (!file) {
            sendError(res, 404, 'NOT_FOUND', 'File not found (it may have expired).');
            return;
        }
        // Applies to previously saved files too, regardless of their name.
        res.set(safeFileResponseHeaders(file.path));
        res.sendFile(file.path);
    });
}

module.exports = { mountChat };
