/**
 * HTTP + WebSocket endpoints for the GBA run harness (Goobster Plays
 * Pokémon, Phase 1 — see documentation/goobster_plays_pokemon.md).
 *
 * Served on the public health server (same origin the Activity and
 * screen-vision endpoints use, so an existing tunnel covers it):
 *   POST /api/gba-run/pair - exchange a one-time /gbarun link code for a
 *                            long-lived harness token
 *   WS   /api/gba-run/ws   - the run driver's persistent connection
 *                            (hello/status/post protocol, handled by
 *                            services/gbaRunService.js)
 *
 * Everything is opt-in via config.gbaRun.enabled; without it neither
 * route exists.
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const gbaRunService = require('../services/gbaRunService');

// Posts carry one small upscaled GBA screenshot; far below this cap.
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

function createGbaRunApp({ logger = console } = {}) {
    const app = express.Router();

    app.post('/api/gba-run/pair', express.json({ limit: '4kb' }), (req, res) => {
        try {
            const { code, label } = req.body || {};
            const { token, guildId } = gbaRunService.redeemPairingCode(code, label);
            res.json({ token, guildId });
        } catch (error) {
            logger.warn?.(`[GbaRun] Pairing rejected: ${error.message}`);
            res.status(400).json({ error: { code: 'PAIRING_FAILED', message: error.message } });
        }
    });

    return app;
}

/**
 * Attach the harness WebSocket endpoint to an already-listening HTTP
 * server. Uses noServer + a path check on upgrade so it coexists with
 * the Activity and screen-vision WebSockets on the same server.
 */
function attachGbaRunWebSocket(server, { logger = console } = {}) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

    server.on('upgrade', (request, socket, head) => {
        let pathname;
        try {
            pathname = new URL(request.url, 'http://localhost').pathname;
        } catch {
            return;
        }
        if (pathname !== '/api/gba-run/ws') return; // another handler's upgrade
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    wss.on('connection', (socket) => {
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });
        gbaRunService.handleConnection(socket);
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

module.exports = { createGbaRunApp, attachGbaRunWebSocket };
