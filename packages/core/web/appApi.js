/**
 * Goobster web app backend: Discord OAuth login, cookie sessions, the SSE
 * chat API, and the memory dashboard API. Mounted on the public health
 * server ONLY when config.webapp.enabled is true (same opt-in rule as the
 * Activity - it must be reachable through the public tunnel).
 *
 * Auth model:
 *  - Real flow: the standard OAuth2 authorization-code redirect
 *    (GET /api/app/auth/login -> discord.com -> GET /api/app/auth/callback).
 *    Scope is `identify` only; the access token is used once to resolve the
 *    user and is never stored. Sessions are SQLite-backed hashed tokens
 *    (services/webSessionService.js) delivered as an httpOnly cookie.
 *  - Dev flow (config.webapp.devMode): POST /api/app/auth/dev-session mints
 *    a session for an arbitrary identity so the app can be developed in a
 *    plain browser without Discord. Never enable on an exposed server.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const { toGateway } = require('../gateway');
const eventBusService = require('../services/eventBusService');
const webSessionService = require('../services/webSessionService');
const webChatService = require('../services/webChatService');
const webDashboardService = require('../services/webDashboardService');
const parlorService = require('../services/parlorService');
const parlorLiveService = require('../services/parlorLiveService');
const friendService = require('../services/friendService');
const presenceService = require('../services/presenceService');
const userIntegrationService = require('../services/userIntegrationService');
const webVoiceService = require('../services/webVoiceService');
const voiceLiveService = require('../services/voiceLiveService');
const webTaskService = require('../services/webTaskService');
const webExchangeService = require('../services/webExchangeService');
const observatoryService = require('../services/observatoryService');
const projectAssetService = require('../services/projectAssetService');
const projectTriggerService = require('../services/projectTriggerService');
const mtgaService = require('../services/mtgaService');
const { LOOKUP_BATCH_DEFAULT } = require('../services/mtgaCardService');
const webAppletService = require('../services/webAppletService');
const webAttentionService = require('../services/webAttentionService');
const spitballExpeditionService = require('../services/spitballExpeditionService');
const spitballExpeditionRunner = require('../services/spitballExpeditionRunner');
const spitballLensConfig = require('../config/spitballLensConfig');
const spitballConfig = require('../config/spitballConfig');

const DISCORD_API = 'https://discord.com/api';
const SESSION_COOKIE = 'goobster_web_session';
const STATE_COOKIE = 'goobster_oauth_state';
const SSE_HEARTBEAT_MS = 15000;
/** Custom Observatory commands are prompts, not pastes - keep them tight. */
const OBSERVATORY_COMMAND_MAX_LENGTH = 4000;

/**
 * Everything the web app backend needs, wired once at startup.
 *
 * Discord access goes through the gateway seam (reactive port spec §6):
 * the bot app passes its live client (wrapped in a LocalGateway), the api
 * app passes a RemoteGateway. `client` is kept on the context solely so
 * the bot process can hand the real client to chat-turn tools; in the api
 * process it is null and the pseudo-interaction carries a shim instead.
 */
function createWebAppContext({ client = null, gateway = null, config, logger = console, deps = {} }) {
    const webappConfig = config.webapp || {};
    const publicUrl = typeof webappConfig.publicUrl === 'string'
        ? webappConfig.publicUrl.replace(/\/+$/, '')
        : null;
    return {
        client,
        gateway: deps.gateway || toGateway(gateway || client),
        config,
        logger,
        devMode: webappConfig.devMode === true,
        clientId: config.clientId,
        // Shared with the Activity: one Discord application, one secret.
        clientSecret: process.env.DISCORD_CLIENT_SECRET
            || webappConfig.clientSecret
            || config.activity?.clientSecret
            || null,
        publicUrl,
        secureCookies: Boolean(publicUrl && publicUrl.startsWith('https://')),
        sessions: deps.sessions || webSessionService,
        chat: deps.chat || webChatService,
        dashboard: deps.dashboard || webDashboardService,
        parlor: deps.parlor || parlorService,
        parlorLive: deps.parlorLive || parlorLiveService,
        friends: deps.friends || friendService,
        presence: deps.presence || presenceService,
        integrations: deps.integrations || userIntegrationService,
        voice: deps.voice || webVoiceService,
        voiceLive: deps.voiceLive || voiceLiveService,
        tasks: deps.tasks || webTaskService,
        exchange: deps.exchange || webExchangeService,
        observatory: deps.observatory || observatoryService,
        projectAssets: deps.projectAssets || projectAssetService,
        projectTriggers: deps.projectTriggers || projectTriggerService,
        spitball: deps.spitball || spitballExpeditionService,
        spitballRunner: deps.spitballRunner || spitballExpeditionRunner,
        mtga: deps.mtga || mtgaService,
        applets: deps.applets || webAppletService,
        attention: deps.attention || webAttentionService,
        events: deps.events || eventBusService
    };
}

/** Minimal cookie parsing - not worth a dependency. */
function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key) out[key] = decodeURIComponent(value);
    }
    return out;
}

function cookieAttributes(ctx, maxAgeSeconds) {
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${ctx.secureCookies ? '; Secure' : ''}`;
}

function sendError(res, status, code, message, details = null) {
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

/**
 * Express router serving the web app client + API. Mounted at the root of
 * the public server; routes are namespaced under /app and /api/app.
 */
function createWebAppApp(ctx) {
    const app = express.Router();
    // Scoped parser (activityApi pattern): a router-wide parser would eat
    // request bodies destined for the raw-body webhook receivers. The limit
    // covers vision attachments (up to 4 base64 data URLs per message) and
    // a large Player.log deck-list excerpt (parser cap is 80MB).
    app.use('/api/app', express.json({ limit: '82mb' }));

    // CSRF guard for state-changing routes: cookies are SameSite=Lax, and
    // any Origin present on a non-GET request must match the request host.
    app.use('/api/app', (req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        const origin = req.headers.origin;
        if (!origin) return next();
        let originHost;
        try {
            originHost = new URL(origin).host;
        } catch {
            originHost = null;
        }
        if (!originHost || originHost !== req.headers.host) {
            sendError(res, 403, 'BAD_ORIGIN', 'Cross-origin requests are not allowed.');
            return;
        }
        next();
    });

    /** Session-required middleware: resolves req.webUser or answers 401. */
    async function requireAuth(req, res, next) {
        const token = parseCookies(req)[SESSION_COOKIE];
        const session = token ? await ctx.sessions.get(token) : null;
        if (!session) {
            sendError(res, 401, 'UNAUTHENTICATED', 'Sign in with Discord to use the web app.');
            return;
        }
        req.webUser = session;
        req.webSessionToken = token;
        next();
    }

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

    /** Translate WebChatError into JSON; everything else is a 500. */
    function chatRoute(handler) {
        return async (req, res) => {
            try {
                res.json(await handler(req));
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(res, error.status, error.code, error.message, error.details || null);
                    return;
                }
                ctx.logger.error?.('Web chat route failed:', error.message);
                sendError(res, 500, 'INTERNAL', 'Something went wrong.');
            }
        };
    }

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

        await streamWebChatTurn(res, turn);
    });

    /**
     * Stream one web chat turn back as Server-Sent Events (the event
     * vocabulary documented on POST /api/app/chat). Shared by the chat
     * composer and the Observatory's custom-command endpoint.
     */
    async function streamWebChatTurn(res, turn) {
        res.status(200).set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();

        let open = true;
        const send = (event, data) => {
            if (!open) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const heartbeat = setInterval(() => {
            if (open) res.write(': ping\n\n');
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref?.();
        // The turn keeps running if the browser disconnects (the reply is
        // stored in history either way) - we just stop writing. NOTE: the
        // listener must be on res, not req - a consumed POST body emits
        // req 'close' immediately, long before the client goes away.
        res.on('close', () => { open = false; });

        try {
            send('start', { conversationId: turn.conversationId });
            await turn.run({
                onTyping: () => send('typing', {}),
                onDelta: (text) => send('delta', { text }),
                onTool: (event) => send('tool', event),
                onMessage: (message) => send('message', message)
            });
            send('done', { ok: true, conversationId: turn.conversationId });
        } catch (error) {
            ctx.logger.error?.('Web chat turn failed:', error.message);
            send('error', { code: 'INTERNAL', message: 'Something went wrong generating the reply.' });
        } finally {
            clearInterval(heartbeat);
            if (open) res.end();
        }
    }

    // Generated files (image tool output) - owner-only, persisted registry
    app.get('/api/app/files/:fileId', requireAuth, async (req, res) => {
        const file = await ctx.chat.getFile(req.params.fileId, req.webUser.userId);
        if (!file) {
            sendError(res, 404, 'NOT_FOUND', 'File not found (it may have expired).');
            return;
        }
        res.sendFile(file.path);
    });

    // --- Voice (mic input + read-aloud) --------------------------------------

    // What the client may offer (missing keys hide the buttons - never error)
    app.get('/api/app/voice/capabilities', requireAuth, chatRoute(async () =>
        ctx.voice.capabilities()
    ));

    // The ElevenLabs voice library, for the voice-picker UI
    app.get('/api/app/voice/voices', requireAuth, chatRoute(async () =>
        ctx.voice.listVoices()
    ));

    // The user's saved voice preference (voice + playback speed)
    app.get('/api/app/voice/settings', requireAuth, chatRoute(async (req) =>
        ctx.voice.getVoiceSettings({ userId: req.webUser.userId })
    ));

    app.patch('/api/app/voice/settings', requireAuth, chatRoute(async (req) =>
        ctx.voice.setVoiceSettings({
            userId: req.webUser.userId,
            voiceId: req.body?.voiceId,
            speed: req.body?.speed
        })
    ));

    // One recorded clip in, transcribed text out (the composer mic button)
    app.post('/api/app/voice/transcribe', requireAuth, chatRoute(async (req) =>
        ctx.voice.transcribe({
            userId: req.webUser.userId,
            audioBase64: req.body?.audio,
            mimeType: req.body?.mimeType
        })
    ));

    // Read a reply aloud: MP3 streamed straight from the TTS provider
    app.post('/api/app/voice/tts', requireAuth, async (req, res) => {
        try {
            const { stream, contentType } = await ctx.voice.synthesize({
                userId: req.webUser.userId,
                text: req.body?.text
            });
            res.status(200).set({ 'Content-Type': contentType, 'Cache-Control': 'no-store' });
            stream.on('error', () => { try { res.end(); } catch { /* gone */ } });
            stream.pipe(res);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Web TTS failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // --- Scheduled tasks (automations + followups) ----------------------------

    app.get('/api/app/tasks', requireAuth, chatRoute(async (req) =>
        ctx.tasks.listTasks({ gateway: ctx.gateway, userId: req.webUser.userId })
    ));

    app.post('/api/app/tasks', requireAuth, chatRoute(async (req) =>
        ctx.tasks.createTask({
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            name: req.body?.name,
            prompt: req.body?.prompt,
            cron: req.body?.cron ?? null,
            dueAt: req.body?.dueAt ?? null
        })
    ));

    app.patch('/api/app/tasks/automations/:automationId', requireAuth, chatRoute(async (req) =>
        ctx.tasks.setAutomationEnabled({
            userId: req.webUser.userId,
            automationId: req.params.automationId,
            enabled: req.body?.enabled === true
        })
    ));

    app.delete('/api/app/tasks/automations/:automationId', requireAuth, chatRoute(async (req) =>
        ctx.tasks.deleteAutomation({
            userId: req.webUser.userId,
            automationId: req.params.automationId
        })
    ));

    app.delete('/api/app/tasks/followups/:followupId', requireAuth, chatRoute(async (req) =>
        ctx.tasks.cancelFollowup({
            userId: req.webUser.userId,
            followupId: req.params.followupId
        })
    ));

    // --- The Observatory (persistent simulation projects) ---------------------

    // Project list with sizes and job counts (the pane's overview)
    app.get('/api/app/observatory/projects', requireAuth, chatRoute(async (req) => ({
        projects: await ctx.observatory.listProjects(req.webUser.userId)
    })));

    // One project, standardized: registry + status counts, jobs with
    // output tails, checkpoint, and the workspace listing (files get
    // owner-bound servable URLs through the same registry as generated
    // chat images) - everything the project view renders, in one shape.
    app.get('/api/app/observatory/projects/:slug', requireAuth, chatRoute(async (req) => {
        const userId = req.webUser.userId;
        const detail = await ctx.observatory.getProjectDetail({ userId, project: req.params.slug });
        const files = [];
        for (const file of detail.files) {
            let url = null;
            try {
                const resolved = await ctx.observatory.resolveFile({
                    userId, project: detail.project.slug, relPath: file.path
                });
                url = (await ctx.chat.registerFile(resolved.path, userId))?.url || null;
            } catch { /* raced away - listed without a link */ }
            files.push({ ...file, url });
        }
        return { ...detail, files };
    }));

    /**
     * Find (or create) the Observatory's dedicated web conversation for
     * one title. Custom commands share that thread, so the agent keeps
     * context across commands and the transcript stays browsable from
     * the Chat pane.
     */
    async function observatoryConversationId(userId, title) {
        const existing = (await ctx.chat.listConversations(userId)).find(c => c.title === title);
        if (existing) return existing.id;
        const created = await ctx.chat.createConversation(userId);
        await ctx.chat.renameConversation({ userId, conversationId: created.id, title });
        return created.id;
    }

    // Custom command: one full agent turn (tools included, same machinery
    // as the chat composer) told to drive the Observatory with the user's
    // instructions, streamed back with the /api/app/chat SSE vocabulary.
    // `project` is optional - without it the agent may create projects.
    app.post('/api/app/observatory/command', requireAuth, async (req, res) => {
        let turn;
        try {
            if (ctx.observatory.enabled !== true) {
                sendError(res, 403, 'DISABLED', 'The Observatory is disabled on this server.');
                return;
            }
            const userId = req.webUser.userId;
            const instructions = String(req.body?.instructions ?? '').trim();
            if (!instructions) {
                sendError(res, 400, 'EMPTY_COMMAND', 'Tell Goobster what to do first.');
                return;
            }
            if (instructions.length > OBSERVATORY_COMMAND_MAX_LENGTH) {
                sendError(res, 400, 'COMMAND_TOO_LONG',
                    `Keep commands under ${OBSERVATORY_COMMAND_MAX_LENGTH} characters.`);
                return;
            }
            const projectRef = req.body?.project ? String(req.body.project) : null;
            const project = projectRef
                ? await ctx.observatory.resolveProject({ userId, project: projectRef })
                : null;

            const message = (project
                ? `[Observatory command for project "${project.name}" (slug: ${project.slug})] `
                  + 'Use the observatory tool on this project to carry out the instructions below. '
                : '[Observatory command] Use the observatory tool to carry out the instructions below '
                  + '(create a project first if none fits). ')
                + 'Prefer background jobs with the checkpoint.json convention for anything long, and '
                + 'report back what you started, changed, or found.\n\n'
                + instructions;

            turn = await ctx.chat.startTurn({
                client: ctx.client,
                gateway: ctx.gateway,
                userId,
                userName: req.webUser.userName,
                message,
                conversationId: await observatoryConversationId(
                    userId, project ? `🔭 ${project.name}` : '🔭 Observatory')
            });
        } catch (error) {
            const status = error.status || 500;
            sendError(res, status, error.code || 'INTERNAL',
                status === 500 ? 'Something went wrong.' : error.message,
                error.details || null);
            return;
        }
        await streamWebChatTurn(res, turn);
    });

    app.delete('/api/app/observatory/projects/:slug', requireAuth, chatRoute(async (req) =>
        ctx.observatory.deleteProject({
            userId: req.webUser.userId,
            project: req.params.slug
        })
    ));

    app.post('/api/app/observatory/jobs/:jobId/cancel', requireAuth, chatRoute(async (req) =>
        ctx.observatory.cancel({
            userId: req.webUser.userId,
            jobId: req.params.jobId
        })
    ));

    app.post('/api/app/observatory/jobs/:jobId/resume', requireAuth, chatRoute(async (req) =>
        ctx.observatory.resume({
            userId: req.webUser.userId,
            jobId: req.params.jobId,
            client: ctx.gateway
        })
    ));

    // Stitch the project's frames now (the dashboard's Render button)
    app.post('/api/app/observatory/projects/:slug/render', requireAuth, chatRoute(async (req) =>
        ctx.observatory.render({
            userId: req.webUser.userId,
            project: req.params.slug,
            fps: req.body?.fps ?? null
        })
    ));

    // The owner's live dashboard page (regenerated when stale; ?fresh=1
    // forces). Server-generated trusted HTML - never snippet-authored.
    app.get('/api/app/observatory/projects/:slug/dashboard', requireAuth, (req, res) => {
        try {
            const { html } = ctx.observatory.getDashboard({
                userId: req.webUser.userId,
                project: req.params.slug,
                force: req.query.fresh === '1'
            });
            res.status(200).type('html').send(html);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Observatory dashboard failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // Dashboard share links: create (idempotent), inspect, revoke.
    app.post('/api/app/observatory/projects/:slug/share', requireAuth, chatRoute(async (req) =>
        ctx.observatory.createShareLink({
            userId: req.webUser.userId,
            project: req.params.slug
        })
    ));

    app.get('/api/app/observatory/projects/:slug/share', requireAuth, chatRoute(async (req) =>
        ctx.observatory.getShareLink({
            userId: req.webUser.userId,
            project: req.params.slug
        })
    ));

    app.delete('/api/app/observatory/projects/:slug/share', requireAuth, chatRoute(async (req) =>
        ctx.observatory.revokeShareLink({
            userId: req.webUser.userId,
            project: req.params.slug
        })
    ));

    // Owner-only workspace file reader for the applet capability bridge.
    // Not public-share infrastructure: requireAuth + service ownership.
    // Express 4 splat lands in req.params[0].
    app.get('/api/app/observatory/projects/:slug/content/*', requireAuth, async (req, res) => {
        try {
            const file = await ctx.observatory.readWorkspaceFile({
                userId: req.webUser.userId,
                slug: req.params.slug,
                relativePath: req.params[0]
            });
            res.status(200)
                .set({
                    'Content-Type': file.mime,
                    'Content-Length': file.size,
                    'Cache-Control': 'private, no-store',
                    'X-Content-Type-Options': 'nosniff',
                    'Content-Disposition': `inline; filename="${String(file.name).replace(/["\r\n]/g, '')}"`
                })
                .send(file.bytes);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Observatory content read failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // --- Project assets (versioned apps / scripts / notes) -------------------
    // Auth + error contract match the Observatory routes: requireAuth and
    // chatRoute (status+code from ProjectAssetError). Ownership is
    // service-level (userId + project slug).

    app.get('/api/app/projects/:slug/assets', requireAuth, chatRoute(async (req) => ({
        assets: await ctx.projectAssets.list({
            userId: req.webUser.userId,
            project: req.params.slug,
            kind: req.query.kind || null
        })
    })));

    app.post('/api/app/projects/:slug/assets', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.save({
            userId: req.webUser.userId,
            project: req.params.slug,
            slug: req.body?.slug,
            name: req.body?.name,
            kind: req.body?.kind,
            language: req.body?.language,
            source: req.body?.source,
            note: req.body?.note,
            origin: req.body?.origin || 'portal',
            conversationId: req.body?.conversationId,
            messageId: req.body?.messageId,
            grants: req.body?.grants
        })
    ));

    app.get('/api/app/projects/:slug/assets/:asset', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.get({
            userId: req.webUser.userId,
            project: req.params.slug,
            asset: req.params.asset,
            version: req.query.version ?? null
        })
    ));

    app.patch('/api/app/projects/:slug/assets/:asset', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.update({
            userId: req.webUser.userId,
            project: req.params.slug,
            asset: req.params.asset,
            name: req.body?.name,
            grants: req.body?.grants
        })
    ));

    app.delete('/api/app/projects/:slug/assets/:asset', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.delete({
            userId: req.webUser.userId,
            project: req.params.slug,
            asset: req.params.asset
        })
    ));

    app.get('/api/app/projects/:slug/assets/:asset/versions', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.listVersions({
            userId: req.webUser.userId,
            project: req.params.slug,
            asset: req.params.asset
        })
    ));

    app.get('/api/app/projects/:slug/assets/:asset/versions/:n', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.get({
            userId: req.webUser.userId,
            project: req.params.slug,
            asset: req.params.asset,
            version: req.params.n
        })
    ));

    app.post('/api/app/projects/:slug/assets/:asset/rollback', requireAuth, chatRoute(async (req) =>
        ctx.projectAssets.rollback({
            userId: req.webUser.userId,
            project: req.params.slug,
            asset: req.params.asset,
            version: req.body?.version
        })
    ));

    // --- Project triggers (cron / event automations) ------------------------
    app.get('/api/app/projects/:slug/triggers', requireAuth, chatRoute(async (req) => ({
        triggers: await ctx.projectTriggers.list({
            userId: req.webUser.userId,
            project: req.params.slug
        })
    })));

    app.get('/api/app/projects/:slug/triggers/:trigger', requireAuth, chatRoute(async (req) =>
        ctx.projectTriggers.get({
            userId: req.webUser.userId,
            project: req.params.slug,
            trigger: req.params.trigger
        })
    ));

    app.post('/api/app/projects/:slug/triggers', requireAuth, chatRoute(async (req) => {
        return ctx.projectTriggers.create({
            userId: req.webUser.userId,
            project: req.params.slug,
            name: req.body?.name,
            kind: req.body?.kind,
            schedule: req.body?.schedule,
            eventTopic: req.body?.eventTopic,
            action: req.body?.action,
            actionAssetId: req.body?.actionAssetId,
            actionAsset: req.body?.actionAsset,
            actionParams: req.body?.actionParams,
            isEnabled: req.body?.isEnabled
        });
    }));

    app.patch('/api/app/projects/:slug/triggers/:trigger', requireAuth, chatRoute(async (req) =>
        ctx.projectTriggers.update({
            userId: req.webUser.userId,
            project: req.params.slug,
            trigger: req.params.trigger,
            name: req.body?.name,
            kind: req.body?.kind,
            schedule: req.body?.schedule,
            eventTopic: req.body?.eventTopic,
            action: req.body?.action,
            actionAssetId: req.body?.actionAssetId,
            actionAsset: req.body?.actionAsset,
            actionParams: req.body?.actionParams,
            isEnabled: req.body?.isEnabled
        })
    ));

    app.delete('/api/app/projects/:slug/triggers/:trigger', requireAuth, chatRoute(async (req) =>
        ctx.projectTriggers.delete({
            userId: req.webUser.userId,
            project: req.params.slug,
            trigger: req.params.trigger
        })
    ));

    // --- Spitball Expeditions (autonomous research over the user's graph) ----
    // User-scoped personal data: expeditions write only into the requesting
    // user's personal Spitball scope, so plain requireAuth plus the service's
    // ownership checks are the whole access model. chatRoute translates
    // SpitballError's status+code contract.

    // Lens presets and depth budgets, for the start-expedition form
    app.get('/api/app/spitball/lenses', requireAuth, chatRoute(async () => ({
        lenses: spitballLensConfig.listLenses(),
        defaultLensId: spitballLensConfig.DEFAULT_LENS_ID,
        depths: spitballConfig.DEPTH_PRESETS,
        defaultDepth: spitballConfig.DEFAULT_DEPTH
    })));

    app.get('/api/app/spitball/expeditions', requireAuth, chatRoute(async (req) => ({
        expeditions: await ctx.spitball.listExpeditions({
            userId: req.webUser.userId,
            status: req.query.status || null
        })
    })));

    app.post('/api/app/spitball/expeditions', requireAuth, chatRoute(async (req) => {
        const expedition = await ctx.spitball.createExpedition({
            userId: req.webUser.userId,
            seed: req.body?.seed ?? req.body?.topic,
            lensId: req.body?.lensId ?? null,
            lensText: req.body?.lensText ?? null,
            intent: req.body?.intent ?? null,
            depth: req.body?.depth ?? undefined
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

    // Everything the Decks pane renders, in one shape
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

    /** Translate IntegrationError into JSON; everything else is a 500. */
    function integrationRoute(handler) {
        return async (req, res) => {
            try {
                res.json(await handler(req));
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(res, error.status, error.code, error.message, error.details || null);
                    return;
                }
                ctx.logger.error?.('Integration route failed:', error.message);
                sendError(res, 500, 'INTERNAL', 'Something went wrong.');
            }
        };
    }

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

    /** Translate WebDashboardError into JSON; everything else is a 500. */
    function dashboardRoute(handler) {
        return async (req, res) => {
            try {
                res.json(await handler(req));
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(res, error.status, error.code, error.message, error.details || null);
                    return;
                }
                ctx.logger.error?.('Web dashboard route failed:', error.message);
                sendError(res, 500, 'INTERNAL', 'Something went wrong.');
            }
        };
    }

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
            confirm: req.body?.confirm
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

    // Workshop applets (pinned copies + discovered fences from chat)
    function appletRoute(handler) {
        return async (req, res) => {
            try {
                res.json(await handler(req));
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(res, error.status, error.code, error.message, error.details || null);
                    return;
                }
                ctx.logger.error?.('Web applet route failed:', error.message);
                sendError(res, 500, 'INTERNAL', 'Something went wrong.');
            }
        };
    }

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

    /**
     * Translate WebExchangeError (and the domain errors it wraps) into JSON;
     * everything else is a 500. Every handler is guild-scoped: the service
     * verifies live guild membership through the bot client before it reads
     * or moves a single point.
     */
    function exchangeRoute(handler) {
        return async (req, res) => {
            try {
                res.json(await handler(req));
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(res, error.status, error.code, error.message, error.details || null);
                    return;
                }
                ctx.logger.error?.('Web exchange route failed:', error.message);
                sendError(res, 500, 'INTERNAL', 'Something went wrong.');
            }
        };
    }

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

    // --- The Parlor (multi-persona workspace) --------------------------------

    /** Translate ParlorError into JSON; everything else is a 500. */
    function parlorRoute(handler) {
        return async (req, res) => {
            try {
                res.json(await handler(req));
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(res, error.status, error.code, error.message, error.details || null);
                    return;
                }
                ctx.logger.error?.('Parlor route failed:', error.message);
                sendError(res, 500, 'INTERNAL', 'Something went wrong.');
            }
        };
    }

    app.get('/api/app/parlor/personas', requireAuth, parlorRoute(async (req) => ({
        personas: await ctx.parlor.listPersonas(req.webUser.userId)
    })));

    app.post('/api/app/parlor/personas', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.createPersona({
            ownerId: req.webUser.userId,
            name: req.body?.name,
            emoji: req.body?.emoji,
            color: req.body?.color,
            charter: req.body?.charter
        })
    ));

    app.patch('/api/app/parlor/personas/:personaId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.updatePersona({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            name: req.body?.name,
            emoji: req.body?.emoji,
            color: req.body?.color,
            charter: req.body?.charter
        })
    ));

    app.delete('/api/app/parlor/personas/:personaId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.deletePersona({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId
        })
    ));

    // Persona voice for Parlor Live: resolved through the ElevenLabs voice
    // library at save time, so a bad name fails here, never mid-session.
    // An empty voice clears back to the default pool.
    app.put('/api/app/parlor/personas/:personaId/voice', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.setPersonaVoice({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            voice: req.body?.voice
        })
    ));

    // The ElevenLabs voice library (feeds the persona voice picker)
    app.get('/api/app/parlor/voices', requireAuth, parlorRoute(async () => ({
        voices: await ctx.parlorLive.listVoices()
    })));

    // Whether live voice sessions are possible (no key = button hidden)
    app.get('/api/app/parlor/live/capabilities', requireAuth, parlorRoute(async () =>
        ctx.parlorLive.capabilities()
    ));

    app.get('/api/app/parlor/personas/:personaId/notes', requireAuth, parlorRoute(async (req) => ({
        notes: await ctx.parlor.listNotes({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            tagId: req.query.tagId ? Number(req.query.tagId) : null,
            q: req.query.q ? String(req.query.q) : null
        })
    })));

    app.post('/api/app/parlor/personas/:personaId/notes', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.createNote({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            title: req.body?.title,
            content: req.body?.content,
            tags: req.body?.tags
        })
    ));

    app.patch('/api/app/parlor/notes/:noteId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.updateNote({
            ownerId: req.webUser.userId,
            noteId: req.params.noteId,
            title: req.body?.title,
            content: req.body?.content,
            tags: req.body?.tags
        })
    ));

    app.delete('/api/app/parlor/notes/:noteId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.deleteNote({
            ownerId: req.webUser.userId,
            noteId: req.params.noteId
        })
    ));

    app.get('/api/app/parlor/personas/:personaId/tags', requireAuth, parlorRoute(async (req) => ({
        tags: await ctx.parlor.listTags({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId
        })
    })));

    app.post('/api/app/parlor/personas/:personaId/suggest-tags', requireAuth, parlorRoute(async (req) => ({
        tags: await ctx.parlor.suggestTags({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            title: req.body?.title,
            content: req.body?.content
        })
    })));

    app.get('/api/app/parlor/personas/:personaId/graph', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.getWorkspaceGraph({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId
        })
    ));

    app.get('/api/app/parlor/personas/:personaId/search', requireAuth, parlorRoute(async (req) => ({
        results: await ctx.parlor.searchNotes({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            query: String(req.query.q || ''),
            limit: req.query.limit ? Number(req.query.limit) : undefined
        })
    })));

    app.get('/api/app/parlor/conversations', requireAuth, parlorRoute(async (req) => ({
        conversations: await ctx.parlor.listConversations(req.webUser.userId)
    })));

    app.post('/api/app/parlor/conversations', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.createConversation({
            ownerId: req.webUser.userId,
            personaIds: req.body?.personaIds
        })
    ));

    app.patch('/api/app/parlor/conversations/:conversationId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.renameConversation({
            ownerId: req.webUser.userId,
            conversationId: req.params.conversationId,
            title: req.body?.title
        })
    ));

    app.delete('/api/app/parlor/conversations/:conversationId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.deleteConversation({
            ownerId: req.webUser.userId,
            conversationId: req.params.conversationId
        })
    ));

    app.put('/api/app/parlor/conversations/:conversationId/participants/:personaId', requireAuth,
        parlorRoute(async (req) =>
            ctx.parlor.setParticipant({
                ownerId: req.webUser.userId,
                conversationId: req.params.conversationId,
                personaId: req.params.personaId,
                present: true
            })
        ));

    app.delete('/api/app/parlor/conversations/:conversationId/participants/:personaId', requireAuth,
        parlorRoute(async (req) =>
            ctx.parlor.setParticipant({
                ownerId: req.webUser.userId,
                conversationId: req.params.conversationId,
                personaId: req.params.personaId,
                present: false
            })
        ));

    app.get('/api/app/parlor/conversations/:conversationId/messages', requireAuth, parlorRoute(async (req) => ({
        messages: await ctx.parlor.getMessages({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId,
            limit: req.query.limit,
            beforeId: req.query.beforeId ? Number(req.query.beforeId) : null
        })
    })));

    // --- Shared discussions (multi-user parlors) -----------------------------

    // The user's synced Discord friends (the roster the Activity collected;
    // the web app can never read relationships itself). Read-only: the
    // Activity is the collector, this is the mirror the portal shows. Each
    // friend carries an `online` flag - whether THEY are in the portal
    // right now (presenceService; Discord friendships are mutual, so this
    // mirrors what Discord itself shows friends). Polling this route also
    // keeps the caller's own session warm (requireAuth touches lastSeenAt).
    app.get('/api/app/friends', requireAuth, parlorRoute(async (req) => {
        const friends = await ctx.friends.listFriends(req.webUser.userId);
        const online = await ctx.presence.onlineIds(friends.map(friend => friend.id));
        return {
            friends: friends.map(friend => ({ ...friend, online: online.has(friend.id) })),
            syncedAt: await ctx.friends.lastSyncedAt(req.webUser.userId)
        };
    }));

    // The human roster of one discussion (owner also sees pending invites)
    app.get('/api/app/parlor/conversations/:conversationId/members', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.listMembers({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId
        })
    ));

    // Who the owner could invite: their synced Discord friends first, then
    // people they share a server with (the invite picker's source)
    app.get('/api/app/parlor/conversations/:conversationId/invitable', requireAuth,
        parlorRoute(async (req) =>
            ctx.parlor.listInvitable({
                gateway: ctx.gateway,
                ownerId: req.webUser.userId,
                conversationId: req.params.conversationId,
                q: req.query.q ? String(req.query.q) : null
            })
        ));

    // Invite a Discord friend (owner only). The bot DMs them accept/decline
    // buttons; the invite also appears in their web app invitation list.
    app.post('/api/app/parlor/conversations/:conversationId/invites', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.invite({
            gateway: ctx.gateway,
            ownerId: req.webUser.userId,
            ownerName: req.webUser.userName,
            conversationId: req.params.conversationId,
            inviteeId: req.body?.userId
        })
    ));

    // Withdraw a pending invitation (owner only)
    app.delete('/api/app/parlor/invites/:inviteId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.revokeInvite({
            ownerId: req.webUser.userId,
            inviteId: req.params.inviteId
        })
    ));

    // Pending invitations addressed to me
    app.get('/api/app/parlor/invites', requireAuth, parlorRoute(async (req) => ({
        invites: await ctx.parlor.listInvites(req.webUser.userId)
    })));

    // Accept or decline one of my invitations (the web path; the Discord DM
    // buttons settle invites through events/interactionCreate.js)
    app.post('/api/app/parlor/invites/:inviteId/respond', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.respondInvite({
            userId: req.webUser.userId,
            userName: req.webUser.userName,
            inviteId: req.params.inviteId,
            accept: req.body?.accept === true
        })
    ));

    // Owner removes a member; a member removes themself (leave)
    app.delete('/api/app/parlor/conversations/:conversationId/members/:memberId', requireAuth,
        parlorRoute(async (req) =>
            ctx.parlor.removeMember({
                userId: req.webUser.userId,
                conversationId: req.params.conversationId,
                memberId: req.params.memberId
            })
        ));

    // One-prompt bootstrap: the concierge designs a cast of personas (with
    // seed notes) for the topic and opens a discussion with them.
    app.post('/api/app/parlor/quickstart', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.quickstart({
            ownerId: req.webUser.userId,
            prompt: req.body?.prompt
        })
    ));

    app.post('/api/app/parlor/stop', requireAuth, parlorRoute(async (req) => ({
        stopped: ctx.parlor.stopTurn(req.webUser.userId)
    })));

    /**
     * Stream one reserved parlor turn back as Server-Sent Events:
     *   start           { conversationId }
     *   user_message    { id, content, ... }        the stored user message
     *   persona_start   { id, name, emoji, color }  a persona began thinking
     *   persona_pass    { personaName, reason }     the gate chose silence
     *   delta           { text }                    streamed token delta
     *   persona_tool    { personaId, tools }        a tool round began (draft resets)
     *   persona_message { content, grounding, attachments, ... } a completed reply
     *   learned         { personaId, notes }        write-back filed new notes
     *   done            { ok }
     *   error           { code, message }
     */
    async function streamParlorTurn(res, turn) {
        res.status(200).set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();

        let open = true;
        const send = (event, data) => {
            if (!open) return;
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const heartbeat = setInterval(() => {
            if (open) res.write(': ping\n\n');
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref?.();
        // Same rule as web chat: the turn keeps running if the browser
        // disconnects (replies land in the transcript either way).
        res.on('close', () => { open = false; });

        // Live-session tap: when this conversation has a Parlor Live session,
        // forward the turn's events into it so typed turns render (and are
        // voiced) for everyone connected. Cosmetic - never breaks the turn.
        const observe = (event, data) => {
            try { ctx.parlorLive?.observeTurn(turn.conversationId, event, data); } catch { /* cosmetic */ }
        };
        const emit = (event, data) => {
            send(event, data);
            observe(event, data);
        };

        try {
            send('start', { conversationId: turn.conversationId });
            await turn.run({
                onUserMessage: (message) => emit('user_message', message),
                onPersonaStart: (persona) => emit('persona_start', persona),
                onPersonaPass: (payload) => emit('persona_pass', payload),
                onDelta: (text) => emit('delta', { text }),
                onPersonaTool: (payload) => emit('persona_tool', payload),
                onPersonaMessage: (message) => emit('persona_message', message),
                onLearned: (payload) => emit('learned', payload)
            });
            emit('done', { ok: true, conversationId: turn.conversationId });
        } catch (error) {
            ctx.logger.error?.('Parlor turn failed:', error.message);
            emit('error', { code: 'INTERNAL', message: 'Something went wrong generating the replies.' });
        } finally {
            clearInterval(heartbeat);
            if (open) res.end();
        }
    }

    // One parlor turn: store the user message, then every participating
    // persona considers whether to speak and replies in seat order.
    app.post('/api/app/parlor/chat', requireAuth, async (req, res) => {
        let turn;
        try {
            turn = await ctx.parlor.startTurn({
                gateway: ctx.gateway,
                userId: req.webUser.userId,
                userName: req.webUser.userName,
                conversationId: req.body?.conversationId,
                message: req.body?.message
            });
        } catch (error) {
            const status = error.status || 500;
            sendError(res, status, error.code || 'INTERNAL',
                status === 500 ? 'Something went wrong.' : error.message);
            return;
        }
        await streamParlorTurn(res, turn);
    });

    // Manually trigger one seated persona to respond right now (no new
    // user message, no gate - the participant-chip "speak" action).
    app.post('/api/app/parlor/conversations/:conversationId/personas/:personaId/respond',
        requireAuth, async (req, res) => {
            let turn;
            try {
                turn = await ctx.parlor.startPersonaTurn({
                    userId: req.webUser.userId,
                    userName: req.webUser.userName,
                    conversationId: req.params.conversationId,
                    personaId: req.params.personaId
                });
            } catch (error) {
                const status = error.status || 500;
                sendError(res, status, error.code || 'INTERNAL',
                    status === 500 ? 'Something went wrong.' : error.message);
                return;
            }
            await streamParlorTurn(res, turn);
        });

    // --- The portal event stream ---------------------------------------------

    // One SSE stream multiplexing gateway-originated events (a follow-up
    // delivered, an automation ran, an agent run updated) plus server-side
    // invalidation hints. In the full deployment the events travel from the
    // bot through Postgres LISTEN/NOTIFY into this process; in the lite
    // single process they are the same in-process bus. This is what lets
    // the reactive client (Phase 4) stop polling.
    app.get('/api/app/events', requireAuth, (req, res) => {
        res.status(200).set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.flushHeaders();

        let open = true;
        const send = (event, data) => {
            if (!open) return;
            try {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            } catch { open = false; }
        };
        const heartbeat = setInterval(() => {
            if (open) res.write(': ping\n\n');
            // An open portal tab holds this stream; touching the session on
            // each beat is what keeps the user "online" for presenceService
            // (closing the tab lets it go stale within the window).
            if (open) ctx.sessions.touch?.(req.webSessionToken)
                ?.catch(() => { /* presence is cosmetic */ });
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref?.();

        send('hello', { userId: req.webUser.userId });

        // Strictly user-scoped: only events attributed to this session's
        // user are forwarded (events carry ids and hints, never content).
        const unsubscribe = ctx.events.subscribe((event) => {
            if (!event || event.payload?.userId !== req.webUser.userId) return;
            // Kind-level hints plus any scoped hints the publisher attached
            // (e.g. parlor-messages:<conversationId>, so only the affected
            // discussion's transcript refetches).
            const scoped = Array.isArray(event.payload?.invalidate) ? event.payload.invalidate : [];
            send(event.kind, {
                ...event.payload,
                at: event.at,
                invalidate: [...eventBusService.invalidationHints(event.kind), ...scoped]
            });
        });

        res.on('close', () => {
            open = false;
            clearInterval(heartbeat);
            unsubscribe();
        });
    });

    // Unknown API routes answer JSON, not the SPA fallback
    app.use('/api/app', (req, res) => {
        sendError(res, 404, 'NOT_FOUND', 'No such API route.');
    });

    // --- Static client -----------------------------------------------------

    // KaTeX (LaTeX rendering) is served straight from node_modules, the same
    // pattern as the embedded-app-sdk in activityApi.js - no bundler, and a
    // self-hosted instance needs no CDN. The client lazy-loads it only when a
    // message actually contains math.
    app.use('/app/vendor/katex', express.static(path.join(
        path.dirname(require.resolve('katex/package.json')),
        'dist'
    )));

    const reactDir = path.join(__dirname, '../../../apps/web/dist');
    const reactIndex = () => path.join(reactDir, 'index.html');
    const reactBuilt = () => fs.existsSync(reactIndex());

    // Shared Observatory dashboards - deliberately NO auth: the unguessable
    // token is the capability, and the self-contained page it unlocks
    // exposes no other file or route (control buttons stay inert because
    // the owner-session probe fails for viewers).
    app.get('/app/observatory/share/:token', async (req, res) => {
        try {
            const { html } = await ctx.observatory.getSharedDashboard(req.params.token);
            res.status(200).type('html').send(html);
        } catch (error) {
            if (error?.status && error?.code) {
                sendError(res, error.status, error.code, error.message);
                return;
            }
            ctx.logger.error?.('Shared observatory dashboard failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // Bookmarks to the strangler-era /app/next URL land on /app.
    app.get(/^\/app\/next(\/.*)?$/, (req, res) => {
        const rest = String(req.path || '').replace(/^\/app\/next\/?/, '');
        res.redirect(302, rest ? `/app/${rest}` : '/app/');
    });

    // The React client (apps/web/dist) is the only web client. Share links
    // (/app/share/<token>) are SPA routes like everything else. When the
    // build is missing, say so plainly instead of a bare 404.
    if (reactBuilt()) {
        app.use('/app', express.static(reactDir));
        app.get(['/app', '/app/*'], (req, res, next) => {
            if (path.extname(req.path)) return next();
            res.sendFile(reactIndex());
        });
    } else {
        app.get(['/app', '/app/*'], (req, res) => {
            sendError(res, 503, 'WEB_CLIENT_UNBUILT',
                'The web client is not built. Run npm run build:web.');
        });
    }

    return app;
}

// Live audio chunks are ~6s of base64 PCM at most; well below this cap.
const LIVE_WS_MAX_PAYLOAD = 2 * 1024 * 1024;
const LIVE_WS_HEARTBEAT_MS = 30 * 1000;

/**
 * Attach the web app's live WebSockets to an already-listening HTTP server:
 *  - /api/app/parlor/live  -> Parlor Live (multi-persona voice sessions)
 *  - /api/app/voice/live   -> Study voice chat streaming transcription
 * noServer + a path check on upgrade so they coexist with the Activity /
 * screen-vision / GBA sockets on the same server (the gbaRunApi pattern).
 *
 * Auth happens BEFORE the upgrade completes: the same httpOnly session
 * cookie the REST API uses must resolve to a live web session, and any
 * Origin header must match the request host (the router's CSRF rule -
 * browsers always send Origin on WebSocket handshakes). Discussion
 * membership is checked by the parlor service on 'join'.
 */
const LIVE_WS_PATHS = new Set(['/api/app/parlor/live', '/api/app/voice/live']);

function attachWebAppWebSocket(server, ctx) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: LIVE_WS_MAX_PAYLOAD });

    server.on('upgrade', async (request, socket, head) => {
        let pathname;
        try {
            pathname = new URL(request.url, 'http://localhost').pathname;
        } catch {
            return;
        }
        if (!LIVE_WS_PATHS.has(pathname)) return; // another handler's upgrade

        const reject = (status, label) => {
            try {
                socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\n\r\n`);
            } catch { /* already gone */ }
            socket.destroy();
        };

        const origin = request.headers.origin;
        if (origin) {
            let originHost;
            try {
                originHost = new URL(origin).host;
            } catch {
                originHost = null;
            }
            if (!originHost || originHost !== request.headers.host) {
                reject(403, 'Forbidden');
                return;
            }
        }
        const token = parseCookies(request)[SESSION_COOKIE];
        const session = token ? await ctx.sessions.get(token).catch(() => null) : null;
        if (!session) {
            reject(401, 'Unauthorized');
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, session, pathname);
        });
    });

    wss.on('connection', (socket, request, session, pathname) => {
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });
        if (pathname === '/api/app/voice/live') {
            ctx.voiceLive.handleConnection(socket, { userId: session.userId });
            return;
        }
        ctx.parlorLive.handleConnection(socket, {
            userId: session.userId,
            userName: session.userName,
            gateway: ctx.gateway
        });
    });

    // Protocol-level heartbeat: drop connections whose browser vanished
    // without a close frame. unref() so the timer never keeps the process
    // alive on its own (e.g. in tests).
    const heartbeat = setInterval(() => {
        for (const socket of wss.clients) {
            if (socket.isAlive === false) {
                socket.terminate();
                continue;
            }
            socket.isAlive = false;
            try { socket.ping(); } catch { /* closing */ }
        }
    }, LIVE_WS_HEARTBEAT_MS);
    heartbeat.unref?.();
    wss.on('close', () => clearInterval(heartbeat));

    return wss;
}

module.exports = { createWebAppContext, createWebAppApp, attachWebAppWebSocket };
