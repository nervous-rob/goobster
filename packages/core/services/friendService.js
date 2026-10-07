/**
 * Friends: Goobster's own, mutual friendship graph, plus the "who can I
 * reach" people search the pickers are built on.
 *
 * A person finds someone by the start of their name, by their exact
 * verified email address (which is never shown - the address is a key,
 * not a result), by a shared Discord server, or by pasting a principal id,
 * and sends a friend request. The request is one `friendships` row
 * (documentation/friends_and_messages.md) and lands in the other person's
 * Inbox (`inboxService.deliver`, kind `invite`) with a Discord DM echo that
 * carries Accept / Decline buttons. Accepting makes the pair friends -
 * both see each other's portal presence and can message each other
 * (services/directMessageService.js). Either side can end it.
 *
 * Nothing here is a cache of Discord relationships: Discord does not
 * expose friend lists to bots, so the old Activity-synced roster
 * (user_friends) is gone and the friendship is Goobster's own record.
 *
 * Errors use FriendError (HTTP status + machine-readable code, the
 * PanelError contract). Erased by /forget-me (privacyService).
 */

const db = require('../db');
const logger = require('../utils/logger');
const { toGateway } = require('../gateway');
const identityConfig = require('../config/identityConfig');
const { discord } = require('../utils/optionalModule');

const SOURCE_TYPE = 'friend_request';
const BUTTON_TYPE = 'friendreq';
const STATUSES = ['pending', 'accepted', 'declined', 'cancelled', 'removed'];
const MAX_NAME_LENGTH = 64;
// A declined request cannot be repeated straight away - the addressee is
// not told to say no twice in a row.
const DECLINE_COOLDOWN_HOURS = 24;
// Requests are cheap to send and land in someone else's Inbox; the ceiling
// is a spam guard, not a product limit.
const REQUEST_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 };
// One person can have this many friends; a sanity bound for the lists.
const MAX_FRIENDS = 1000;

// How many guilds to scan and how many people to return, so a user in
// large servers never turns the picker into a member dump.
const MAX_GUILDS_SCANNED = 20;
const MAX_CANDIDATES = 100;
const MAX_PER_GUILD = 200;
// Guild member search hits the REST API once per guild; only worth it for
// an explicit query, and only across a handful of servers.
const MAX_SEARCH_GUILDS = 8;
const SEARCH_FETCH_LIMIT = 25;
// Name search needs at least this many characters (no browsing the roster).
const MIN_QUERY = 2;

/** Machine-readable web app error (the PanelError contract). */
class FriendError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'FriendError';
        this.status = status;
        this.code = code;
        if (details) this.details = details;
    }
}

function nowUtc() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function utcPlusHours(base, hours) {
    return new Date(new Date(`${String(base).replace(' ', 'T')}Z`).getTime() + hours * 3600_000)
        .toISOString().slice(0, 19).replace('T', ' ');
}

/** The canonical ordering of a pair, so one row serves both directions. */
function pairOf(a, b) {
    const [lowId, highId] = [String(a), String(b)].sort();
    return { lowId, highId };
}

/** `@in0, @in1, …` placeholders and their params for an IN (...) list. */
function inList(values, prefix = 'in') {
    const list = [...new Set(values.map(String))];
    const params = {};
    const placeholders = list.map((value, index) => {
        params[`${prefix}${index}`] = value;
        return `@${prefix}${index}`;
    });
    return { placeholders: placeholders.join(', '), params, empty: list.length === 0 };
}

/** Discord CDN avatar URL from a stored avatar hash (snowflake ids only). */
function avatarUrl(userId, hash) {
    return hash && /^\d{5,20}$/.test(String(userId))
        ? `https://cdn.discordapp.com/avatars/${userId}/${hash}.png?size=64`
        : null;
}

function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, ch => `\\${ch}`);
}

class FriendService {
    constructor() {
        this.FriendError = FriendError;
        this.SOURCE_TYPE = SOURCE_TYPE;
        this.BUTTON_TYPE = BUTTON_TYPE;
        this.STATUSES = STATUSES;
    }

    // --- Discovery ------------------------------------------------------------

    /**
     * Find people to befriend. Three keys, one box:
     *  - an email address: the one person with that *verified* address
     *    (the address itself is never returned - a result confirms a
     *    person, not an address);
     *  - a principal id (Discord snowflake or usr_…): that person;
     *  - otherwise the start of a name (at least two characters) among the
     *    people of this installation and, through the gateway, the members
     *    of Discord servers the caller shares with Goobster.
     * Every result carries the caller's relationship with that person so
     * the UI can offer the one right action.
     *
     * @param {{ gateway?: object|null, userId: string, q: string, limit?: number }} params
     * @returns {Promise<{ people: Array, kind: 'email'|'id'|'name'|'none' }>}
     */
    async search({ gateway = null, client = null, userId, q, limit = 20 }) {
        const me = String(userId ?? '');
        const query = String(q ?? '').trim().slice(0, 254);
        const bounded = Math.max(1, Math.min(Number(limit) || 20, 50));
        if (!query) return { people: [], kind: 'none' };

        const identityService = require('./identityService');
        let people = [];
        let kind = 'name';
        if (query.includes('@')) {
            kind = 'email';
            const found = await this._byEmail(query);
            if (found) people = [found];
        } else if (identityService.isPrincipalId(query)) {
            kind = 'id';
            const found = await this._byId(query, toGateway(gateway || client));
            if (found) people = [found];
        } else {
            if (query.length < MIN_QUERY) return { people: [], kind };
            people = await this._byName({ gateway: toGateway(gateway || client), userId: me, query, limit: bounded });
        }
        people = people.filter(person => person.id !== me).slice(0, bounded);
        return { people: await this._withRelationship(me, people), kind };
    }

    async _byEmail(raw) {
        const { normalizeEmail } = require('./mailService');
        const normalized = normalizeEmail(raw);
        if (!normalized) return null;
        const row = await db.get(
            `SELECT principalId FROM account_emails WHERE normalized = @normalized AND verifiedAt IS NOT NULL`,
            { normalized }
        );
        if (!row) return null;
        const described = (await this.describePeople([row.principalId])).get(String(row.principalId));
        return described ? { ...described, source: 'member', via: identityConfig.installationName } : null;
    }

    async _byId(id, gateway) {
        const identityService = require('./identityService');
        const described = (await this.describePeople([id])).get(String(id));
        if (described) return { ...described, source: 'member', via: identityConfig.installationName };
        // Not a principal yet: a Discord user the bot can see still counts
        // (they become one when the request is sent).
        if (identityService.isSnowflake(id) && gateway) {
            try {
                const user = await gateway.getUser(String(id));
                if (user && !user.bot) {
                    return {
                        id: String(id),
                        name: String(user.globalName || user.username || `User ${id}`).slice(0, MAX_NAME_LENGTH),
                        avatar: null,
                        source: 'server',
                        via: null
                    };
                }
            } catch { /* gateway unreachable - unknown id */ }
        }
        return null;
    }

    async _byName({ gateway, userId, query, limit }) {
        const people = new Map();
        for (const person of await this._portalPeople({ query, exclude: [userId], limit })) {
            people.set(person.id, person);
        }
        if (gateway && people.size < limit) {
            const blocked = new Set([String(userId), ...people.keys()]);
            let shared = [];
            try {
                shared = (await gateway.listMutualGuilds(userId)).slice(0, MAX_SEARCH_GUILDS);
            } catch { /* gateway unreachable - installation people only */ }
            const searches = await Promise.allSettled(
                shared.map(guild => gateway.searchGuildMembers(guild.id, { query, limit: SEARCH_FETCH_LIMIT }))
            );
            const lowered = query.toLowerCase();
            for (let i = 0; i < searches.length; i++) {
                if (searches[i].status !== 'fulfilled') continue;
                this._collectMembers(searches[i].value, shared[i], people, blocked, limit,
                    (name) => String(name || '').toLowerCase().startsWith(lowered));
            }
        }
        return [...people.values()];
    }

    /**
     * The people of this installation whose name starts with the query:
     * active accounts always, and - while `identity.requireAccount` is off
     * and a session is all the portal asks for - anyone who has signed in
     * to the portal (a live web session). Name and id only, never the login
     * name, email, or role (spec §6).
     */
    async _portalPeople({ query, exclude = [], limit = 20 }) {
        const prefix = `${escapeLike(query.toLowerCase())}%`;
        const openDoor = !identityConfig.requireAccount;
        const eligible = openDoor
            ? `(a.status = 'active' OR EXISTS (SELECT 1 FROM web_sessions s WHERE s.userId = p.id))`
            : `a.status = 'active'`;
        const rows = await db.all(
            `SELECT p.id, p.displayName, a.loginName,
                    (SELECT s.userName FROM web_sessions s WHERE s.userId = p.id ORDER BY s.id DESC LIMIT 1) AS sessionName,
                    (SELECT s.avatar FROM web_sessions s WHERE s.userId = p.id AND s.avatar IS NOT NULL ORDER BY s.id DESC LIMIT 1) AS avatar
             FROM principals p
             LEFT JOIN app_accounts a ON a.principalId = p.id
             WHERE ${eligible}
               AND (LOWER(COALESCE(p.displayName, '')) LIKE @prefix ESCAPE '\\'
                    OR LOWER(COALESCE(a.loginName, '')) LIKE @prefix ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM web_sessions s WHERE s.userId = p.id
                               AND LOWER(COALESCE(s.userName, '')) LIKE @prefix ESCAPE '\\'))
             ORDER BY COALESCE(p.displayName, a.loginName) ASC, p.id ASC
             LIMIT ${Math.max(1, Math.min(Number(limit) || 20, 50)) + exclude.length}`,
            { prefix }
        );
        const blocked = new Set(exclude.map(String));
        const { isAssistantId } = require('./assistantIdentity');
        return rows
            .filter(row => !blocked.has(String(row.id)) && !isAssistantId(row.id))
            .slice(0, limit)
            .map(row => ({
                id: String(row.id),
                name: String(row.sessionName || row.displayName || row.loginName || `Member ${String(row.id).slice(-6)}`).slice(0, MAX_NAME_LENGTH),
                avatar: avatarUrl(row.id, row.avatar),
                source: 'member',
                via: identityConfig.installationName
            }));
    }

    /**
     * Names and avatars for a set of principal ids, from what the portal
     * already holds (latest session name, principal display name, login
     * name). Ids with no principal row are absent from the map.
     * @param {string[]} ids
     * @returns {Promise<Map<string, { id: string, name: string, avatar: string|null }>>}
     */
    async describePeople(ids) {
        const map = new Map();
        const { placeholders, params, empty } = inList(ids || []);
        if (empty) return map;
        const rows = await db.all(
            `SELECT p.id, p.displayName, a.loginName,
                    (SELECT s.userName FROM web_sessions s WHERE s.userId = p.id ORDER BY s.id DESC LIMIT 1) AS sessionName,
                    (SELECT s.avatar FROM web_sessions s WHERE s.userId = p.id AND s.avatar IS NOT NULL ORDER BY s.id DESC LIMIT 1) AS avatar
             FROM principals p
             LEFT JOIN app_accounts a ON a.principalId = p.id
             WHERE p.id IN (${placeholders})`,
            params
        );
        for (const row of rows) {
            map.set(String(row.id), {
                id: String(row.id),
                name: String(row.sessionName || row.displayName || row.loginName || `User ${String(row.id).slice(-6)}`).slice(0, MAX_NAME_LENGTH),
                avatar: avatarUrl(row.id, row.avatar)
            });
        }
        return map;
    }

    /** One person's display name, for messages about them. */
    async nameFor(userId) {
        const described = (await this.describePeople([userId])).get(String(userId));
        return described?.name || `User ${String(userId).slice(-6)}`;
    }

    /** Decorate search results with the caller's relationship to each person. */
    async _withRelationship(userId, people) {
        if (people.length === 0) return people;
        const { placeholders, params, empty } = inList(people.map(person => person.id));
        if (empty) return people;
        const rows = await db.all(
            `SELECT * FROM friendships
             WHERE (lowId = @me AND highId IN (${placeholders})) OR (highId = @me AND lowId IN (${placeholders}))`,
            { ...params, me: String(userId) }
        );
        const byOther = new Map();
        for (const row of rows) {
            const other = row.lowId === String(userId) ? row.highId : row.lowId;
            byOther.set(other, row);
        }
        return people.map(person => ({
            ...person,
            relationship: this._relationshipView(userId, byOther.get(person.id) || null)
        }));
    }

    /** `{ status, requestId, direction }` from the caller's point of view. */
    _relationshipView(userId, row) {
        if (!row) return { status: 'none', requestId: null, direction: null };
        if (row.status === 'accepted') return { status: 'friends', requestId: row.id, direction: null };
        if (row.status === 'pending') {
            return {
                status: row.requesterId === String(userId) ? 'outgoing' : 'incoming',
                requestId: row.id,
                direction: row.requesterId === String(userId) ? 'outgoing' : 'incoming'
            };
        }
        return { status: 'none', requestId: null, direction: null };
    }

    // --- Requests -------------------------------------------------------------

    /**
     * Send a friend request. Idempotent-ish: a pending request the other
     * way round is accepted instead (both wanted this), a pending request
     * the same way is refused, an accepted friendship is refused, and any
     * settled row (declined / cancelled / removed) is reopened as a fresh
     * pending request.
     *
     * The request lands in the addressee's Inbox first (durable, visible
     * with or without Discord), then their Discord DMs with Accept /
     * Decline buttons when they can receive one. A failed DM is reported
     * (`dmSent: false`), never an error.
     *
     * @param {{ gateway?: object|null, userId: string, userName?: string|null, targetId: string }} params
     * @returns {Promise<{ request: object, status: 'pending'|'accepted', dmSent: boolean }>}
     */
    async request({ gateway = null, client = null, userId, userName = null, targetId }) {
        const identityService = require('./identityService');
        const me = String(userId ?? '');
        const target = String(targetId ?? '').trim();
        if (!identityService.isPrincipalId(me)) throw new FriendError(400, 'BAD_USER_ID', 'A signed-in person is required.');
        if (!identityService.isPrincipalId(target)) {
            throw new FriendError(400, 'BAD_USER_ID', 'That does not look like a user id (a Discord id or a member id).');
        }
        if (target === me) throw new FriendError(400, 'CANNOT_FRIEND_SELF', 'You are already your own best friend.');
        const { isAssistantId } = require('./assistantIdentity');
        if (isAssistantId(target)) {
            throw new FriendError(400, 'CANNOT_FRIEND_BOT', `${identityConfig.assistantName} is already everybody's friend.`);
        }

        const resolvedGateway = toGateway(gateway || client);
        await this._ensureTargetPrincipal(target, resolvedGateway);

        const { consumeWindow } = require('../utils/slidingWindowLimit');
        if (!await consumeWindow({ scope: 'friend_request', subject: me, ...REQUEST_LIMIT })) {
            throw new FriendError(429, 'RATE_LIMITED', 'You have sent a lot of friend requests recently - try again in a while.');
        }

        const pair = pairOf(me, target);
        const existing = await db.get(
            'SELECT * FROM friendships WHERE lowId = @lowId AND highId = @highId', pair
        );
        if (existing?.status === 'accepted') {
            throw new FriendError(409, 'ALREADY_FRIENDS', 'You are already friends.');
        }
        if (existing?.status === 'pending') {
            if (existing.requesterId === me) {
                throw new FriendError(409, 'ALREADY_REQUESTED', 'Your friend request is still waiting for their answer.');
            }
            // They asked first: two people who both want this are friends.
            const accepted = await this.respond({ userId: me, userName, requestId: existing.id, accept: true, gateway: resolvedGateway });
            return { request: accepted.request, status: 'accepted', dmSent: false };
        }
        if (existing?.status === 'declined' && existing.addresseeId === target && existing.respondedAt) {
            const retryAt = utcPlusHours(existing.respondedAt, DECLINE_COOLDOWN_HOURS);
            if (retryAt > nowUtc()) {
                throw new FriendError(429, 'REQUEST_COOLDOWN', 'You asked them recently - try again later.', { retryAt });
            }
        }

        const now = nowUtc();
        let row;
        if (existing) {
            await db.run(
                `UPDATE friendships
                 SET requesterId = @me, addresseeId = @target, status = 'pending',
                     createdAt = @now, respondedAt = NULL, updatedAt = @now
                 WHERE id = @id`,
                { id: existing.id, me, target, now }
            );
            row = await this._row(existing.id);
        } else {
            const id = await db.insert(
                `INSERT INTO friendships (lowId, highId, requesterId, addresseeId, status, createdAt, updatedAt)
                 VALUES (@lowId, @highId, @me, @target, 'pending', @now, @now)`,
                { ...pair, me, target, now }
            );
            row = await this._row(id);
        }

        const requesterName = userName || await this.nameFor(me);
        const dmSent = await this._notifyAddressee(row, requesterName, resolvedGateway);
        this._publish([me, target]);
        return { request: await this._public(row), status: 'pending', dmSent };
    }

    /**
     * Accept or decline one of MY pending requests. Accepting makes the
     * pair friends and tells the requester (Inbox, Discord echo); declining
     * is silent towards them - they only see the request has gone.
     * @param {{ userId: string, userName?: string|null, requestId: number|string, accept: boolean, gateway?: object|null }} params
     * @returns {Promise<{ request: object, status: 'accepted'|'declined', friend: object|null }>}
     */
    async respond({ userId, userName = null, requestId, accept, gateway = null, client = null }) {
        const me = String(userId ?? '');
        const row = await this._row(requestId);
        if (!row || row.addresseeId !== me) throw new FriendError(404, 'NO_SUCH_REQUEST', 'No such friend request.');
        if (row.status !== 'pending') throw new FriendError(409, 'REQUEST_SETTLED', 'This friend request was already answered.');
        if (accept && await this._friendCount(me) >= MAX_FRIENDS) {
            throw new FriendError(400, 'TOO_MANY_FRIENDS', `You can have at most ${MAX_FRIENDS} friends.`);
        }
        const status = accept ? 'accepted' : 'declined';
        const now = nowUtc();
        const result = await db.run(
            `UPDATE friendships SET status = @status, respondedAt = @now, updatedAt = @now
             WHERE id = @id AND status = 'pending'`,
            { id: row.id, status, now }
        );
        if (!result.changes) throw new FriendError(409, 'REQUEST_SETTLED', 'This friend request was already answered.');
        const settled = await this._row(row.id);
        if (accept) {
            await this._notifyRequester(settled, userName || await this.nameFor(me), toGateway(gateway || client));
        }
        this._publish([row.requesterId, row.addresseeId]);
        const friend = accept ? (await this.describePeople([row.requesterId])).get(row.requesterId) || null : null;
        return { request: await this._public(settled), status, friend };
    }

    /** Withdraw a pending request I sent. */
    async cancel({ userId, requestId }) {
        const me = String(userId ?? '');
        const row = await this._row(requestId);
        if (!row || row.requesterId !== me) throw new FriendError(404, 'NO_SUCH_REQUEST', 'No such friend request.');
        if (row.status !== 'pending') throw new FriendError(409, 'REQUEST_SETTLED', 'This friend request was already answered.');
        const now = nowUtc();
        await db.run(
            `UPDATE friendships SET status = 'cancelled', respondedAt = @now, updatedAt = @now WHERE id = @id`,
            { id: row.id, now }
        );
        this._publish([row.requesterId, row.addresseeId]);
        return { cancelled: true };
    }

    /** End a friendship (either side). Quiet: the other person is not notified. */
    async remove({ userId, friendId }) {
        const me = String(userId ?? '');
        const other = String(friendId ?? '');
        const pair = pairOf(me, other);
        const now = nowUtc();
        const result = await db.run(
            `UPDATE friendships SET status = 'removed', respondedAt = @now, updatedAt = @now
             WHERE lowId = @lowId AND highId = @highId AND status = 'accepted'`,
            { ...pair, now }
        );
        if (!result.changes) throw new FriendError(404, 'NOT_FRIENDS', 'You are not friends with them.');
        this._publish([me, other]);
        return { removed: true };
    }

    // --- Reading --------------------------------------------------------------

    /**
     * My friends, alphabetical, optionally decorated with portal presence
     * (`online`, respecting each friend's "show me as online" setting).
     * @param {string} userId
     * @param {{ presence?: boolean }} [options]
     * @returns {Promise<Array<{ id, name, avatar, since, online? }>>}
     */
    async listFriends(userId, { presence = false } = {}) {
        const me = String(userId ?? '');
        if (!me) return [];
        const rows = await db.all(
            `SELECT lowId, highId, respondedAt FROM friendships
             WHERE status = 'accepted' AND (lowId = @me OR highId = @me)`,
            { me }
        );
        const ids = rows.map(row => (row.lowId === me ? row.highId : row.lowId));
        const described = await this.describePeople(ids);
        const online = presence
            ? await require('./presenceService').onlineIds(ids, { respectVisibility: true })
            : null;
        return rows
            .map(row => {
                const id = row.lowId === me ? row.highId : row.lowId;
                const person = described.get(id) || { id, name: `User ${id.slice(-6)}`, avatar: null };
                return { ...person, since: row.respondedAt || null, ...(presence ? { online: online.has(id) } : {}) };
            })
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    }

    /** The ids of my friends (for permission checks). */
    async friendIds(userId) {
        const me = String(userId ?? '');
        const rows = await db.all(
            `SELECT lowId, highId FROM friendships WHERE status = 'accepted' AND (lowId = @me OR highId = @me)`,
            { me }
        );
        return new Set(rows.map(row => (row.lowId === me ? row.highId : row.lowId)));
    }

    /** Whether two people are friends right now. */
    async areFriends(a, b) {
        const row = await db.get(
            `SELECT 1 AS ok FROM friendships WHERE lowId = @lowId AND highId = @highId AND status = 'accepted'`,
            pairOf(a, b)
        );
        return Boolean(row);
    }

    /**
     * Pending requests addressed to me (incoming) and the ones I sent
     * (outgoing), newest first.
     */
    async listRequests(userId) {
        const me = String(userId ?? '');
        const rows = await db.all(
            `SELECT * FROM friendships WHERE status = 'pending' AND (requesterId = @me OR addresseeId = @me)
             ORDER BY createdAt DESC, id DESC`,
            { me }
        );
        const ids = rows.flatMap(row => [row.requesterId, row.addresseeId]);
        const described = await this.describePeople(ids);
        const incoming = [];
        const outgoing = [];
        for (const row of rows) {
            const view = await this._public(row, described);
            (row.addresseeId === me ? incoming : outgoing).push(view);
        }
        return { incoming, outgoing };
    }

    /** Everything the People pane needs in one read. */
    async overview({ userId }) {
        const [friends, requests] = await Promise.all([
            this.listFriends(userId, { presence: true }),
            this.listRequests(userId)
        ]);
        return { friends, ...requests };
    }

    /** How many requests are waiting for my answer (the nav badge). */
    async pendingCount(userId) {
        const row = await db.get(
            `SELECT COUNT(*) AS c FROM friendships WHERE status = 'pending' AND addresseeId = @me`,
            { me: String(userId ?? '') }
        );
        return Number(row?.c || 0);
    }

    // --- Inbox presentation ---------------------------------------------------

    /**
     * The friend requests behind the items in an Inbox page, keyed by
     * sourceId: the addressee's copy offers Accept / Decline while pending;
     * every copy shows the outcome once settled.
     * @param {Array<{ sourceType: string|null, sourceId: string|null }>} rows
     * @returns {Promise<Map<string, object>>}
     */
    async describeForRows(rows) {
        const ids = [...new Set(rows
            .filter(row => row.sourceType === SOURCE_TYPE && row.sourceId != null && /^\d+$/.test(String(row.sourceId)))
            .map(row => Number(row.sourceId)))];
        const map = new Map();
        if (ids.length === 0) return map;
        const params = {};
        const marks = ids.map((id, index) => { params[`id${index}`] = id; return `@id${index}`; });
        const found = await db.all(`SELECT * FROM friendships WHERE id IN (${marks.join(', ')})`, params);
        const described = await this.describePeople(found.flatMap(row => [row.requesterId, row.addresseeId]));
        for (const row of found) map.set(String(row.id), await this._public(row, described));
        return map;
    }

    // --- Discord buttons ------------------------------------------------------

    /**
     * Accept / Decline pressed on the DM (routed from interactionCreate).
     * Returns the edit for the DM message, or null when nothing changed.
     */
    async handleButton(action, id, interaction) {
        const identityService = require('./identityService');
        const row = await this._row(id);
        if (!row) return { content: '⌛ This friend request no longer exists.', embeds: [], components: [] };
        const principalId = await identityService.resolveExternal({ provider: 'discord', subject: interaction.user.id })
            || interaction.user.id;
        if (principalId !== row.addresseeId) {
            await interaction.followUp({ content: '❌ This friend request is not addressed to you.', ephemeral: true }).catch(() => {});
            return null;
        }
        const requesterName = await this.nameFor(row.requesterId);
        if (row.status !== 'pending') {
            return { content: `⌛ Already ${row.status === 'accepted' ? 'accepted' : 'settled'}.`, embeds: [], components: [] };
        }
        if (action !== 'accept' && action !== 'decline') return null;
        try {
            await this.respond({
                userId: principalId,
                userName: interaction.user.globalName || interaction.user.username || null,
                requestId: row.id,
                accept: action === 'accept',
                gateway: toGateway(interaction.client)
            });
        } catch (error) {
            if (error instanceof FriendError) {
                await interaction.followUp({ content: `⚠️ ${error.message}`, ephemeral: true }).catch(() => {});
                return null;
            }
            throw error;
        }
        return {
            content: action === 'accept'
                ? `🤝 You and ${requesterName} are friends now - find them under People in the portal.`
                : 'Friend request declined.',
            embeds: [],
            components: []
        };
    }

    // --- The invite picker ----------------------------------------------------

    /**
     * People this user could invite somewhere: their friends first, then
     * everyone else they share a Discord server with, then (for an explicit
     * query) other members of this installation. All sources are filtered
     * by the same query and the caller's exclusion set, deduped (a friend
     * who is also a server-mate stays a friend), and bounded.
     *
     * Never throws for a missing/degraded source: an unreachable gateway
     * skips the server source and the picker still works.
     *
     * @param {Object} params - { gateway, userId, q?, exclude?, limit? }
     * @returns {Promise<{ people: Array, hasFriends: boolean }>}
     */
    async listInvitable({ gateway = null, client = null, userId, q = null, exclude = [], limit = MAX_CANDIDATES }) {
        const query = String(q || '').trim().toLowerCase().slice(0, 100);
        const bounded = Math.max(1, Math.min(Number(limit) || MAX_CANDIDATES, MAX_CANDIDATES));
        const blocked = new Set([String(userId), ...exclude.map(String)]);
        const matches = (name, id) =>
            !query || String(name || '').toLowerCase().includes(query) || String(id).startsWith(query);

        const friends = await this.listFriends(userId);
        const people = new Map();
        for (const friend of friends) {
            if (blocked.has(friend.id)) continue;
            if (!matches(friend.name, friend.id)) continue;
            people.set(friend.id, { id: friend.id, name: friend.name, avatar: friend.avatar, source: 'friend', via: null });
        }

        // Server-mates: membership is the gate - we only list people from
        // servers this user is actually in (which they can already browse
        // in Discord). Resolved through the gateway seam; an offline bot
        // degrades to the friends-only picker.
        const resolved = toGateway(gateway || client);
        let shared = [];
        if (resolved) {
            try {
                shared = (await resolved.listMutualGuilds(userId)).slice(0, MAX_GUILDS_SCANNED);
            } catch { /* gateway unreachable - friends only */ }
        }

        // A query is worth a REST search (the member cache may be partial);
        // browsing just reads the cache the GuildMembers intent keeps warm.
        if (query) {
            const searches = await Promise.allSettled(
                shared.slice(0, MAX_SEARCH_GUILDS).map(guild =>
                    resolved.searchGuildMembers(guild.id, { query, limit: SEARCH_FETCH_LIMIT }))
            );
            for (let i = 0; i < searches.length; i++) {
                if (searches[i].status !== 'fulfilled') continue;
                this._collectMembers(searches[i].value, shared[i], people, blocked, bounded);
            }
        }
        for (const guild of shared) {
            if (people.size >= bounded) break;
            let cached = [];
            try {
                cached = await resolved.searchGuildMembers(guild.id, { query: null, limit: MAX_PER_GUILD });
            } catch { /* unreachable guild - skipped */ }
            this._collectMembers(cached, guild, people, blocked, bounded, matches);
        }

        // Members of this installation: the source that exists with Discord
        // switched off. Query-only by design - the roster is never browsed.
        if (query && query.length >= MIN_QUERY) {
            try {
                for (const member of await this._portalPeople({ query, exclude: [...blocked], limit: bounded })) {
                    if (people.size >= bounded) break;
                    if (people.has(member.id)) continue;
                    people.set(member.id, member);
                }
            } catch { /* identity tables unavailable - the other sources stand */ }
        }

        const rank = { friend: 0, server: 1, member: 2 };
        const ordered = [...people.values()]
            .sort((a, b) => (rank[a.source] - rank[b.source]) || a.name.localeCompare(b.name))
            .slice(0, bounded);

        return { people: ordered, hasFriends: friends.length > 0 };
    }

    /**
     * Fold member snapshots into the candidate map (friends already
     * collected keep their friend badge).
     * @param {Array} members - gateway member snapshots
     */
    _collectMembers(members, guild, people, blocked, limit, matches = null) {
        for (const member of members) {
            if (people.size >= limit) return;
            if (!member || member.bot) continue;
            if (blocked.has(member.id) || people.has(member.id)) continue;
            const name = member.displayName || member.globalName || member.username || `User ${member.id}`;
            if (matches && !matches(name, member.id)) continue;
            people.set(member.id, {
                id: member.id,
                name: String(name).slice(0, MAX_NAME_LENGTH),
                avatar: member.avatar || null,
                source: 'server',
                via: guild.name
            });
        }
    }

    // --- Privacy --------------------------------------------------------------

    /** Erase every friendship row the person is on (either seat). */
    async forgetUser(userId, handle = db) {
        const me = String(userId ?? '');
        if (!me) return 0;
        return (await handle.run(
            'DELETE FROM friendships WHERE lowId = @me OR highId = @me', { me }
        )).changes || 0;
    }

    async countForUser(userId) {
        const me = String(userId ?? '');
        const row = await db.get(
            `SELECT
                 SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS friends,
                 SUM(CASE WHEN status = 'pending' AND addresseeId = @me THEN 1 ELSE 0 END) AS incoming,
                 SUM(CASE WHEN status = 'pending' AND requesterId = @me THEN 1 ELSE 0 END) AS outgoing,
                 COUNT(*) AS rows
             FROM friendships WHERE lowId = @me OR highId = @me`,
            { me }
        );
        return {
            friends: Number(row?.friends || 0),
            incoming: Number(row?.incoming || 0),
            outgoing: Number(row?.outgoing || 0),
            rows: Number(row?.rows || 0)
        };
    }

    // --- Internals ------------------------------------------------------------

    async _row(id) {
        const n = Number(id);
        if (!Number.isSafeInteger(n) || n < 1) return null;
        return await db.get('SELECT * FROM friendships WHERE id = @id', { id: n }) || null;
    }

    async _friendCount(userId) {
        const row = await db.get(
            `SELECT COUNT(*) AS c FROM friendships WHERE status = 'accepted' AND (lowId = @me OR highId = @me)`,
            { me: String(userId) }
        );
        return Number(row?.c || 0);
    }

    /**
     * The target must be somebody: a principal of this installation, or a
     * Discord user the bot can see (who becomes a principal now, so the
     * request has an owner on their side even before their first login).
     */
    async _ensureTargetPrincipal(target, gateway) {
        const identityService = require('./identityService');
        if (await identityService.getPrincipal(target)) return;
        if (!identityService.isSnowflake(target)) {
            throw new FriendError(404, 'NO_SUCH_USER', 'No member of this installation with that id.');
        }
        if (!gateway) throw new FriendError(404, 'NO_SUCH_USER', 'Nobody here has that id.');
        let user;
        try {
            user = await gateway.getUser(target);
        } catch {
            throw new FriendError(503, 'BOT_OFFLINE', 'Goobster cannot look that person up right now - try again shortly.');
        }
        if (!user) throw new FriendError(404, 'NO_SUCH_USER', 'No Discord user with that id.');
        if (user.bot) throw new FriendError(400, 'CANNOT_FRIEND_BOT', 'Bots cannot be friends.');
        await identityService.ensureLegacyPrincipal({ discordId: target, displayName: user.globalName || user.username || null });
    }

    async _public(row, described = null) {
        const people = described || await this.describePeople([row.requesterId, row.addresseeId]);
        const name = (id) => people.get(String(id))?.name || `User ${String(id).slice(-6)}`;
        const avatar = (id) => people.get(String(id))?.avatar || null;
        return {
            id: row.id,
            status: row.status,
            requesterId: row.requesterId,
            requesterName: name(row.requesterId),
            requesterAvatar: avatar(row.requesterId),
            addresseeId: row.addresseeId,
            addresseeName: name(row.addresseeId),
            addresseeAvatar: avatar(row.addresseeId),
            createdAt: row.createdAt,
            respondedAt: row.respondedAt || null
        };
    }

    /** Both people's open portal sessions refetch their friend lists. */
    _publish(userIds) {
        try {
            const eventBus = require('./eventBusService');
            for (const id of new Set(userIds.map(String))) {
                eventBus.publish('friends', { userId: id });
            }
        } catch { /* cosmetic */ }
    }

    _portalUrl(path) {
        try {
            const publicUrl = require('../config/configJson').load().webapp?.publicUrl;
            if (typeof publicUrl === 'string' && publicUrl) {
                return `${publicUrl.replace(/\/+$/, '')}/app${path}`;
            }
        } catch { /* no config.json (tests) - skip the link */ }
        return null;
    }

    /** The request DM: an embed plus Accept / Decline buttons. */
    _requestMessage({ requestId, requesterName }) {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = discord;
        const url = this._portalUrl('/people/friends');
        const embed = new EmbedBuilder()
            .setColor(0x7c8cff)
            .setTitle('🤝 A friend request')
            .setDescription(
                `**${requesterName}** wants to be friends on ${identityConfig.installationName}. `
                + 'Friends see when each other is in the portal and can message each other there.'
                + (url ? `\n\nYou can also answer under People at ${url}.` : '')
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`accept_${BUTTON_TYPE}_${requestId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`decline_${BUTTON_TYPE}_${requestId}`).setLabel('Decline').setStyle(ButtonStyle.Secondary)
        );
        return { embeds: [embed], components: [row] };
    }

    /** The request, to the addressee: Inbox first, Discord as the echo. Returns whether the DM went out. */
    async _notifyAddressee(row, requesterName, gateway) {
        try {
            const delivery = await require('./inboxService').deliver({
                userId: row.addresseeId,
                kind: 'invite',
                title: `${requesterName} wants to be friends`,
                body: 'Accept and you will see each other in the portal and can send each other messages. '
                    + 'Decline and they are not told.',
                source: { type: SOURCE_TYPE, id: row.id },
                link: '/people/friends',
                dedupeKey: `${SOURCE_TYPE}:${row.id}:${row.createdAt}`,
                discord: gateway
                    ? { gateway, payload: this._requestMessage({ requestId: row.id, requesterName }) }
                    : false
            });
            return delivery.discord.status === 'sent';
        } catch (error) {
            logger.warn?.(`[friends] Could not notify the addressee of request #${row.id}: ${error.message}`);
            return false;
        }
    }

    /** The acceptance, to the requester: Inbox first, Discord as the echo. */
    async _notifyRequester(row, addresseeName, gateway) {
        try {
            await require('./inboxService').deliver({
                userId: row.requesterId,
                kind: 'system',
                title: `${addresseeName} accepted your friend request`,
                body: 'You are friends now: you can see when they are in the portal and message them under People.',
                source: { type: SOURCE_TYPE, id: row.id },
                link: '/people/friends',
                dedupeKey: `${SOURCE_TYPE}:${row.id}:${row.createdAt}:accepted`,
                discord: gateway ? { gateway } : false
            });
        } catch (error) {
            logger.warn?.(`[friends] Could not tell the requester about request #${row.id}: ${error.message}`);
        }
    }
}

module.exports = new FriendService();
module.exports.FriendService = FriendService;
module.exports.FriendError = FriendError;
module.exports.SOURCE_TYPE = SOURCE_TYPE;
module.exports.BUTTON_TYPE = BUTTON_TYPE;
module.exports.pairOf = pairOf;
