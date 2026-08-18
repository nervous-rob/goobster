const crypto = require('node:crypto');
const db = require('../db');
const memoryService = require('./memoryService');

// Pairing codes are short-lived and single-use.
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
// How long a capture request waits for the companion app to answer.
const DEFAULT_CAPTURE_TIMEOUT_MS = 8000;
// A frame captured this recently is reused instead of asking the client
// again (e.g. the same turn touching both the vision and memory paths).
const FRAME_CACHE_TTL_MS = 10 * 1000;
// Redeem attempts are globally throttled: codes are single-use with a short
// TTL, so anything past this rate is someone guessing.
const REDEEM_ATTEMPTS_PER_MINUTE = 10;
// Base64 payload cap for a single frame (~9 MB decoded).
const MAX_FRAME_BASE64_LENGTH = 12 * 1024 * 1024;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Screen vision: lets users run a small companion app on their gaming PC
 * that holds an outbound WebSocket to Goobster and answers on-demand
 * screenshot requests. When a paired user talks to Goobster (text chat or a
 * voice session), the current frame plus active-window metadata is attached
 * to the AI turn so answers are grounded in what's actually on screen.
 *
 * Privacy model: strictly opt-in (install + `/screenvision link`), frames
 * are captured only when the user addresses Goobster, kept in memory with a
 * short TTL, and never written to disk or the database. Only small text
 * summaries ("was playing X and asked Y") go to long-term memory.
 *
 * The service is a singleton so chat/voice paths can require it directly;
 * web/server.js enables it at startup when config.screenVision.enabled is
 * true. When disabled or with no client connected, every entry point
 * degrades to a no-op.
 */
class ScreenVisionService {
    constructor() {
        this.enabled = false;
        this.publicUrl = null;
        this.logger = console;
        this.connections = new Map(); // userId -> { socket, label, connectedAt, pending: Map }
        this.pairCodes = new Map();   // code -> { userId, expiresAt }
        this.frameCache = new Map();  // userId -> { frame, at }
        this._redeemAttempts = [];    // epoch ms of recent redeem attempts
        this._requestSeq = 0;
    }

    configure({ enabled = false, publicUrl = null, releasesUrl = null, logger = console } = {}) {
        this.enabled = Boolean(enabled);
        this.publicUrl = typeof publicUrl === 'string' && publicUrl.trim()
            ? publicUrl.trim().replace(/\/+$/, '')
            : null;
        // GitHub "latest release" URL whose assets are the packaged companion
        // binaries (built by .github/workflows/release-companion.yml). The
        // install page offers .exe/.dmg downloads when this is set.
        this.releasesUrl = typeof releasesUrl === 'string' && releasesUrl.trim()
            ? releasesUrl.trim().replace(/\/+$/, '')
            : null;
        this.logger = logger;
    }

    /**
     * Personal install link for /screenvision link: the bot-served landing
     * page with the pairing code prefilled. Null when the owner hasn't
     * configured screenVision.publicUrl.
     */
    getInstallUrl(code) {
        if (!this.publicUrl) return null;
        return `${this.publicUrl}/companion?code=${encodeURIComponent(code)}`;
    }

    isEnabled() {
        return this.enabled;
    }

    /** Whether this user has a live companion connection right now. */
    isConnected(userId) {
        const conn = this.connections.get(String(userId));
        return Boolean(conn && conn.socket.readyState === conn.socket.OPEN);
    }

    // ---------------------------------------------------------------- pairing

    /**
     * Create a one-time pairing code for a Discord user (via /screenvision
     * link). The user pastes it into the companion app, which exchanges it
     * for a long-lived token.
     * @returns {{ code: string, expiresAt: number }}
     */
    createPairingCode(userId) {
        this._purgeExpiredCodes();
        // One outstanding code per user
        for (const [code, entry] of this.pairCodes) {
            if (entry.userId === String(userId)) this.pairCodes.delete(code);
        }
        const raw = crypto.randomBytes(8);
        let code = '';
        for (let i = 0; i < 8; i++) {
            code += CODE_ALPHABET[raw[i] % CODE_ALPHABET.length];
            if (i === 3) code += '-';
        }
        const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
        this.pairCodes.set(code, { userId: String(userId), expiresAt });
        return { code, expiresAt };
    }

    /**
     * Exchange a pairing code for a client token (called by the companion
     * app over HTTP). Codes are single-use; a new pairing replaces any
     * previous token for that user.
     * @returns {{ token: string, userId: string }}
     */
    async redeemPairingCode(code, label = null) {
        this._throttleRedeem();
        this._purgeExpiredCodes();
        const normalized = String(code || '').trim().toUpperCase();
        const entry = this.pairCodes.get(normalized);
        if (!entry) {
            throw new Error('Invalid or expired pairing code. Run /screenvision link in Discord for a fresh one.');
        }
        this.pairCodes.delete(normalized);

        const token = crypto.randomBytes(32).toString('hex');
        await db.run(
            `INSERT INTO screen_vision_clients (userId, tokenHash, label)
             VALUES (@userId, @tokenHash, @label)
             ON CONFLICT(userId) DO UPDATE SET
                tokenHash = excluded.tokenHash,
                label = excluded.label,
                createdAt = datetime('now'),
                lastConnectedAt = NULL`,
            { userId: entry.userId, tokenHash: hashToken(token), label: label ? String(label).slice(0, 64) : null }
        );
        // A re-pair invalidates the old token: drop any live connection using it.
        this._disconnect(entry.userId, 'Re-paired from another client');
        this.logger.info?.(`[ScreenVision] Paired companion client for user ${entry.userId}`);
        return { token, userId: entry.userId };
    }

    /**
     * Remove a user's pairing and disconnect their client.
     * @returns {boolean} whether a pairing existed
     */
    async unlink(userId) {
        const { changes } = await db.run('DELETE FROM screen_vision_clients WHERE userId = @userId', { userId: String(userId) });
        this._disconnect(String(userId), 'Unlinked from Discord');
        this.frameCache.delete(String(userId));
        return changes > 0;
    }

    /** Pairing + connection status for /screenvision status. */
    async getStatus(userId) {
        const row = await db.get(
            'SELECT label, createdAt, lastConnectedAt FROM screen_vision_clients WHERE userId = @userId',
            { userId: String(userId) }
        );
        return {
            linked: Boolean(row),
            connected: this.isConnected(userId),
            label: row?.label || null,
            createdAt: row?.createdAt || null,
            lastConnectedAt: row?.lastConnectedAt || null
        };
    }

    // ------------------------------------------------------------ connection

    /**
     * Drive one companion WebSocket connection. The first message must be
     * { type: 'hello', token }; afterwards the server may send
     * { type: 'capture', requestId } and the client answers with
     * { type: 'frame', requestId, format, data, meta } or
     * { type: 'capture_error', requestId, message }.
     */
    handleConnection(socket) {
        let userId = null;

        const send = (message) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
        };

        const authTimeout = setTimeout(() => {
            if (!userId) {
                send({ type: 'error', code: 'AUTH_TIMEOUT', message: 'No hello received' });
                socket.close();
            }
        }, 10000);

        socket.on('message', async (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                send({ type: 'error', code: 'BAD_MESSAGE', message: 'Messages must be JSON' });
                return;
            }

            if (!userId) {
                if (message.type !== 'hello' || typeof message.token !== 'string') {
                    send({ type: 'error', code: 'AUTH_REQUIRED', message: 'First message must be a hello with a token' });
                    socket.close();
                    return;
                }
                const row = await db.get(
                    'SELECT userId, label FROM screen_vision_clients WHERE tokenHash = @tokenHash',
                    { tokenHash: hashToken(message.token) }
                );
                if (!row) {
                    send({ type: 'error', code: 'AUTH_FAILED', message: 'Unknown token. Re-pair with /screenvision link.' });
                    socket.close();
                    return;
                }
                clearTimeout(authTimeout);
                userId = row.userId;
                // One connection per user: newest wins
                this._disconnect(userId, 'Replaced by a newer connection');
                this.connections.set(userId, {
                    socket,
                    label: row.label,
                    connectedAt: Date.now(),
                    pending: new Map()
                });
                await db.run(
                    `UPDATE screen_vision_clients SET lastConnectedAt = datetime('now') WHERE userId = @userId`,
                    { userId }
                );
                send({ type: 'ready', userId });
                this.logger.info?.(`[ScreenVision] Companion connected for user ${userId}`);
                return;
            }

            if (message.type === 'frame' || message.type === 'capture_error') {
                const conn = this.connections.get(userId);
                const pending = conn?.pending.get(message.requestId);
                if (!pending) return; // late reply after timeout
                conn.pending.delete(message.requestId);
                clearTimeout(pending.timer);

                if (message.type === 'capture_error') {
                    pending.reject(new Error(message.message || 'Capture failed on the client'));
                    return;
                }
                if (typeof message.data !== 'string' || message.data.length === 0
                    || message.data.length > MAX_FRAME_BASE64_LENGTH) {
                    pending.reject(new Error('Frame payload missing or too large'));
                    return;
                }
                const format = /^image\/(png|jpeg|webp)$/.test(message.format) ? message.format : 'image/jpeg';
                const meta = (message.meta && typeof message.meta === 'object') ? message.meta : {};
                pending.resolve({
                    dataUrl: `data:${format};base64,${message.data}`,
                    meta: {
                        windowTitle: typeof meta.windowTitle === 'string' ? meta.windowTitle.slice(0, 200) : null,
                        appName: typeof meta.appName === 'string' ? meta.appName.slice(0, 100) : null
                    },
                    capturedAt: Date.now()
                });
            }
        });

        const cleanup = () => {
            clearTimeout(authTimeout);
            if (userId && this.connections.get(userId)?.socket === socket) {
                const conn = this.connections.get(userId);
                for (const pending of conn.pending.values()) {
                    clearTimeout(pending.timer);
                    pending.reject(new Error('Companion disconnected'));
                }
                this.connections.delete(userId);
                this.logger.info?.(`[ScreenVision] Companion disconnected for user ${userId}`);
            }
        };
        socket.on('close', cleanup);
        socket.on('error', cleanup);
    }

    // --------------------------------------------------------------- capture

    /**
     * Ask a user's companion app for a fresh frame of their screen.
     * Never throws: returns { dataUrl, meta, capturedAt } or null.
     */
    async captureFrame(userId, { timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS } = {}) {
        const id = String(userId);
        if (!this.enabled || !this.isConnected(id)) return null;

        const cached = this.frameCache.get(id);
        if (cached && Date.now() - cached.at < FRAME_CACHE_TTL_MS) {
            return cached.frame;
        }

        const conn = this.connections.get(id);
        const requestId = `cap-${++this._requestSeq}`;
        try {
            const frame = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    conn.pending.delete(requestId);
                    reject(new Error('Capture timed out'));
                }, timeoutMs);
                conn.pending.set(requestId, { resolve, reject, timer });
                conn.socket.send(JSON.stringify({ type: 'capture', requestId }));
            });
            this.frameCache.set(id, { frame, at: Date.now() });
            return frame;
        } catch (error) {
            this.logger.warn?.(`[ScreenVision] Capture failed for user ${id}: ${error.message}`);
            return null;
        }
    }

    // ---------------------------------------------------------------- context

    /**
     * Game metadata from Discord presence (Rich Presence details/state when
     * the game publishes them). Requires the GuildPresences intent, which
     * the bot already has. Returns e.g. "ELDEN RING - Exploring Leyndell"
     * or null.
     */
    getPresenceGame(member) {
        try {
            const activities = member?.presence?.activities || [];
            const playing = activities.find(a => a.type === 0); // ActivityType.Playing
            if (!playing) return null;
            const bits = [playing.name];
            if (playing.details) bits.push(playing.details);
            if (playing.state) bits.push(playing.state);
            return bits.join(' - ');
        } catch {
            return null;
        }
    }

    /**
     * Build the full screen context for one user: a live frame from their
     * companion app when connected, plus presence game metadata, plus a
     * ready-to-inject prompt line. Returns null when there is nothing to
     * add (feature off, no companion, not playing anything).
     */
    async buildUserScreenContext({ userId, userName, member }) {
        if (!this.enabled) return null;
        const presenceGame = this.getPresenceGame(member);
        const frame = await this.captureFrame(userId);
        if (!frame && !presenceGame) return null;

        let line;
        if (frame) {
            const metaBits = [
                frame.meta.appName ? `active app: ${frame.meta.appName}` : null,
                frame.meta.windowTitle ? `active window: "${frame.meta.windowTitle}"` : null,
                presenceGame ? `Discord presence: playing ${presenceGame}` : null
            ].filter(Boolean).join('; ');
            line = `A live screenshot of ${userName}'s screen is attached as an image${metaBits ? ` (${metaBits})` : ''}.`;
        } else {
            line = `${userName} is currently playing ${presenceGame} (per their Discord presence). You cannot see their screen (no companion app connected right now).`;
        }
        return { frame, presenceGame, line };
    }

    // ---------------------------------------------------------------- memory

    /**
     * Store a small text summary of a screen-assisted exchange in long-term
     * memory so Goobster can refer to it in later sessions ("last time you
     * were stuck on Margit..."). Fire-and-forget; frames themselves are
     * never persisted.
     */
    recordSessionMemory({ guildId, channelId, userId, userName, meta, presenceGame, question }) {
        try {
            const activity = meta?.appName || presenceGame || null;
            const windowBit = meta?.windowTitle ? ` (window: "${meta.windowTitle}")` : '';
            const trimmedQuestion = String(question || '').trim().slice(0, 300);
            if (!trimmedQuestion) return;
            const content = activity
                ? `While screen-sharing with Goobster, ${userName} was playing/using ${activity}${windowBit} and asked: "${trimmedQuestion}"`
                : `While screen-sharing with Goobster, ${userName} asked: "${trimmedQuestion}"`;
            memoryService.remember({
                guildId,
                channelId,
                authorId: userId,
                authorName: userName,
                content
            }).catch(() => {});
        } catch (error) {
            this.logger.warn?.(`[ScreenVision] Failed to record session memory: ${error.message}`);
        }
    }

    // --------------------------------------------------------------- helpers

    _disconnect(userId, reason) {
        const conn = this.connections.get(String(userId));
        if (!conn) return;
        try {
            if (conn.socket.readyState === conn.socket.OPEN) {
                conn.socket.send(JSON.stringify({ type: 'bye', message: reason }));
            }
            conn.socket.close();
        } catch { /* already gone */ }
        for (const pending of conn.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
        this.connections.delete(String(userId));
    }

    _purgeExpiredCodes() {
        const now = Date.now();
        for (const [code, entry] of this.pairCodes) {
            if (entry.expiresAt <= now) this.pairCodes.delete(code);
        }
    }

    _throttleRedeem() {
        const now = Date.now();
        this._redeemAttempts = this._redeemAttempts.filter(at => now - at < 60000);
        if (this._redeemAttempts.length >= REDEEM_ATTEMPTS_PER_MINUTE) {
            throw new Error('Too many pairing attempts. Wait a minute and try again.');
        }
        this._redeemAttempts.push(now);
    }
}

module.exports = new ScreenVisionService();
