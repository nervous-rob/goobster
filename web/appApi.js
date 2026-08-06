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
const crypto = require('node:crypto');
const express = require('express');
const axios = require('axios');
const webSessionService = require('../services/webSessionService');
const webChatService = require('../services/webChatService');
const webDashboardService = require('../services/webDashboardService');

const DISCORD_API = 'https://discord.com/api';
const SESSION_COOKIE = 'goobster_web_session';
const STATE_COOKIE = 'goobster_oauth_state';
const SSE_HEARTBEAT_MS = 15000;

/** Everything the web app backend needs, wired once at startup. */
function createWebAppContext({ client, config, logger = console, deps = {} }) {
    const webappConfig = config.webapp || {};
    const publicUrl = typeof webappConfig.publicUrl === 'string'
        ? webappConfig.publicUrl.replace(/\/+$/, '')
        : null;
    return {
        client,
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
        dashboard: deps.dashboard || webDashboardService
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

function sendError(res, status, code, message) {
    res.status(status).json({ error: { code, message } });
}

/**
 * Express router serving the web app client + API. Mounted at the root of
 * the public server; routes are namespaced under /app and /api/app.
 */
function createWebAppApp(ctx) {
    const app = express.Router();
    // Scoped parser (activityApi pattern): a router-wide parser would eat
    // request bodies destined for the raw-body webhook receivers.
    app.use('/api/app', express.json({ limit: '256kb' }));

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
    function requireAuth(req, res, next) {
        const token = parseCookies(req)[SESSION_COOKIE];
        const session = token ? ctx.sessions.get(token) : null;
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
            const { token } = ctx.sessions.create({
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
    app.post('/api/app/auth/dev-session', (req, res) => {
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
        const { token } = ctx.sessions.create({ userId, userName: name });
        res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttributes(ctx, 30 * 24 * 60 * 60)}`);
        res.json({ user: { id: userId, name }, devMode: true });
    });

    app.post('/api/app/auth/logout', requireAuth, (req, res) => {
        ctx.sessions.destroy(req.webSessionToken);
        res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttributes(ctx, 0)}`);
        res.json({ ok: true });
    });

    // --- Session info ----------------------------------------------------

    app.get('/api/app/me', requireAuth, async (req, res) => {
        try {
            const scopes = await ctx.dashboard.listScopes({
                client: ctx.client,
                userId: req.webUser.userId
            });
            res.json({
                user: {
                    id: req.webUser.userId,
                    name: req.webUser.userName,
                    avatar: req.webUser.avatar
                        ? `https://cdn.discordapp.com/avatars/${req.webUser.userId}/${req.webUser.avatar}.png?size=64`
                        : null
                },
                bot: ctx.client?.user
                    ? { id: ctx.client.user.id, name: ctx.client.user.username }
                    : null,
                scopes,
                maxInputLength: ctx.chat.maxInputLength
            });
        } catch (error) {
            ctx.logger.error?.('Web app /me failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // --- Chat -------------------------------------------------------------

    app.get('/api/app/chat/history', requireAuth, (req, res) => {
        try {
            const history = ctx.chat.getHistory({
                userId: req.webUser.userId,
                limit: req.query.limit,
                beforeId: req.query.beforeId ? Number(req.query.beforeId) : null
            });
            res.json({ messages: history });
        } catch (error) {
            ctx.logger.error?.('Web app history failed:', error.message);
            sendError(res, 500, 'INTERNAL', 'Something went wrong.');
        }
    });

    // One chat turn, streamed back as Server-Sent Events:
    //   typing {}                     the bot started working
    //   delta  { text }               raw streamed token delta
    //   message{ content, attachments, isError }  a completed bot message
    //   done   { ok }                 the turn finished
    //   error  { code, message }      the turn failed mid-stream
    app.post('/api/app/chat', requireAuth, async (req, res) => {
        let turn;
        try {
            turn = ctx.chat.startTurn({
                client: ctx.client,
                userId: req.webUser.userId,
                userName: req.webUser.userName,
                message: req.body?.message
            });
        } catch (error) {
            // Validation failures happen before the stream starts, so they
            // can still be proper HTTP errors (400/409/429/503).
            const status = error.status || 500;
            sendError(res, status, error.code || 'INTERNAL',
                status === 500 ? 'Something went wrong.' : error.message);
            return;
        }

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
        // stored in history either way) - we just stop writing.
        req.on('close', () => { open = false; });

        try {
            await turn.run({
                onTyping: () => send('typing', {}),
                onDelta: (text) => send('delta', { text }),
                onMessage: (message) => send('message', message)
            });
            send('done', { ok: true });
        } catch (error) {
            ctx.logger.error?.('Web chat turn failed:', error.message);
            send('error', { code: 'INTERNAL', message: 'Something went wrong generating the reply.' });
        } finally {
            clearInterval(heartbeat);
            if (open) res.end();
        }
    });

    // Generated files (image tool output) - owner-only, transient registry
    app.get('/api/app/files/:fileId', requireAuth, (req, res) => {
        const file = ctx.chat.getFile(req.params.fileId, req.webUser.userId);
        if (!file) {
            sendError(res, 404, 'NOT_FOUND', 'File not found (it may have expired).');
            return;
        }
        res.sendFile(file.path);
    });

    // --- Memory dashboard --------------------------------------------------

    /** Translate WebDashboardError into JSON; everything else is a 500. */
    function dashboardRoute(handler) {
        return async (req, res) => {
            try {
                res.json(await handler(req));
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(res, error.status, error.code, error.message);
                    return;
                }
                ctx.logger.error?.('Web dashboard route failed:', error.message);
                sendError(res, 500, 'INTERNAL', 'Something went wrong.');
            }
        };
    }

    app.get('/api/app/memory/report', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.getReport({
            client: ctx.client,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId
        })
    ));

    app.get('/api/app/memory/memories', requireAuth, dashboardRoute(async (req) => ({
        memories: await ctx.dashboard.listMemories({
            client: ctx.client,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId,
            limit: req.query.limit
        })
    })));

    app.delete('/api/app/memory/memories/:memoryId', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.deleteMemory({
            client: ctx.client,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId,
            memoryId: req.params.memoryId
        })
    ));

    app.get('/api/app/memory/facts', requireAuth, dashboardRoute(async (req) => ({
        facts: await ctx.dashboard.listFacts({
            client: ctx.client,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId
        })
    })));

    app.delete('/api/app/memory/facts/:factId', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.deleteFact({
            client: ctx.client,
            scope: String(req.query.scope || ''),
            userId: req.webUser.userId,
            factId: req.params.factId
        })
    ));

    app.get('/api/app/graph', requireAuth, dashboardRoute((req) =>
        ctx.dashboard.getGraph({
            client: ctx.client,
            guildId: String(req.query.guildId || ''),
            userId: req.webUser.userId
        })
    ));

    // Unknown API routes answer JSON, not the SPA fallback
    app.use('/api/app', (req, res) => {
        sendError(res, 404, 'NOT_FOUND', 'No such API route.');
    });

    // --- Static client -----------------------------------------------------

    const clientDir = path.join(__dirname, 'app');
    app.use('/app', express.static(clientDir));

    return app;
}

module.exports = { createWebAppContext, createWebAppApp };
