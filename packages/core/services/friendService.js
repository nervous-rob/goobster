/**
 * Who a user can invite: their Discord friends, plus the people they share
 * a server with.
 *
 * Discord deliberately does not expose relationships to bots. The one
 * surface that can read a friend list is the Embedded App SDK's
 * getRelationships() running inside an Activity, with the
 * `relationships.read` scope (Social SDK terms, accepted per application in
 * the developer portal). So the Activity is the collector: on every load it
 * polls the SDK and POSTs the roster here, and this service caches it
 * (user_friends) so the plain web app - which can never read relationships
 * itself - can offer a real people picker.
 *
 * The cache is a snapshot, never authoritative: it refreshes on every
 * Activity load and is re-derivable by opening the Activity again. Because
 * a self-hosted Goobster may have no Activity (or no Social SDK terms
 * accepted), candidates ALSO come from the bot's own view - members of
 * guilds the user shares with Goobster - so the picker is useful with zero
 * Discord configuration and degrades gracefully instead of going empty.
 *
 * Errors use FriendError (HTTP status + machine-readable code, the
 * PanelError contract). Deleted by /forget-me (see privacyService).
 */

const db = require('../db');

// One person can have at most 1000 Discord friends; the cap is a sanity
// bound on a client-supplied payload, not a product limit.
const MAX_FRIENDS = 1000;
const MAX_NAME_LENGTH = 64;
const SNOWFLAKE_PATTERN = /^\d{5,20}$/;

// Discord relationship types (Embedded App SDK): 1 = friend. Everything
// else (pending in/out, blocked, implicit) is deliberately ignored - the
// picker is for people you actually know.
const RELATIONSHIP_FRIEND = 1;

// How many guilds to scan and how many people to return, so a user in
// large servers never turns the picker into a member dump.
const MAX_GUILDS_SCANNED = 20;
const MAX_CANDIDATES = 100;
const MAX_PER_GUILD = 200;
// Guild member search hits the REST API once per guild; only worth it for
// an explicit query, and only across a handful of servers.
const MAX_SEARCH_GUILDS = 8;
const SEARCH_FETCH_LIMIT = 25;

/** Machine-readable web app error (the PanelError contract). */
class FriendError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'FriendError';
        this.status = status;
        this.code = code;
    }
}

/** Discord CDN avatar URL from a stored avatar hash. */
function avatarUrl(userId, hash) {
    return hash ? `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=64` : null;
}

class FriendService {
    /**
     * Replace a user's cached friend roster with what the Activity just
     * read from the Embedded App SDK. The client proposes, the service
     * legalizes: only real friend relationships (type 1), only
     * snowflake-shaped ids, no bots, no self, bounded count and lengths.
     * @param {Object} params - { userId, relationships }
     * @returns {{ friends: number, syncedAt: string }}
     */
    syncRelationships({ userId, relationships }) {
        if (!SNOWFLAKE_PATTERN.test(String(userId || ''))) {
            throw new FriendError(400, 'BAD_USER_ID', 'A Discord user id is required.');
        }
        const list = Array.isArray(relationships) ? relationships : [];
        const clean = new Map();
        for (const entry of list) {
            if (Number(entry?.type) !== RELATIONSHIP_FRIEND) continue;
            const user = entry.user || {};
            const friendId = String(user.id || '');
            if (!SNOWFLAKE_PATTERN.test(friendId)) continue;
            if (friendId === String(userId)) continue;
            if (user.bot === true) continue;
            if (clean.size >= MAX_FRIENDS) break;
            clean.set(friendId, {
                friendId,
                friendName: String(user.global_name || user.username || '')
                    .trim().slice(0, MAX_NAME_LENGTH) || null,
                avatar: typeof user.avatar === 'string' ? user.avatar.slice(0, 64) : null
            });
        }

        db.transaction(() => {
            db.run('DELETE FROM user_friends WHERE ownerId = @userId', { userId });
            for (const friend of clean.values()) {
                db.run(
                    `INSERT INTO user_friends (ownerId, friendId, friendName, avatar)
                     VALUES (@userId, @friendId, @friendName, @avatar)`,
                    { userId, ...friend }
                );
            }
        });
        return { friends: clean.size, syncedAt: this.lastSyncedAt(userId) };
    }

    /**
     * A user's cached friends, alphabetical.
     * @param {string} userId
     * @returns {Array<{id, name, avatar}>}
     */
    listFriends(userId) {
        return db.all(
            `SELECT friendId, friendName, avatar FROM user_friends
             WHERE ownerId = @userId
             ORDER BY friendName COLLATE NOCASE, friendId`,
            { userId }
        ).map(row => ({
            id: row.friendId,
            name: row.friendName || `User ${row.friendId}`,
            avatar: avatarUrl(row.friendId, row.avatar)
        }));
    }

    /** When the roster was last synced by the Activity, or null. */
    lastSyncedAt(userId) {
        return db.get(
            'SELECT MAX(syncedAt) AS syncedAt FROM user_friends WHERE ownerId = @userId',
            { userId }
        )?.syncedAt || null;
    }

    /**
     * People this user could invite somewhere: their Discord friends first
     * (the roster the Activity synced), then everyone else they share a
     * server with. Both sources are filtered by the same query and the
     * caller's exclusion set, deduped (a friend who is also a server-mate
     * stays a friend), and bounded.
     *
     * Never throws for a missing/degraded source: no Activity means no
     * friends, an unreachable guild is skipped, and the picker still works.
     *
     * @param {Object} params - { client, userId, q?, exclude?, limit? }
     * @returns {Promise<{people: Array, friendsSynced: boolean, syncedAt: string|null}>}
     */
    async listInvitable({ client = null, userId, q = null, exclude = [], limit = MAX_CANDIDATES }) {
        const query = String(q || '').trim().toLowerCase().slice(0, 100);
        const bounded = Math.max(1, Math.min(Number(limit) || MAX_CANDIDATES, MAX_CANDIDATES));
        const blocked = new Set([String(userId), ...exclude.map(String)]);
        const matches = (name, id) =>
            !query || String(name || '').toLowerCase().includes(query) || String(id).startsWith(query);

        const friends = this.listFriends(userId);
        const people = new Map();
        for (const friend of friends) {
            if (blocked.has(friend.id)) continue;
            if (!matches(friend.name, friend.id)) continue;
            people.set(friend.id, { ...friend, source: 'friend', via: null });
        }

        // Server-mates: the fallback source, so the picker is useful even
        // without the Activity. Membership is the gate - we only list
        // people from servers this user is actually in (which they can
        // already browse in Discord).
        const guilds = [...(client?.guilds?.cache?.values?.() || [])].slice(0, MAX_GUILDS_SCANNED);
        const memberships = await Promise.allSettled(
            guilds.map(guild => guild.members.fetch(userId))
        );
        const shared = guilds.filter((guild, index) => memberships[index].status === 'fulfilled');

        // A query is worth a REST search (the member cache may be partial);
        // browsing just reads the cache the GuildMembers intent keeps warm.
        if (query) {
            const searches = await Promise.allSettled(
                shared.slice(0, MAX_SEARCH_GUILDS).map(guild =>
                    guild.members.fetch({ query, limit: SEARCH_FETCH_LIMIT }))
            );
            for (let i = 0; i < searches.length; i++) {
                if (searches[i].status !== 'fulfilled') continue;
                this._collectMembers(searches[i].value, shared[i], people, blocked, bounded);
            }
        }
        for (const guild of shared) {
            if (people.size >= bounded) break;
            const cached = [...(guild.members?.cache?.values?.() || [])].slice(0, MAX_PER_GUILD);
            this._collectMembers(cached, guild, people, blocked, bounded, matches);
        }

        const ordered = [...people.values()]
            .sort((a, b) => {
                if (a.source !== b.source) return a.source === 'friend' ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
            .slice(0, bounded);

        return {
            people: ordered,
            friendsSynced: friends.length > 0,
            syncedAt: this.lastSyncedAt(userId)
        };
    }

    /**
     * Fold guild members into the candidate map (friends already collected
     * keep their friend badge).
     * @param {Iterable} members - discord.js GuildMembers (collection or array)
     */
    _collectMembers(members, guild, people, blocked, limit, matches = null) {
        for (const member of members.values?.() || members) {
            if (people.size >= limit) return;
            const user = member?.user;
            if (!user || user.bot) continue;
            if (blocked.has(user.id) || people.has(user.id)) continue;
            const name = member.displayName || user.globalName || user.username || `User ${user.id}`;
            if (matches && !matches(name, user.id)) continue;
            people.set(user.id, {
                id: user.id,
                name: String(name).slice(0, MAX_NAME_LENGTH),
                avatar: user.displayAvatarURL?.({ size: 64 }) || null,
                source: 'server',
                via: guild.name
            });
        }
    }
}

module.exports = new FriendService();
module.exports.FriendError = FriendError;
