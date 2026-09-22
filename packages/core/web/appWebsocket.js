/**
 * Portal live WebSockets: Parlor Live and Study voice transcription.
 * Auth happens BEFORE the upgrade completes (same httpOnly session cookie
 * and Origin rule as the REST router).
 */

const { WebSocketServer } = require('ws');
const { parseCookies, SESSION_COOKIE } = require('./appHelpers');
const { authorizeSession, authorizedChannel, reserveConnection } = require('./liveAuthorization');

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
        const resolved = await authorizeSession(ctx, token).catch(() => null);
        const session = resolved?.session;
        if (!session) {
            reject(401, 'Unauthorized');
            return;
        }

        let lease;
        try { lease = await reserveConnection(session); }
        catch { reject(429, 'Too Many Connections'); return; }
        socket.once('close', () => { lease.release().catch(() => {}); });

        wss.handleUpgrade(request, socket, head, (ws) => {
            ws.authorize = async () => {
                if (!(await authorizeSession(ctx, token, session, () => ws.readyState === 1))) return false;
                await lease.renew();
                if (ws.authorizeResource) await ws.authorizeResource();
                return true;
            };
            wss.emit('connection', ws, request, session, pathname);
        });
    });

    wss.on('connection', (socket, request, session, pathname) => {
        const send = socket.send.bind(socket);
        const emit = socket.emit.bind(socket);
        const closeSocket = socket.close.bind(socket);
        const close = revoked => {
            if (revoked) { closeSocket(4001, 'Session or membership revoked'); socket.terminate(); }
        };
        const output = authorizedChannel({ authorize: socket.authorize, write: send, close });
        const input = authorizedChannel({
            authorize: socket.authorize,
            write: value => emit('message', Buffer.from(value), false), close
        });
        socket.send = value => output.send(value);
        socket.close = (...args) => { void output.flush().then(() => closeSocket(...args)); };
        socket.emit = (event, ...args) => {
            if (event === 'message') { input.send(args[0]); return true; }
            return emit(event, ...args);
        };
        socket.on('close', () => { input.stop(); output.stop(); });
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
