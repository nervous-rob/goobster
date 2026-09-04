/**
 * Portal live WebSockets: Parlor Live and Study voice transcription.
 * Auth happens BEFORE the upgrade completes (same httpOnly session cookie
 * and Origin rule as the REST router).
 */

const { WebSocketServer } = require('ws');
const { parseCookies, SESSION_COOKIE } = require('./appHelpers');

const LIVE_WS_MAX_PAYLOAD = 2 * 1024 * 1024;
const LIVE_WS_HEARTBEAT_MS = 30 * 1000;
const LIVE_WS_PATHS = new Set(['/api/app/parlor/live', '/api/app/voice/live']);

/**
 * Attach the web app's live WebSockets to an already-listening HTTP server:
 *  - /api/app/parlor/live  -> Parlor Live (multi-persona voice sessions)
 *  - /api/app/voice/live   -> Study voice chat streaming transcription
 * noServer + a path check on upgrade so they coexist with the Activity /
 * screen-vision / GBA sockets on the same server (the gbaRunApi pattern).
 */
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

module.exports = { attachWebAppWebSocket };
