const crypto = require('node:crypto');
const db = require('../db');

// Pairing codes are short-lived and single-use (screen-vision pattern).
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
// Redeem attempts are globally throttled: codes are single-use with a
// short TTL, so anything past this rate is someone guessing.
const REDEEM_ATTEMPTS_PER_MINUTE = 10;
// Minimum gap between Discord posts per guild, plus a bounded queue so a
// runaway playbook cannot flood a channel. Excess posts are dropped with
// an ack error rather than buffered forever.
const DEFAULT_MIN_POST_INTERVAL_MS = 3000;
const MAX_QUEUED_POSTS = 20;
// GBA screenshots (even 4x upscaled) are tiny; this cap is generous.
const MAX_IMAGE_BASE64_LENGTH = 4 * 1024 * 1024;
const MAX_POST_TEXT_LENGTH = 1800;
// Live status embed edits are coalesced: the harness may report every
// turn (seconds apart), the embed updates at most this often.
const DEFAULT_STATUS_EDIT_INTERVAL_MS = 10000;
// Advice forwarded to the agent is short by design - it lands in a prompt.
const MAX_ADVICE_TEXT_LENGTH = 300;
const MILESTONE_EMBED_COLOR = 0xf1c40f; // gold
const STATUS_EMBED_COLOR = 0x5865f2;    // blurple

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * GBA run broadcasting — the Pi side of "Goobster Plays Pokémon" Phase 1
 * (design: documentation/goobster_plays_pokemon.md).
 *
 * A harness driver on another machine (see clients/gba-mcp/run-driver.js
 * and agent.js) holds an outbound WebSocket to Goobster and streams run
 * events: screenshots with captions, milestones (recorded in
 * gba_run_milestones and posted as gold embeds), and per-turn run status
 * that feeds a live-updating status embed (edited in place, coalesced).
 * In return, chatter in the bound channel flows back to the agent as
 * audience advice (Phase 3 inbox). Goobster never blocks on the harness:
 * when it is offline the run is simply paused, never an error
 * (screen-companion pattern).
 *
 * Pairing is guild-scoped and admin-gated (/gbarun link, Manage Server):
 * one harness per guild, bound to one broadcast channel. Only the SHA-256
 * of the client token is stored (gba_run_clients).
 *
 * The service is a singleton; web/server.js enables it at startup when
 * config.gbaRun.enabled is true. Disabled or with no client connected,
 * every entry point degrades to a no-op.
 */
class GbaRunService {
    constructor() {
        this.enabled = false;
        this.client = null; // Discord client, set by configure()
        this.logger = console;
        this.minPostIntervalMs = DEFAULT_MIN_POST_INTERVAL_MS;
        this.statusEditIntervalMs = DEFAULT_STATUS_EDIT_INTERVAL_MS;
        this.connections = new Map(); // guildId -> { socket, label, connectedAt, game, run }
        this.pairCodes = new Map();   // code -> { guildId, channelId, expiresAt }
        this._postQueues = new Map(); // guildId -> { queue: [], timer, lastPostAt }
        this._statusEdits = new Map(); // guildId -> { timer, lastEditAt, dirty }
        this._runSnapshots = new Map(); // guildId -> { game, run } - survives disconnects for the paused embed
        this._redeemAttempts = [];    // epoch ms of recent redeem attempts
    }

    configure({ enabled = false, client = null, logger = console, minPostIntervalMs, statusEditIntervalMs } = {}) {
        this.enabled = Boolean(enabled);
        this.client = client;
        this.logger = logger;
        if (Number.isFinite(minPostIntervalMs) && minPostIntervalMs >= 0) {
            this.minPostIntervalMs = minPostIntervalMs;
        }
        if (Number.isFinite(statusEditIntervalMs) && statusEditIntervalMs >= 0) {
            this.statusEditIntervalMs = statusEditIntervalMs;
        }
    }

    isEnabled() {
        return this.enabled;
    }

    /** Whether this guild has a live harness connection right now. */
    isConnected(guildId) {
        const conn = this.connections.get(String(guildId));
        return Boolean(conn && conn.socket.readyState === conn.socket.OPEN);
    }

    // ---------------------------------------------------------------- pairing

    /**
     * Create a one-time pairing code binding a guild to a broadcast
     * channel (via /gbarun link, Manage Server).
     * @returns {{ code: string, expiresAt: number }}
     */
    createPairingCode(guildId, channelId) {
        this._purgeExpiredCodes();
        // One outstanding code per guild
        for (const [code, entry] of this.pairCodes) {
            if (entry.guildId === String(guildId)) this.pairCodes.delete(code);
        }
        const raw = crypto.randomBytes(8);
        let code = '';
        for (let i = 0; i < 8; i++) {
            code += CODE_ALPHABET[raw[i] % CODE_ALPHABET.length];
            if (i === 3) code += '-';
        }
        const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
        this.pairCodes.set(code, { guildId: String(guildId), channelId: String(channelId), expiresAt });
        return { code, expiresAt };
    }

    /**
     * Exchange a pairing code for a harness token (called by the run
     * driver over HTTP). Codes are single-use; a new pairing replaces any
     * previous token for that guild.
     * @returns {{ token: string, guildId: string }}
     */
    redeemPairingCode(code, label = null) {
        this._throttleRedeem();
        this._purgeExpiredCodes();
        const normalized = String(code || '').trim().toUpperCase();
        const entry = this.pairCodes.get(normalized);
        if (!entry) {
            throw new Error('Invalid or expired pairing code. Run /gbarun link in Discord for a fresh one.');
        }
        this.pairCodes.delete(normalized);

        const token = crypto.randomBytes(32).toString('hex');
        db.run(
            `INSERT INTO gba_run_clients (guildId, channelId, tokenHash, label)
             VALUES (@guildId, @channelId, @tokenHash, @label)
             ON CONFLICT(guildId) DO UPDATE SET
                channelId = excluded.channelId,
                tokenHash = excluded.tokenHash,
                label = excluded.label,
                createdAt = datetime('now'),
                lastConnectedAt = NULL`,
            {
                guildId: entry.guildId,
                channelId: entry.channelId,
                tokenHash: hashToken(token),
                label: label ? String(label).slice(0, 64) : null
            }
        );
        // A re-pair invalidates the old token: drop any live connection using it.
        this._disconnect(entry.guildId, 'Re-paired from another harness');
        this.logger.info?.(`[GbaRun] Paired harness for guild ${entry.guildId} -> channel ${entry.channelId}`);
        return { token, guildId: entry.guildId };
    }

    /**
     * Remove a guild's pairing and disconnect its harness.
     * @returns {boolean} whether a pairing existed
     */
    unlink(guildId) {
        const { changes } = db.run('DELETE FROM gba_run_clients WHERE guildId = @guildId', { guildId: String(guildId) });
        this._disconnect(String(guildId), 'Unlinked from Discord');
        const entry = this._postQueues.get(String(guildId));
        if (entry?.timer) clearTimeout(entry.timer);
        this._postQueues.delete(String(guildId));
        const statusEntry = this._statusEdits.get(String(guildId));
        if (statusEntry?.timer) clearTimeout(statusEntry.timer);
        this._statusEdits.delete(String(guildId));
        this._runSnapshots.delete(String(guildId));
        return changes > 0;
    }

    /** Pairing + connection status for /gbarun status. */
    getStatus(guildId) {
        const row = db.get(
            'SELECT channelId, label, createdAt, lastConnectedAt FROM gba_run_clients WHERE guildId = @guildId',
            { guildId: String(guildId) }
        );
        const conn = this.connections.get(String(guildId));
        return {
            linked: Boolean(row),
            connected: this.isConnected(guildId),
            channelId: row?.channelId || null,
            label: row?.label || null,
            createdAt: row?.createdAt || null,
            lastConnectedAt: row?.lastConnectedAt || null,
            game: conn?.game || null
        };
    }

    // ------------------------------------------------------------ connection

    /**
     * Drive one harness WebSocket connection. The first message must be
     * { type: 'hello', token }; afterwards the client may send:
     *   { type: 'status', game }                        - shown in /gbarun status
     *   { type: 'post', seq?, text?, image?, filename? } - posted to the bound
     *     channel (image is base64 PNG); acked as { type: 'ack', seq, posted }
     */
    handleConnection(socket) {
        let guildId = null;

        const send = (message) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
        };

        const authTimeout = setTimeout(() => {
            if (!guildId) {
                send({ type: 'error', code: 'AUTH_TIMEOUT', message: 'No hello received' });
                socket.close();
            }
        }, 10000);

        socket.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                send({ type: 'error', code: 'BAD_MESSAGE', message: 'Messages must be JSON' });
                return;
            }

            if (!guildId) {
                if (message.type !== 'hello' || typeof message.token !== 'string') {
                    send({ type: 'error', code: 'AUTH_REQUIRED', message: 'First message must be a hello with a token' });
                    socket.close();
                    return;
                }
                const row = db.get(
                    'SELECT guildId, label FROM gba_run_clients WHERE tokenHash = @tokenHash',
                    { tokenHash: hashToken(message.token) }
                );
                if (!row) {
                    send({ type: 'error', code: 'AUTH_FAILED', message: 'Unknown token. Re-pair with /gbarun link.' });
                    socket.close();
                    return;
                }
                clearTimeout(authTimeout);
                guildId = row.guildId;
                // One connection per guild: newest wins
                this._disconnect(guildId, 'Replaced by a newer connection');
                this.connections.set(guildId, {
                    socket,
                    label: row.label,
                    connectedAt: Date.now(),
                    game: null
                });
                db.run(
                    `UPDATE gba_run_clients SET lastConnectedAt = datetime('now') WHERE guildId = @guildId`,
                    { guildId }
                );
                send({ type: 'ready', guildId });
                this.logger.info?.(`[GbaRun] Harness connected for guild ${guildId}`);
                return;
            }

            if (message.type === 'status') {
                const conn = this.connections.get(guildId);
                if (conn && message.game && typeof message.game === 'object') {
                    conn.game = {
                        title: typeof message.game.title === 'string' ? message.game.title.slice(0, 100) : null,
                        code: typeof message.game.code === 'string' ? message.game.code.slice(0, 8) : null
                    };
                }
                return;
            }

            if (message.type === 'post') {
                this._enqueuePost(guildId, message, send);
                return;
            }

            if (message.type === 'milestone') {
                this._handleMilestone(guildId, message, send);
                return;
            }

            if (message.type === 'run') {
                this._handleRunStatus(guildId, message);
                return;
            }
        });

        const cleanup = () => {
            clearTimeout(authTimeout);
            const conn = this.connections.get(guildId);
            if (conn && conn.socket === socket) {
                this.connections.delete(guildId);
                this.logger.info?.(`[GbaRun] Harness disconnected for guild ${guildId}`);
                // Best-effort: mark the live embed paused so the channel
                // isn't left with a stale "playing" status.
                this._markStatusPaused(guildId).catch(() => {});
            }
        };
        socket.on('close', cleanup);
        socket.on('error', cleanup);
    }

    // ---------------------------------------------------------- advice inbox

    /**
     * Called from events/messageCreate.js for guild messages that do NOT
     * explicitly address Goobster. When the message sits in a channel
     * bound to a CONNECTED run harness, it becomes audience advice: it is
     * forwarded to the agent, acked with a reaction, and consumed (the
     * rest of the chat pipeline is skipped so run chatter stays with the
     * run). Explicit mentions still reach normal chat.
     * @param {import('discord.js').Message} message
     * @returns {Promise<boolean>} whether the message was consumed as advice
     */
    async maybeCaptureAdvice(message) {
        if (!this.enabled || !message.guild) return false;
        const guildId = String(message.guild.id);
        const conn = this.connections.get(guildId);
        if (!conn || conn.socket.readyState !== conn.socket.OPEN) return false;

        const row = db.get('SELECT channelId FROM gba_run_clients WHERE guildId = @guildId', { guildId });
        if (!row || row.channelId !== String(message.channel.id)) return false;

        const text = (message.content || '').trim();
        if (!text) return false; // stickers/attachments-only: not advice

        const author = (message.member?.displayName || message.author.username || 'someone').slice(0, 64);
        try {
            conn.socket.send(JSON.stringify({
                type: 'advice',
                author,
                text: text.slice(0, MAX_ADVICE_TEXT_LENGTH)
            }));
        } catch (error) {
            this.logger.warn?.(`[GbaRun] Failed to forward advice for guild ${guildId}: ${error.message}`);
            return false;
        }
        message.react('📨').catch(() => {});
        return true;
    }

    // --------------------------------------------------------------- posting

    /**
     * Validate and queue a post; the queue enforces the per-guild rate
     * limit and acks each post back to the harness with the outcome.
     */
    _enqueuePost(guildId, message, send) {
        const seq = Number.isFinite(message.seq) ? message.seq : null;
        const ack = (posted, error = null) => send({ type: 'ack', seq, posted, ...(error ? { error } : {}) });

        const text = typeof message.text === 'string' ? message.text.slice(0, MAX_POST_TEXT_LENGTH) : '';
        const image = typeof message.image === 'string' ? message.image : null;
        if (!text && !image) {
            ack(false, 'post needs text and/or image');
            return;
        }
        if (image && (image.length === 0 || image.length > MAX_IMAGE_BASE64_LENGTH)) {
            ack(false, 'image payload missing or too large');
            return;
        }
        const filename = /^[\w.-]{1,64}\.png$/.test(message.filename || '') ? message.filename : 'gba-run.png';

        let entry = this._postQueues.get(guildId);
        if (!entry) {
            entry = { queue: [], timer: null, lastPostAt: 0 };
            this._postQueues.set(guildId, entry);
        }
        if (entry.queue.length >= MAX_QUEUED_POSTS) {
            ack(false, 'rate limited: post queue is full');
            return;
        }
        entry.queue.push({ text, image, filename, ack, style: message._style || 'post' });
        this._drainQueue(guildId);
    }

    /**
     * A milestone from the agent: recorded durably (the run's highlight
     * reel, /gbarun status, future bet settlement) and posted as a gold
     * embed through the same rate-limited queue as regular posts.
     */
    _handleMilestone(guildId, message, send) {
        const seq = Number.isFinite(message.seq) ? message.seq : null;
        const text = typeof message.text === 'string' ? message.text.trim().slice(0, MAX_POST_TEXT_LENGTH) : '';
        if (!text) {
            send({ type: 'ack', seq, posted: false, error: 'milestone needs text' });
            return;
        }
        try {
            db.run(
                'INSERT INTO gba_run_milestones (guildId, turn, text) VALUES (@guildId, @turn, @text)',
                { guildId, turn: Number.isFinite(message.turn) ? message.turn : null, text }
            );
        } catch (error) {
            // Recording must never block the show; the post still goes out.
            this.logger.warn?.(`[GbaRun] Failed to record milestone for guild ${guildId}: ${error.message}`);
        }
        this._enqueuePost(guildId, { ...message, text, _style: 'milestone' }, send);
    }

    /** Recent milestones for /gbarun status (newest first). */
    getRecentMilestones(guildId, limit = 3) {
        return db.all(
            `SELECT turn, text, createdAt FROM gba_run_milestones
             WHERE guildId = @guildId ORDER BY id DESC LIMIT @limit`,
            { guildId: String(guildId), limit }
        );
    }

    _drainQueue(guildId) {
        const entry = this._postQueues.get(guildId);
        if (!entry || entry.timer || entry.queue.length === 0) return;

        const wait = Math.max(0, entry.lastPostAt + this.minPostIntervalMs - Date.now());
        entry.timer = setTimeout(() => {
            entry.timer = null;
            const post = entry.queue.shift();
            if (post) {
                entry.lastPostAt = Date.now();
                this._deliverPost(guildId, post)
                    .finally(() => this._drainQueue(guildId));
            }
        }, wait);
        entry.timer.unref?.();
    }

    /** Post one run event to the guild's bound channel. Never throws. */
    async _deliverPost(guildId, { text, image, filename, ack, style = 'post' }) {
        try {
            if (!this.enabled || !this.client) {
                ack(false, 'broadcasting is disabled');
                return;
            }
            const row = db.get('SELECT channelId FROM gba_run_clients WHERE guildId = @guildId', { guildId });
            if (!row) {
                ack(false, 'pairing was removed');
                return;
            }
            const channel = await this.client.channels.fetch(row.channelId).catch(() => null);
            if (!channel || !channel.isTextBased?.()) {
                ack(false, 'broadcast channel not found (was it deleted?)');
                return;
            }
            const payload = {};
            if (image) {
                payload.files = [{ attachment: Buffer.from(image, 'base64'), name: filename }];
            }
            if (style === 'milestone') {
                payload.embeds = [{
                    color: MILESTONE_EMBED_COLOR,
                    title: '🏅 Milestone',
                    description: text,
                    ...(image ? { image: { url: `attachment://${filename}` } } : {})
                }];
            } else if (text) {
                payload.content = text;
            }
            await channel.send(payload);
            ack(true);
        } catch (error) {
            this.logger.warn?.(`[GbaRun] Failed to post run event for guild ${guildId}: ${error.message}`);
            ack(false, `Discord post failed: ${error.message}`);
        }
    }

    // ---------------------------------------------------------- status embed

    /**
     * Per-turn run status from the agent. Stored on the connection and
     * coalesced into edits of one live embed message (created on first
     * status, id persisted so restarts keep editing the same message).
     */
    _handleRunStatus(guildId, message) {
        const conn = this.connections.get(guildId);
        if (!conn) return;
        conn.run = {
            turn: Number.isFinite(message.turn) ? message.turn : null,
            objective: typeof message.objective === 'string' ? message.objective.slice(0, 300) : null,
            phase: typeof message.phase === 'string' ? message.phase.slice(0, 32) : 'playing',
            stats: (message.stats && typeof message.stats === 'object') ? {
                presses: Number.isFinite(message.stats.presses) ? message.stats.presses : null,
                stuckResets: Number.isFinite(message.stats.stuckResets) ? message.stats.stuckResets : null,
                milestones: Number.isFinite(message.stats.milestones) ? message.stats.milestones : null
            } : {},
            image: (typeof message.image === 'string' && message.image.length > 0
                && message.image.length <= MAX_IMAGE_BASE64_LENGTH) ? message.image : null,
            at: Date.now()
        };
        // Snapshot survives the connection so the paused/ended embed keeps
        // the game title, final stats, and last screenshot.
        this._runSnapshots.set(guildId, { game: conn.game, run: conn.run });
        this._scheduleStatusEdit(guildId);
    }

    _scheduleStatusEdit(guildId) {
        let entry = this._statusEdits.get(guildId);
        if (!entry) {
            entry = { timer: null, lastEditAt: 0 };
            this._statusEdits.set(guildId, entry);
        }
        if (entry.timer) return; // an edit is already scheduled; it will use the latest run state
        const wait = Math.max(0, entry.lastEditAt + this.statusEditIntervalMs - Date.now());
        entry.timer = setTimeout(() => {
            entry.timer = null;
            entry.lastEditAt = Date.now();
            this._updateStatusEmbed(guildId).catch(error => {
                this.logger.warn?.(`[GbaRun] Status embed update failed for guild ${guildId}: ${error.message}`);
            });
        }, wait);
        entry.timer.unref?.();
    }

    _buildStatusEmbed({ game, run, connected }) {
        const fields = [];
        if (run?.turn != null) fields.push({ name: 'Turn', value: String(run.turn), inline: true });
        if (run?.stats?.presses != null) fields.push({ name: 'Presses', value: String(run.stats.presses), inline: true });
        if (run?.stats?.stuckResets != null) fields.push({ name: 'Rewinds', value: String(run.stats.stuckResets), inline: true });
        if (run?.objective) fields.push({ name: 'Objective', value: run.objective });
        const paused = !connected || run?.phase === 'ended';
        return {
            color: paused ? 0x99aab5 : STATUS_EMBED_COLOR,
            title: `${paused ? '⏸️' : '🔴'} ${game?.title || 'GBA run'} — ${paused ? (run?.phase === 'ended' ? 'session over' : 'run paused') : 'live'}`,
            fields,
            ...(run?.image ? { image: { url: 'attachment://status.png' } } : {}),
            footer: { text: 'Goobster Plays · updates every few turns' },
            timestamp: new Date().toISOString()
        };
    }

    /** Create or edit the guild's live status embed. */
    async _updateStatusEmbed(guildId) {
        if (!this.enabled || !this.client) return;
        const row = db.get(
            'SELECT channelId, statusMessageId FROM gba_run_clients WHERE guildId = @guildId', { guildId });
        if (!row) return;
        const conn = this.connections.get(guildId);
        const snapshot = this._runSnapshots.get(guildId);
        const game = conn?.game || snapshot?.game;
        const run = conn?.run || snapshot?.run;

        const channel = await this.client.channels.fetch(row.channelId).catch(() => null);
        if (!channel || !channel.isTextBased?.()) return;

        const payload = {
            embeds: [this._buildStatusEmbed({
                game,
                run,
                connected: Boolean(conn)
            })],
            // Explicitly replace attachments so screenshots don't stack up.
            files: run?.image
                ? [{ attachment: Buffer.from(run.image, 'base64'), name: 'status.png' }]
                : [],
            attachments: []
        };

        if (row.statusMessageId) {
            const existing = await channel.messages.fetch(row.statusMessageId).catch(() => null);
            if (existing) {
                await existing.edit(payload);
                return;
            }
        }
        const created = await channel.send(payload);
        db.run('UPDATE gba_run_clients SET statusMessageId = @id WHERE guildId = @guildId',
            { id: created.id, guildId });
    }

    /** Flip the live embed to "paused" when the harness drops. */
    async _markStatusPaused(guildId) {
        const entry = this._statusEdits.get(guildId);
        if (entry?.timer) {
            clearTimeout(entry.timer);
            entry.timer = null;
        }
        // Only flip an embed that exists - a Phase 1 scripted run (no run
        // status messages) should not leave a "paused" embed behind.
        const row = db.get('SELECT statusMessageId FROM gba_run_clients WHERE guildId = @guildId', { guildId });
        if (!row?.statusMessageId) return;
        await this._updateStatusEmbed(guildId);
    }

    // ---------------------------------------------------------------- helpers

    _disconnect(guildId, reason) {
        const conn = this.connections.get(String(guildId));
        if (!conn) return;
        this.connections.delete(String(guildId));
        try {
            if (conn.socket.readyState === conn.socket.OPEN) {
                conn.socket.send(JSON.stringify({ type: 'error', code: 'DISCONNECTED', message: reason }));
            }
            conn.socket.close();
        } catch { /* already closing */ }
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

module.exports = new GbaRunService();
