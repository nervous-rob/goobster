/**
 * Discord Activity backend: OAuth token exchange, session management, and
 * the WebSocket table protocol. Mounted on the public health server ONLY
 * when config.activity.enabled is true (the Activity must be reachable by
 * Discord's proxy, so this is the one opt-in public surface).
 *
 * Auth model:
 *  - Real flow: the embedded client calls sdk.authorize() and POSTs the code
 *    to /api/activity/token; we exchange it (client secret) for an
 *    access_token, resolve the user via /users/@me, and issue a random
 *    session token. The access_token goes back to the client for
 *    sdk.authenticate() and is not stored.
 *  - Dev flow (config.activity.devMode): /api/activity/dev-session mints a
 *    session for an arbitrary identity so the game can be developed and
 *    tested in a plain browser without Discord. Never enable in production.
 *
 * Sessions are transient and re-derivable (a reconnecting client just
 *  re-authorizes), so an in-memory map is fine here.
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const express = require('express');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const economyService = require('../services/economyService');
const { generateMusic, resolveApiKey } = require('../services/voice/elevenLabsAudioService');

const DISCORD_API = 'https://discord.com/api';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// Casino background music: generated once via the ElevenLabs Music API and
// cached alongside the /playmusic mood tracks. Without an ElevenLabs key the
// endpoint 404s and the client simply plays no music.
const CASINO_MUSIC_FILE = path.join(process.cwd(), 'cache', 'music', 'casino.mp3');
const CASINO_MUSIC_LENGTH_MS = 120000;
const CASINO_MUSIC_PROMPT =
    'Smooth instrumental casino lounge jazz, relaxed mid-tempo swing with piano, ' +
    'upright bass, brushed drums and soft vibraphone, warm and unobtrusive background ' +
    'music for a card table, seamless loop with no intro or outro, no vocals';

let casinoMusicPromise = null;

/**
 * Return the cached casino track, generating it on first demand. Returns
 * null when music is unavailable (no API key). Concurrent callers share one
 * in-flight generation; a failed attempt clears so a later request retries.
 */
async function ensureCasinoMusic(ctx) {
    if (fs.existsSync(CASINO_MUSIC_FILE)) return CASINO_MUSIC_FILE;
    if (!resolveApiKey(ctx.config)) return null;

    if (!casinoMusicPromise) {
        casinoMusicPromise = (async () => {
            ctx.logger.info?.('Generating casino lounge music via ElevenLabs (one-time)...');
            const buffer = await generateMusic(CASINO_MUSIC_PROMPT, ctx.config, CASINO_MUSIC_LENGTH_MS);
            await fsp.mkdir(path.dirname(CASINO_MUSIC_FILE), { recursive: true });
            await fsp.writeFile(CASINO_MUSIC_FILE, buffer);
            ctx.logger.info?.(`Casino music cached at ${CASINO_MUSIC_FILE} (${buffer.length} bytes)`);
            return CASINO_MUSIC_FILE;
        })().catch(error => {
            casinoMusicPromise = null;
            throw error;
        });
    }
    return casinoMusicPromise;
}

/** Everything the activity backend needs, wired once at startup. */
function createActivityContext({ client, config, tableManager, logger = console }) {
    const activityConfig = config.activity || {};
    return {
        client,
        config,
        tableManager,
        logger,
        devMode: activityConfig.devMode === true,
        clientId: config.clientId,
        clientSecret: process.env.DISCORD_CLIENT_SECRET || activityConfig.clientSecret || null,
        sessions: new Map() // token -> { userId, name, createdAt }
    };
}

function createSession(ctx, { userId, name }) {
    // Prune expired sessions opportunistically
    const now = Date.now();
    for (const [token, session] of ctx.sessions) {
        if (now - session.createdAt > SESSION_TTL_MS) ctx.sessions.delete(token);
    }
    const token = crypto.randomBytes(24).toString('hex');
    ctx.sessions.set(token, { userId, name, createdAt: now });
    return token;
}

function getSession(ctx, token) {
    const session = token && ctx.sessions.get(token);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        ctx.sessions.delete(token);
        return null;
    }
    return session;
}

/**
 * Express app serving the activity client + auth API. Mounted at the root
 * of the public server; routes are namespaced under /activity and
 * /api/activity.
 */
function createActivityApp(ctx) {
    const app = express.Router();
    app.use(express.json({ limit: '16kb' }));

    // Client bootstrap info (nothing secret: the client id is public)
    app.get('/api/activity/config', (req, res) => {
        res.json({ clientId: ctx.clientId, devMode: ctx.devMode });
    });

    // OAuth code exchange (the only place the client secret is used)
    app.post('/api/activity/token', async (req, res) => {
        try {
            if (!ctx.clientSecret) {
                res.status(503).json({ error: 'Activity auth is not configured (missing client secret).' });
                return;
            }
            const code = String(req.body?.code || '');
            if (!code) {
                res.status(400).json({ error: 'Missing authorization code.' });
                return;
            }

            const tokenResponse = await axios.post(
                `${DISCORD_API}/oauth2/token`,
                new URLSearchParams({
                    client_id: ctx.clientId,
                    client_secret: ctx.clientSecret,
                    grant_type: 'authorization_code',
                    code
                }),
                { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
            );
            const accessToken = tokenResponse.data.access_token;

            const userResponse = await axios.get(`${DISCORD_API}/users/@me`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 10000
            });
            const user = userResponse.data;
            const name = user.global_name || user.username;
            const sessionToken = createSession(ctx, { userId: user.id, name });

            res.json({
                access_token: accessToken,
                session_token: sessionToken,
                user: { id: user.id, name }
            });
        } catch (error) {
            ctx.logger.error?.('Activity token exchange failed:', error.response?.data || error.message);
            res.status(502).json({ error: 'Discord token exchange failed.' });
        }
    });

    // Local development identity (never available unless explicitly enabled)
    app.post('/api/activity/dev-session', (req, res) => {
        if (!ctx.devMode) {
            res.status(403).json({ error: 'Dev sessions are disabled.' });
            return;
        }
        const userId = String(req.body?.userId || '').trim();
        const name = String(req.body?.name || 'dev player').trim().slice(0, 32);
        if (!/^\d{5,20}$/.test(userId)) {
            res.status(400).json({ error: 'userId must look like a Discord snowflake (digits).' });
            return;
        }
        const sessionToken = createSession(ctx, { userId, name });
        res.json({ session_token: sessionToken, user: { id: userId, name }, devMode: true });
    });

    // Looping background music for the casino (generated + cached on first
    // request). 404 = no music available; the client degrades silently.
    app.get('/api/activity/music/casino', async (req, res) => {
        try {
            const file = await ensureCasinoMusic(ctx);
            if (!file) {
                res.status(404).json({ error: 'Background music is not available (no ElevenLabs key).' });
                return;
            }
            res.sendFile(file);
        } catch (error) {
            ctx.logger.warn?.('Casino music generation failed:', error.message);
            res.status(502).json({ error: 'Background music generation failed.' });
        }
    });

    // The embedded-app-sdk is served from node_modules as-is: its ESM output
    // only uses relative imports (verified), so no bundler is needed. The
    // package's `exports` map hides ./output, so resolve via package.json.
    app.use('/activity/vendor/embedded-app-sdk', express.static(path.join(
        path.dirname(require.resolve('@discord/embedded-app-sdk/package.json')),
        'output'
    )));
    const clientDir = path.join(__dirname, 'activity');
    app.use('/activity', express.static(clientDir));
    // Discord's proxy loads the Activity iframe at the mapped ROOT path
    // ("/" plus frame_id query params), so the client must be served there
    // too. Static (not a redirect) keeps the query params intact. Registered
    // last so /api/activity and /activity keep precedence.
    app.use('/', express.static(clientDir));

    return app;
}

/**
 * Attach the table-game WebSocket protocol to an HTTP server
 * (path /api/activity/ws).
 *
 * Client -> server: { type: 'join', session, guildId, channelId }
 *                   { type: 'sit', seat? } { type: 'leave-seat' }
 *                   { type: 'action', action, amount?, seat? }
 * Server -> client: { type: 'joined', user, table, currencyName, balance }
 *                   { type: 'state'|'update', view, events?, balance }
 *                   { type: 'error', code, message }
 */
function attachActivityWebSocket(server, ctx) {
    const wss = new WebSocketServer({ server, path: '/api/activity/ws' });

    wss.on('connection', (socket) => {
        let joined = null; // { session, table, unsubscribe }

        const send = (message) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
        };
        const sendError = (code, message) => send({ type: 'error', code, message });

        socket.on('message', async (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                sendError('BAD_JSON', 'Messages must be JSON.');
                return;
            }

            try {
                if (message.type === 'join') {
                    await handleJoin(message);
                } else if (!joined) {
                    sendError('NOT_JOINED', 'Join a table first.');
                } else if (message.type === 'sit') {
                    act({ action: 'sit', seat: Number.isInteger(message.seat) ? message.seat : null });
                } else if (message.type === 'leave-seat') {
                    act({ action: 'leave' });
                } else if (message.type === 'action') {
                    const allowed = new Set(['bet', 'deal', 'hit', 'stand', 'double']);
                    if (!allowed.has(message.action)) {
                        sendError('BAD_ACTION', 'Unknown action.');
                        return;
                    }
                    act({
                        action: message.action,
                        amount: Number.isInteger(message.amount) ? message.amount : null
                    });
                } else {
                    sendError('BAD_TYPE', 'Unknown message type.');
                }
            } catch (error) {
                if (error?.code && error?.message) {
                    sendError(error.code, error.message);
                } else {
                    ctx.logger.error?.('Activity WS error:', error);
                    sendError('INTERNAL', 'Something went wrong.');
                }
            }
        });

        socket.on('close', () => {
            joined?.unsubscribe();
            joined = null;
        });

        async function handleJoin({ session: sessionToken, guildId, channelId }) {
            if (joined) {
                sendError('ALREADY_JOINED', 'Already at a table.');
                return;
            }
            const session = getSession(ctx, sessionToken);
            if (!session) {
                sendError('BAD_SESSION', 'Session expired - reload the Activity.');
                return;
            }
            guildId = String(guildId || '').trim();
            channelId = String(channelId || '').trim();
            if (!/^\d{5,20}$/.test(guildId) || !/^\d{5,20}$/.test(channelId)) {
                sendError('BAD_CONTEXT', 'Missing guild/channel context.');
                return;
            }

            // The user must actually be a member of the guild whose points
            // they are about to spend. Dev mode (local testing) skips this.
            if (!ctx.devMode) {
                const guild = ctx.client?.guilds?.cache?.get(guildId);
                if (!guild) {
                    sendError('UNKNOWN_GUILD', 'Goobster is not in that server.');
                    return;
                }
                try {
                    await guild.members.fetch(session.userId);
                } catch {
                    sendError('NOT_A_MEMBER', 'You are not a member of that server.');
                    return;
                }
            }

            const table = ctx.tableManager.getTable({ guildId, channelId, gameType: 'blackjack' });
            const subscriber = {
                userId: session.userId,
                name: session.name,
                send: (message) => send(decorate(message))
            };
            // Set before subscribing so the initial state carries a balance
            joined = { session, table, guildId, unsubscribe: () => {} };
            joined.unsubscribe = ctx.tableManager.subscribe(table, subscriber);

            const { currencyName } = economyService.getSettings(guildId);
            send(decorate({
                type: 'joined',
                user: { id: session.userId, name: session.name },
                currencyName,
                minBet: table.state.minBet,
                maxBet: table.state.maxBet
            }));
        }

        function act(params) {
            ctx.tableManager.act({
                table: joined.table,
                userId: joined.session.userId,
                name: joined.session.name,
                ...params
            });
        }

        // Attach the viewer's live balance to every outgoing table message
        function decorate(message) {
            if (!joined) return message;
            try {
                return {
                    ...message,
                    balance: economyService.getBalance(joined.guildId, joined.session.userId)
                };
            } catch {
                return message;
            }
        }
    });

    return wss;
}

module.exports = { createActivityContext, createActivityApp, attachActivityWebSocket };
