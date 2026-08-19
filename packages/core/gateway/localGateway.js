/**
 * LocalGateway: the DiscordGateway implementation that wraps a live
 * discord.js Client in the same process (the bot app, and the lite
 * single-process deployment).
 *
 * Every method returns plain JSON snapshots - never live discord.js
 * objects - so core services written against the gateway behave
 * identically whether the gateway is local or remote (reactive port
 * spec §6). The discord.js calls in here are the exact calls the web
 * services used to make directly; this class is the one sanctioned
 * place for them on web-reachable paths.
 */

const { GatewayUnavailableError } = require('./errors');

/** Bounds mirrored from friendService's picker guardrails. */
const MAX_SEARCH_LIMIT = 200;

/** JSON snapshot of a GuildMember (permissions as serialized names). */
function memberSnapshot(member) {
    if (!member) return null;
    let permissions = [];
    try {
        permissions = member.permissions?.toArray?.() || [];
    } catch { /* partial member - no permissions resolvable */ }
    return {
        id: member.id,
        displayName: member.displayName || member.user?.globalName || member.user?.username || null,
        username: member.user?.username || null,
        globalName: member.user?.globalName || null,
        bot: member.user?.bot === true,
        avatar: member.user?.displayAvatarURL?.({ size: 64 }) || null,
        permissions
    };
}

/** JSON snapshot of a guild. */
function guildSnapshot(guild) {
    if (!guild) return null;
    return {
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL?.({ size: 64 }) || null,
        memberCount: guild.memberCount ?? null
    };
}

class LocalGateway {
    /**
     * @param {import('discord.js').Client} client - the live client (or a
     *   client-shaped fake in tests)
     */
    constructor(client) {
        this.client = client || null;
    }

    /** Marker used by toGateway() to tell gateways from clients. */
    get isGoobsterGateway() { return true; }
    get kind() { return 'local'; }

    /** Whether the bot is connected (client ready enough to have a user). */
    async available() {
        return Boolean(this.client?.user);
    }

    /** The bot's own account, or null before the client is ready. */
    async botUser() {
        const user = this.client?.user;
        return user ? { id: user.id, username: user.username || 'Goobster' } : null;
    }

    _requireClient() {
        if (!this.client) {
            throw new GatewayUnavailableError();
        }
        return this.client;
    }

    /**
     * Membership snapshot: { guild, member }. guild is null when the bot is
     * not in that guild; member is null when the user is not a member.
     * Mirrors webGuildAccess's original cache-get + members.fetch exactly.
     */
    async getGuildMember(guildId, userId) {
        const client = this._requireClient();
        const guild = client.guilds?.cache?.get?.(guildId);
        if (!guild) return { guild: null, member: null };
        try {
            const member = await guild.members.fetch(userId);
            return { guild: guildSnapshot(guild), member: memberSnapshot(member) };
        } catch {
            return { guild: guildSnapshot(guild), member: null };
        }
    }

    /**
     * Live permission check (never cached anywhere - permission checks that
     * gate writes must always be fresh, spec §6). Uses the bitfield's own
     * has() - discord.js accepts permission names as strings.
     */
    async memberHasPermission(guildId, userId, permission) {
        const client = this._requireClient();
        const guild = client.guilds?.cache?.get?.(guildId);
        if (!guild) return false;
        try {
            const member = await guild.members.fetch(userId);
            return Boolean(member?.permissions?.has?.(permission));
        } catch {
            return false;
        }
    }

    /**
     * Guilds the user shares with the bot, with the caller's ManageGuild
     * bit resolved per guild (the webDashboardService.listScopes shape).
     * Unreachable guilds are skipped, never an error.
     */
    async listMutualGuilds(userId) {
        const client = this._requireClient();
        const guilds = [...(client.guilds?.cache?.values?.() || [])];
        const memberships = await Promise.allSettled(
            guilds.map(guild => guild.members.fetch(userId))
        );
        const out = [];
        for (let i = 0; i < guilds.length; i++) {
            if (memberships[i].status !== 'fulfilled') continue;
            const snapshot = guildSnapshot(guilds[i]);
            const manageGuild = Boolean(memberships[i].value?.permissions?.has?.('ManageGuild'));
            out.push({ ...snapshot, manageGuild });
        }
        return out;
    }

    /**
     * Batch member lookup (leaderboard naming): a map of userId -> member
     * snapshot; users who left (or can't be fetched) are simply absent.
     */
    async getGuildMembers(guildId, userIds) {
        const client = this._requireClient();
        const guild = client.guilds?.cache?.get?.(guildId);
        const out = {};
        if (!guild) return out;
        await Promise.all([...new Set(userIds)].map(async (userId) => {
            try {
                const member = await guild.members.fetch(userId);
                out[userId] = memberSnapshot(member);
            } catch { /* left the server or unfetchable */ }
        }));
        return out;
    }

    /**
     * Guild member search. With a query, a REST search (the member cache
     * may be partial); without one, a bounded read of the cache the
     * GuildMembers intent keeps warm (the friendService browse path).
     */
    async searchGuildMembers(guildId, { query = null, limit = 25 } = {}) {
        const client = this._requireClient();
        const guild = client.guilds?.cache?.get?.(guildId);
        if (!guild) return [];
        const bounded = Math.max(1, Math.min(Number(limit) || 25, MAX_SEARCH_LIMIT));
        try {
            const members = query
                ? await guild.members.fetch({ query, limit: bounded })
                : [...(guild.members?.cache?.values?.() || [])].slice(0, bounded);
            return [...(members.values?.() || members)].map(memberSnapshot).filter(Boolean);
        } catch {
            return [];
        }
    }

    /** Resolve any Discord user (parlor invites), or null when unknown. */
    async getUser(userId) {
        const client = this._requireClient();
        if (!client.users?.fetch) throw new GatewayUnavailableError();
        try {
            const user = await client.users.fetch(userId);
            return {
                id: user.id,
                username: user.username || null,
                globalName: user.globalName || null,
                bot: user.bot === true
            };
        } catch {
            return null;
        }
    }

    /**
     * Fire-and-report DM delivery (the dmSent:false convention): a failed
     * DM is reported, never thrown. Payload is a plain JSON message shape
     * ({ content?, embeds?, components?, files? }).
     */
    async sendDm(userId, payload) {
        const client = this.client;
        if (!client?.users?.fetch) return { ok: false, error: 'GATEWAY_UNAVAILABLE' };
        try {
            const user = await client.users.fetch(userId);
            const message = await user.send(payload);
            return { ok: true, channelId: message?.channelId || null, messageId: message?.id || null };
        } catch (error) {
            return { ok: false, error: error?.code ? String(error.code) : 'SEND_FAILED' };
        }
    }

    /** Fire-and-report channel send (same contract as sendDm). */
    async sendToChannel(channelId, payload) {
        const client = this.client;
        if (!client?.channels?.fetch) return { ok: false, error: 'GATEWAY_UNAVAILABLE' };
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel?.send) return { ok: false, error: 'NOT_SENDABLE' };
            const message = await channel.send(payload);
            return { ok: true, messageId: message?.id || null };
        } catch (error) {
            return { ok: false, error: error?.code ? String(error.code) : 'SEND_FAILED' };
        }
    }

    /**
     * The user's DM channel id (created if needed), or null when the user
     * can't be resolved / DMs can't be opened. Throws GatewayUnavailable
     * only when there is no client at all, mirroring the old
     * `!client?.users?.fetch` BOT_OFFLINE checks.
     */
    async resolveDmChannelId(userId) {
        const client = this.client;
        if (!client?.users?.fetch) throw new GatewayUnavailableError();
        try {
            const user = await client.users.fetch(userId);
            const channel = await user.createDM();
            return channel?.id || null;
        } catch {
            return null;
        }
    }

    /** Guild metadata, or null when the bot is not in that guild. */
    async guildMeta(guildId) {
        const client = this._requireClient();
        return guildSnapshot(client.guilds?.cache?.get?.(guildId));
    }
}

module.exports = { LocalGateway, memberSnapshot, guildSnapshot };
