/**
 * HTTP + WebSocket endpoints for the screen-vision companion app.
 *
 * Served on the public health server (same origin the Activity uses, so an
 * existing cloudflared tunnel covers it):
 *   GET  /companion        - install landing page (per-OS copy-paste
 *                            commands, pairing code prefilled via ?code=)
 *   GET  /companion.js     - the zero-dependency companion app itself, so
 *                            players never need to clone the repo
 *   POST /api/screen/pair  - exchange a one-time /screenvision link code
 *                            for a long-lived client token
 *   WS   /api/screen/ws    - the companion's persistent connection
 *                            (hello/capture/frame protocol, handled by
 *                            services/screenVisionService.js)
 *
 * Everything is opt-in via config.screenVision.enabled; without it neither
 * route exists and the public server keeps serving only what it did before.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');
const screenVisionService = require('@goobster/core/services/screenVisionService');

const COMPANION_SCRIPT = path.join(require('@goobster/core/runtimePaths').clientsDir, 'screen-companion', 'companion.js');
const COMPANION_PAGE = path.join(__dirname, 'screen-companion.html');

// A 4K PNG frame can get large; cap the socket payload well above the
// service-level base64 limit so oversized frames fail cleanly there.
const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

function createScreenVisionApp({ logger = console } = {}) {
    const app = express.Router();

    app.post('/api/screen/pair', express.json({ limit: '4kb' }), async (req, res) => {
        try {
            const { code, label } = req.body || {};
            const { token, userId } = await screenVisionService.redeemPairingCode(code, label);
            res.json({ token, userId });
        } catch (error) {
            logger.warn?.(`[ScreenVision] Pairing rejected: ${error.message}`);
            res.status(400).json({ error: { code: 'PAIRING_FAILED', message: error.message } });
        }
    });

    // Self-serve install: players download the single-file companion from
    // the bot itself, no repo clone or npm install needed. The page also
    // offers native .exe/.dmg downloads when a releases URL is configured
    // (injected here - the page is otherwise static).
    app.get('/companion', (req, res) => {
        fs.readFile(COMPANION_PAGE, 'utf8', (error, html) => {
            if (error) {
                res.status(500).send('Install page unavailable');
                return;
            }
            res.type('html').send(html.replace('__RELEASES_URL__', screenVisionService.releasesUrl || ''));
        });
    });
    app.get('/companion.js', (req, res) => {
        res.type('application/javascript; charset=utf-8');
        res.sendFile(COMPANION_SCRIPT);
    });

    return app;
}

/**
 * Attach the companion WebSocket endpoint to an already-listening HTTP
 * server. Uses noServer + a path check on upgrade so it coexists with the
 * Activity WebSocket on the same server.
 */
function attachScreenVisionWebSocket(server, { logger = console } = {}) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

    server.on('upgrade', (request, socket, head) => {
        let pathname;
        try {
            pathname = new URL(request.url, 'http://localhost').pathname;
        } catch {
            return;
        }
        if (pathname !== '/api/screen/ws') return; // another handler's upgrade
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    wss.on('connection', (socket) => {
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });
        screenVisionService.handleConnection(socket);
    });

    // Protocol-level heartbeat: drop connections whose client vanished
    // without a close frame (sleeping laptops, dead tunnels). unref() so
    // the timer never keeps the process alive on its own (e.g. in tests).
    const heartbeat = setInterval(() => {
        for (const socket of wss.clients) {
            if (socket.isAlive === false) {
                socket.terminate();
                continue;
            }
            socket.isAlive = false;
            try { socket.ping(); } catch { /* closing */ }
        }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    wss.on('close', () => clearInterval(heartbeat));

    return wss;
}

module.exports = { createScreenVisionApp, attachScreenVisionWebSocket };
