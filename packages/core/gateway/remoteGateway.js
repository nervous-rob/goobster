/**
 * RemoteGateway: the DiscordGateway implementation for processes without a
 * Discord connection (apps/api). Every method is an HTTP call to the bot's
 * internal gateway API (/internal/gateway/*), authenticated with the
 * GOOBSTER_INTERNAL_TOKEN shared-secret header on a compose-internal
 * network. Responses are the same JSON snapshots LocalGateway produces.
 *
 * Caching rules (reactive port spec §6):
 *  - Positive membership snapshots and mutual-guild lists may be cached
 *    for up to 60s to keep the dashboard snappy.
 *  - memberHasPermission is NEVER cached - permission checks that gate
 *    writes must always be live.
 *  - The bot user is cached once resolved (a bot's identity never changes
 *    mid-process) and falls back to the configured application client id
 *    when the bot is down, so DM-scoped chat keeps working (degraded mode).
 *
 * Transport failures throw GatewayUnavailableError from read methods;
 * send methods follow the fire-and-report contract and resolve
 * { ok: false } instead.
 */

const { GatewayError, GatewayUnavailableError } = require('./errors');

const MEMBERSHIP_CACHE_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 1000;

class RemoteGateway {
    /**
     * @param {Object} options
     * @param {string} options.baseUrl - the bot's internal address (e.g. http://bot:3000)
     * @param {string} options.token - GOOBSTER_INTERNAL_TOKEN shared secret
     * @param {string|null} [options.fallbackBotUserId] - the Discord application
     *   client id (== the bot's user id), used when the bot is unreachable so
     *   DM-scoped surfaces keep working
     * @param {number} [options.timeoutMs]
     * @param {Object} [options.logger]
     */
    constructor({ baseUrl, token, fallbackBotUserId = null, timeoutMs = DEFAULT_TIMEOUT_MS, logger = console } = {}) {
        if (!baseUrl) throw new Error('RemoteGateway requires a baseUrl (GOOBSTER_GATEWAY_URL).');
        if (!token) throw new Error('RemoteGateway requires the shared internal token (GOOBSTER_INTERNAL_TOKEN).');
        this.baseUrl = String(baseUrl).replace(/\/+$/, '');
        this.token = token;
        this.fallbackBotUserId = fallbackBotUserId ? String(fallbackBotUserId) : null;
        this.timeoutMs = timeoutMs;
        this.logger = logger;
        this._botUser = null; // resolved once, kept for the life of the process
        this._membershipCache = new Map(); // key -> { value, expiresAt }
    }

    get isGoobsterGateway() { return true; }
    get kind() { return 'remote'; }

    async _request(method, path, body = undefined) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        timer.unref?.();
        let response;
        try {
            response = await fetch(`${this.baseUrl}/internal/gateway${path}`, {
                method,
                headers: {
                    'x-goobster-internal-token': this.token,
                    ...(body !== undefined ? { 'content-type': 'application/json' } : {})
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });
        } catch (error) {
            throw new GatewayUnavailableError(undefined, { cause: error });
        } finally {
            clearTimeout(timer);
        }
        if (response.status === 503) {
            throw new GatewayUnavailableError();
        }
        if (!response.ok) {
            let detail = null;
            try { detail = (await response.json())?.error; } catch { /* not JSON */ }
            throw new GatewayError(response.status, detail?.code || 'GATEWAY_HTTP_ERROR',
                detail?.message || `Internal gateway answered ${response.status}.`);
        }
        return await response.json();
    }

    _cached(key) {
        const entry = this._membershipCache.get(key);
        if (entry && entry.expiresAt > Date.now()) return entry;
        this._membershipCache.delete(key);
        return null;
    }

    _remember(key, value) {
        // Bound the cache so a scan over many users can't grow it forever.
        if (this._membershipCache.size > 5000) this._membershipCache.clear();
        this._membershipCache.set(key, { value, expiresAt: Date.now() + MEMBERSHIP_CACHE_MS });
        return value;
    }

    async available() {
        try {
            return (await this._request('GET', '/health')).available === true;
        } catch {
            return false;
        }
    }

    async botUser() {
        if (this._botUser) return this._botUser;
        try {
            const user = (await this._request('GET', '/bot-user')).botUser;
            if (user) this._botUser = user;
            return user;
        } catch (error) {
            if (this.fallbackBotUserId) {
                // Degraded mode: the application client id IS the bot's user
                // id, so DM-scoped surfaces keep working while the bot is out.
                return { id: this.fallbackBotUserId, username: 'Goobster' };
            }
            throw error;
        }
    }

    async getGuildMember(guildId, userId) {
        const key = `member:${guildId}:${userId}`;
        const cached = this._cached(key);
        if (cached) return cached.value;
        const result = await this._request('GET',
            `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`);
        // Only positive membership is cached: a user who just joined should
        // not be locked out for a minute by a cached negative.
        if (result?.member) this._remember(key, result);
        return result;
    }

    async memberHasPermission(guildId, userId, permission) {
        const result = await this._request('GET',
            `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}/has-permission`
            + `?permission=${encodeURIComponent(permission)}`);
        return result.hasPermission === true;
    }

    async listMutualGuilds(userId) {
        const key = `mutual:${userId}`;
        const cached = this._cached(key);
        if (cached) return cached.value;
        const result = await this._request('GET', `/users/${encodeURIComponent(userId)}/mutual-guilds`);
        return this._remember(key, result.guilds || []);
    }

    async getGuildMembers(guildId, userIds) {
        const result = await this._request('POST',
            `/guilds/${encodeURIComponent(guildId)}/members/lookup`, { userIds });
        return result.members || {};
    }

    async searchGuildMembers(guildId, { query = null, limit = 25 } = {}) {
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        params.set('limit', String(limit));
        const result = await this._request('GET',
            `/guilds/${encodeURIComponent(guildId)}/member-search?${params}`);
        return result.members || [];
    }

    async getUser(userId) {
        return (await this._request('GET', `/users/${encodeURIComponent(userId)}`)).user;
    }

    async sendDm(userId, payload) {
        try {
            return await this._request('POST', `/users/${encodeURIComponent(userId)}/dm`,
                { payload: serializePayload(payload) });
        } catch (error) {
            this.logger.warn?.(`[gateway] sendDm(${userId}) failed: ${error.message}`);
            return { ok: false, error: error.code || 'SEND_FAILED' };
        }
    }

    async sendToChannel(channelId, payload) {
        try {
            return await this._request('POST', `/channels/${encodeURIComponent(channelId)}/messages`,
                { payload: serializePayload(payload) });
        } catch (error) {
            this.logger.warn?.(`[gateway] sendToChannel(${channelId}) failed: ${error.message}`);
            return { ok: false, error: error.code || 'SEND_FAILED' };
        }
    }

    async resolveDmChannelId(userId) {
        return (await this._request('GET', `/users/${encodeURIComponent(userId)}/dm-channel`)).channelId;
    }

    async guildMeta(guildId) {
        const key = `guild:${guildId}`;
        const cached = this._cached(key);
        if (cached) return cached.value;
        const result = await this._request('GET', `/guilds/${encodeURIComponent(guildId)}`);
        if (result?.guild) this._remember(key, result.guild);
        return result.guild;
    }
}

/**
 * Flatten a discord.js-builder-bearing message payload into plain JSON
 * (builders expose toJSON, which JSON.stringify honors). The bot side
 * hands the plain shapes straight to channel.send - discord.js accepts
 * raw API objects for embeds and components.
 */
function serializePayload(payload) {
    if (typeof payload === 'string') return payload;
    return JSON.parse(JSON.stringify(payload));
}

module.exports = { RemoteGateway, serializePayload };
