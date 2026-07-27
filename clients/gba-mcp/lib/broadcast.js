/**
 * Broadcast connection to Goobster for GBA runs (Phase 1 pipe, shared by
 * the scripted run driver and the Phase 2 agent).
 *
 * Speaks the gbaRunService WebSocket protocol: hello/ready handshake,
 * fire-and-forget status updates, and posts acked by seq. post() never
 * throws — a dead connection means the post is skipped and the run keeps
 * going (delivery is best-effort by design).
 *
 * Requires Node 22+ (built-in WebSocket).
 */

const fs = require('node:fs');

const ACK_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 15000;

function normalizeServerUrl(raw) {
    let base = String(raw || '').trim().replace(/\/+$/, '');
    if (base.startsWith('ws://')) base = 'http://' + base.slice(5);
    if (base.startsWith('wss://')) base = 'https://' + base.slice(6);
    if (!/^https?:\/\//.test(base)) base = 'https://' + base;
    return base;
}

class Broadcast {
    /**
     * @param {object} params
     * @param {string} params.server Goobster base URL
     * @param {string} params.token harness token from /gbarun link pairing
     * @param {(advice: { author: string, text: string }) => void} [params.onAdvice]
     *        audience advice forwarded from the broadcast channel (Phase 3)
     */
    constructor({ server, token, onAdvice = null }) {
        this.url = `${normalizeServerUrl(server).replace(/^http/, 'ws')}/api/gba-run/ws`;
        this.token = token;
        this.onAdvice = onAdvice;
        this.socket = null;
        this._seq = 0;
        this._acks = new Map(); // seq -> { resolve, timer }
        this.delivered = 0;
        this.failed = 0;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(this.url);
            const timer = setTimeout(() => reject(new Error('Timed out connecting to Goobster')), CONNECT_TIMEOUT_MS);
            socket.addEventListener('open', () => {
                socket.send(JSON.stringify({ type: 'hello', token: this.token }));
            });
            socket.addEventListener('message', event => {
                let message;
                try { message = JSON.parse(event.data); } catch { return; }
                if (message.type === 'ready') {
                    clearTimeout(timer);
                    this.socket = socket;
                    resolve();
                } else if (message.type === 'ack') {
                    const pending = this._acks.get(message.seq);
                    if (pending) {
                        this._acks.delete(message.seq);
                        clearTimeout(pending.timer);
                        pending.resolve(message);
                    }
                } else if (message.type === 'advice') {
                    if (this.onAdvice && typeof message.text === 'string' && message.text.trim()) {
                        try {
                            this.onAdvice({
                                author: typeof message.author === 'string' ? message.author : 'someone',
                                text: message.text
                            });
                        } catch { /* advice handlers must not kill the socket */ }
                    }
                } else if (message.type === 'error') {
                    clearTimeout(timer);
                    reject(new Error(`${message.code}: ${message.message}`));
                }
            });
            socket.addEventListener('close', () => {
                this.socket = null;
                for (const [seq, pending] of this._acks) {
                    clearTimeout(pending.timer);
                    pending.resolve({ posted: false, error: 'connection closed' });
                    this._acks.delete(seq);
                }
            });
            socket.addEventListener('error', () => {
                clearTimeout(timer);
                reject(new Error(`Cannot reach Goobster at ${this.url}`));
            });
        });
    }

    _isOpen() {
        return this.socket && this.socket.readyState === 1;
    }

    /** Fire-and-forget status update (game title for /gbarun status). */
    sendStatus(game) {
        if (this._isOpen()) {
            this.socket.send(JSON.stringify({ type: 'status', game }));
        }
    }

    /** Post text and/or an image; resolves with the ack (never rejects). */
    async post({ text, image, filename }) {
        return this._sendAcked('post', { text, image, filename });
    }

    /**
     * Report a milestone: recorded durably server-side and posted as a
     * highlighted embed. Resolves with the ack (never rejects).
     */
    async sendMilestone({ text, image, turn, filename }) {
        return this._sendAcked('milestone', { text, image, turn, filename });
    }

    /** Fire-and-forget per-turn run status (feeds the live status embed). */
    sendRunStatus({ turn, objective, phase, stats, image }) {
        if (this._isOpen()) {
            this.socket.send(JSON.stringify({ type: 'run', turn, objective, phase, stats, image }));
        }
    }

    async _sendAcked(type, payload) {
        if (!this._isOpen()) {
            try {
                await this.connect();
            } catch (error) {
                this.failed++;
                return { posted: false, error: error.message };
            }
        }
        const seq = ++this._seq;
        const ack = await new Promise(resolve => {
            const timer = setTimeout(() => {
                this._acks.delete(seq);
                resolve({ posted: false, error: 'ack timeout' });
            }, ACK_TIMEOUT_MS);
            this._acks.set(seq, { resolve, timer });
            this.socket.send(JSON.stringify({ type, seq, ...payload }));
        });
        if (ack.posted) this.delivered++;
        else this.failed++;
        return ack;
    }

    close() {
        try { this.socket?.close(); } catch { /* closing */ }
    }
}

/**
 * Resolve a saved pairing, or redeem a fresh /gbarun link code and save
 * it. Throws with a friendly message when neither is available.
 * @param {{ server?: string, code?: string, label?: string, configFile: string }} params
 * @returns {Promise<{ server: string, token: string, guildId: string }>}
 */
async function resolvePairing({ server, code, label, configFile }) {
    if (code) {
        if (!server) throw new Error('--code needs --server <goobster url> too');
        const base = normalizeServerUrl(server);
        const response = await fetch(`${base}/api/gba-run/pair`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code, label })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(`Pairing failed: ${body?.error?.message || response.status}`);
        }
        const pairing = { server: base, token: body.token, guildId: body.guildId };
        fs.writeFileSync(configFile, JSON.stringify(pairing, null, 2));
        return pairing;
    }
    try {
        const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (saved.server && saved.token) return saved;
    } catch { /* no saved pairing */ }
    throw new Error('No pairing found. Run /gbarun link in Discord, then start with --server <url> --code <code>.');
}

module.exports = { Broadcast, normalizeServerUrl, resolvePairing };
