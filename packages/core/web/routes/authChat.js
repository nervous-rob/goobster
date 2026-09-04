/**
 * Portal routes: AuthChat.
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */

const crypto = require('node:crypto');
const axios = require('axios');
const { DISCORD_API, SESSION_COOKIE, STATE_COOKIE } = require('../appHelpers');
const { streamWebChatTurn } = require('../appStream');

function mountAuthChat(app, ctx, h) {
    const { requireAuth, chatRoute, sendError, parseCookies, cookieAttributes } = h;


    // --- Auth -----------------------------------------------------------

    // Client bootstrap info (nothing secret)
    app.get('/api/app/config', (req, res) => {
        res.json({
            clientId: ctx.clientId,
            devMode: ctx.devMode,
            loginAvailable: Boolean(ctx.clientSecret && ctx.publicUrl),
            maxInputLength: ctx.chat.maxInputLength
        });
    });

    // Step 1: redirect to Discord's consent page with a state nonce
    app.get('/api/app/auth/login', (req, res) => {
        if (!ctx.clientSecret || !ctx.publicUrl) {
            sendError(res, 503, 'LOGIN_UNAVAILABLE',
                'Discord login is not configured (webapp.publicUrl and the client secret are required).');
            return;
        }
        const state = crypto.randomBytes(16).toString('hex');
        res.append('Set-Cookie', `${STATE_COOKIE}=${state}; ${cookieAttributes(ctx, 600)}`);
        const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
        authorizeUrl.searchParams.set('client_id', ctx.clientId);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('redirect_uri', `${ctx.publicUrl}/api/app/auth/callback`);
        authorizeUrl.searchParams.set('scope', 'identify');
        authorizeUrl.searchParams.set('state', state);
        res.redirect(authorizeUrl.toString());
    });

    // Step 2: exchange the code, resolve the user, mint a session cookie
    app.get('/api/app/auth/callback', async (req, res) => {
        try {
            if (!ctx.clientSecret || !ctx.publicUrl) {
                sendError(res, 503, 'LOGIN_UNAVAILABLE', 'Discord login is not configured.');
                return;
            }
            const { code, state } = req.query;
            const expectedState = parseCookies(req)[STATE_COOKIE];
            if (!code || !state || !expectedState || state !== expectedState) {
                sendError(res, 400, 'BAD_STATE', 'Login flow expired or was tampered with - try again.');
                return;
            }

            const tokenResponse = await axios.post(
                `${DISCORD_API}/oauth2/token`,
                new URLSearchParams({
                    client_id: ctx.clientId,
                    client_secret: ctx.clientSecret,
                    grant_type: 'authorization_code',
                    code: String(code),
                    redirect_uri: `${ctx.publicUrl}/api/app/auth/callback`
                }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
            );
            const accessToken = tokenResponse.data.access_token;

            const userResponse = await axios.get(`${DISCORD_API}/users/@me`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 10000
            });
            const user = userResponse.data;
            const { token } = await ctx.sessions.create({
                userId: user.id,
                userName: user.global_name || user.username,
                avatar: user.avatar || null
            });

            res.append('Set-Cookie', `${STATE_COOKIE}=; ${cookieAttributes(ctx, 0)}`);
            res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttributes(ctx, 30 * 24 * 60 * 60)}`);
            res.redirect('/app/');
        } catch (error) {
            ctx.logger.error?.('Web app OAuth callback failed:', error.response?.data || error.message);
            sendError(res, 502, 'OAUTH_FAILED', 'Discord login failed - try again.');
        }
    });

    // Local development identity (never available unless explicitly enabled)
    app.post('/api/app/auth/dev-session', async (req, res) => {
        if (!ctx.devMode) {
            sendError(res, 403, 'DEV_DISABLED', 'Dev sessions are disabled.');
            return;
        }
        const userId = String(req.body?.userId || '').trim();
        const name = String(req.body?.name || 'dev user').trim().slice(0, 32);
        if (!/^\d{5,20}$/.test(userId)) {
            sendError(res, 400, 'BAD_USER_ID', 'userId must look like a Discord snowflake (digits).');
            return;
        }
        const { token } = await ctx.sessions.create({ userId, userName: name });
        res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttributes(ctx, 30 * 24 * 60 * 60)}`);
        res.json({ user: { id: userId, name }, devMode: true });
    });

    app.post('/api/app/auth/logout', requireAuth, async (req, res) => {
        await ctx.sessions.destroy(req.webSessionToken);
        res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttributes(ctx, 0)}`);
        res.json({ ok: true });
    });

    // --- Session info ----------------------------------------------------

    app.get('/api/app/me', requireAuth, async (req, res) => {
        try {
            const scopes = await ctx.dashboard.listScopes({
                gateway: ctx.gateway,
                userId: req.webUser.userId
            });
            let bot = null;
            try {
                const botUser = await ctx.gateway?.botUser();
                if (botUser) bot = { id: botUser.id, name: botUser.username };
            } catch { /* bot down - degraded, the client shows offline state */ }
            res.json({
                user: {
                    id: req.webUser.userId,
                    name: req.webUser.userName,
                    avatar: req.webUser.avatar
                        ? `https://cdn.discordapp.com/avatars/${req.webUser.userId}/${req.webUser.avatar}.png?size=64`
                        : null
                },
                bot,
                scopes,
                maxInputLength: ctx.chat.maxInputLength,
                // Feature switches the client uses to show/hide panes
                features: {
                    observatory: ctx.observatory.enabled === true,
                    spitball: ctx.spitball.enabled === true
                }
            });
        } catch (error) {
            ctx.logger.error?.('Web app /me failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

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
    // (and offer to stop) an in-flight turn after a reload or from another
    // conversation - the per-user lock spans all of them.
    app.get('/api/app/chat/turn', requireAuth, chatRoute(async (req) =>
        ctx.chat.turnStatus(req.webUser.userId)
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
                incognito: req.body?.incognito === true
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
        res.sendFile(file.path);
    });
}

module.exports = { mountAuthChat };
