/**
 * Direct messages: private, person-to-person conversations between two
 * friends in the portal (documentation/friends_and_messages.md).
 *
 * A DM is not a Chat: nobody is talking to Goobster, no AI turn runs, no
 * memory is written, and nothing is scoped to a guild. It is also not a
 * Discussion (parlor): there is exactly one thread per pair, nobody is
 * invited or seated, and being friends is the whole permission model - the
 * moment a friendship ends, the thread goes read-only for both sides
 * (`friendService.areFriends` is checked on every send).
 *
 * Storage: one `dm_threads` row per canonical pair (lowId, highId), a
 * `dm_participants` row per seat carrying that person's read cursor, and
 * append-only `dm_messages`. Portal tabs learn about new messages through
 * the event bus (`dm-message`, scoped `dm-thread:<id>` hint), the same
 * stream every other pane listens to. Deleting a person deletes the whole
 * thread (privacyService) - a private conversation does not survive one of
 * its two people.
 *
 * Errors use DirectMessageError (HTTP status + code, the PanelError
 * contract).
 */

const db = require('../db');
const { pairOf } = require('./friendService');

const MAX_MESSAGE_LENGTH = 4000;
const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
// A person can send this many DMs per minute across all threads.
const SEND_LIMIT = { max: 60, windowMs: 60 * 1000 };

class DirectMessageError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'DirectMessageError';
        this.status = status;
        this.code = code;
    }
}

function nowUtc() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

class DirectMessageService {
    constructor() {
        this.DirectMessageError = DirectMessageError;
        this.MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH;
    }

    // --- Threads --------------------------------------------------------------

    /**
     * The thread between me and one friend, created on first use. Only
     * friends can open a thread; an existing thread with a former friend
     * is still readable through `listThreads` / `getMessages`.
     * @returns {Promise<object>} the public thread view
     */
    async openWith({ userId, friendId }) {
        const me = String(userId ?? '');
        const other = String(friendId ?? '').trim();
        if (!me || !other) throw new DirectMessageError(400, 'BAD_USER_ID', 'A person to message is required.');
        if (me === other) throw new DirectMessageError(400, 'CANNOT_MESSAGE_SELF', 'You cannot message yourself.');
        const friendService = require('./friendService');
        if (!await friendService.areFriends(me, other)) {
            throw new DirectMessageError(403, 'NOT_FRIENDS', 'You can only message your friends.');
        }
        const pair = pairOf(me, other);
        let thread = await db.get('SELECT * FROM dm_threads WHERE lowId = @lowId AND highId = @highId', pair);
        if (!thread) {
            thread = await db.transaction(async (tx) => {
                const now = nowUtc();
                await tx.run(
                    `INSERT INTO dm_threads (lowId, highId, createdAt) VALUES (@lowId, @highId, @now)
                     ON CONFLICT (lowId, highId) DO NOTHING`,
                    { ...pair, now }
                );
                const row = await tx.get('SELECT * FROM dm_threads WHERE lowId = @lowId AND highId = @highId', pair);
                for (const seat of [row.lowId, row.highId]) {
                    await tx.run(
                        `INSERT INTO dm_participants (threadId, userId, joinedAt) VALUES (@threadId, @userId, @now)
                         ON CONFLICT (threadId, userId) DO NOTHING`,
                        { threadId: row.id, userId: seat, now }
                    );
                }
                return row;
            });
        }
        return (await this._publicThreads(me, [thread]))[0];
    }

    /**
     * My threads, most recent activity first, each with the other person,
     * the last message preview, my unread count, and whether we are still
     * friends (sending is disabled otherwise).
     */
    async listThreads({ userId }) {
        const me = String(userId ?? '');
        if (!me) return [];
        const rows = await db.all(
            `SELECT t.* FROM dm_threads t
             JOIN dm_participants p ON p.threadId = t.id AND p.userId = @me
             ORDER BY COALESCE(t.lastMessageAt, t.createdAt) DESC, t.id DESC`,
            { me }
        );
        return this._publicThreads(me, rows);
    }

    /** One thread I am on, or a 404. */
    async getThread({ userId, threadId }) {
        const me = String(userId ?? '');
        const row = await this._threadFor(me, threadId);
        return (await this._publicThreads(me, [row]))[0];
    }

    // --- Messages -------------------------------------------------------------

    /**
     * A page of messages, oldest first; `beforeId` pages backwards.
     * @returns {Promise<{ messages: Array, hasMore: boolean }>}
     */
    async getMessages({ userId, threadId, limit = DEFAULT_PAGE, beforeId = null }) {
        const me = String(userId ?? '');
        const thread = await this._threadFor(me, threadId);
        const bounded = Math.max(1, Math.min(Math.trunc(Number(limit)) || DEFAULT_PAGE, MAX_PAGE));
        const params = { threadId: thread.id };
        let where = 'threadId = @threadId';
        if (beforeId != null && beforeId !== '') {
            const before = Number(beforeId);
            if (!Number.isSafeInteger(before) || before < 1) {
                throw new DirectMessageError(400, 'BAD_CURSOR', 'Invalid message cursor.');
            }
            where += ' AND id < @before';
            params.before = before;
        }
        const rows = await db.all(
            `SELECT * FROM dm_messages WHERE ${where} ORDER BY id DESC LIMIT ${bounded + 1}`,
            params
        );
        const page = rows.slice(0, bounded).reverse();
        return { messages: page.map(row => this._publicMessage(row)), hasMore: rows.length > bounded };
    }

    /**
     * Send one message. The pair must be friends right now; the text is
     * plain (rendered as text in the portal, never as Markdown from a
     * stranger) and bounded. The other person's open tabs are told
     * through the event bus; nothing is echoed to Discord - a DM in the
     * portal stays in the portal.
     */
    async send({ userId, threadId, content }) {
        const me = String(userId ?? '');
        const thread = await this._threadFor(me, threadId);
        const text = String(content ?? '').replace(/\r\n/g, '\n').trim();
        if (!text) throw new DirectMessageError(400, 'EMPTY_MESSAGE', 'Write something first.');
        if (text.length > MAX_MESSAGE_LENGTH) {
            throw new DirectMessageError(400, 'MESSAGE_TOO_LONG', `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
        }
        const other = thread.lowId === me ? thread.highId : thread.lowId;
        const friendService = require('./friendService');
        if (!await friendService.areFriends(me, other)) {
            throw new DirectMessageError(403, 'NOT_FRIENDS', 'You are no longer friends, so this conversation is read-only.');
        }
        const { consumeWindow } = require('../utils/slidingWindowLimit');
        if (!await consumeWindow({ scope: 'dm_send', subject: me, ...SEND_LIMIT })) {
            throw new DirectMessageError(429, 'RATE_LIMITED', 'You are sending messages very quickly - give it a moment.');
        }
        const now = nowUtc();
        const message = await db.transaction(async (tx) => {
            const id = await tx.insert(
                `INSERT INTO dm_messages (threadId, senderId, content, createdAt)
                 VALUES (@threadId, @me, @text, @now)`,
                { threadId: thread.id, me, text, now }
            );
            await tx.run(
                `UPDATE dm_threads SET lastMessageAt = @now, lastMessageId = @id WHERE id = @threadId`,
                { threadId: thread.id, now, id }
            );
            // The sender has read their own message.
            await tx.run(
                `UPDATE dm_participants SET lastReadMessageId = @id WHERE threadId = @threadId AND userId = @me`,
                { threadId: thread.id, me, id }
            );
            return await tx.get('SELECT * FROM dm_messages WHERE id = @id', { id });
        });
        this._publish(thread, [me, other]);
        return this._publicMessage(message);
    }

    /** Move my read cursor to the newest message (or a given one). */
    async markRead({ userId, threadId, upToId = null }) {
        const me = String(userId ?? '');
        const thread = await this._threadFor(me, threadId);
        const target = upToId != null && upToId !== '' ? Number(upToId) : Number(thread.lastMessageId || 0);
        if (!Number.isSafeInteger(target) || target < 0) {
            throw new DirectMessageError(400, 'BAD_CURSOR', 'Invalid message cursor.');
        }
        await db.run(
            `UPDATE dm_participants SET lastReadMessageId = @target
             WHERE threadId = @threadId AND userId = @me AND lastReadMessageId < @target`,
            { threadId: thread.id, me, target }
        );
        this._publish(thread, [me], { silent: true });
        return { read: true, lastReadMessageId: target };
    }

    /** Messages addressed to me that I have not read, across every thread. */
    async unreadCount(userId) {
        const me = String(userId ?? '');
        if (!me) return 0;
        const row = await db.get(
            `SELECT COUNT(*) AS c FROM dm_messages m
             JOIN dm_participants p ON p.threadId = m.threadId AND p.userId = @me
             WHERE m.senderId <> @me AND m.id > p.lastReadMessageId`,
            { me }
        );
        return Number(row?.c || 0);
    }

    // --- Privacy --------------------------------------------------------------

    /**
     * Erase every conversation the person is part of - messages, the
     * other person's seat, the thread. A private conversation does not
     * survive one of its two people.
     */
    async forgetUser(userId, handle = db) {
        const me = String(userId ?? '');
        if (!me) return 0;
        const threads = await handle.all(
            'SELECT id FROM dm_threads WHERE lowId = @me OR highId = @me', { me }
        );
        let removed = 0;
        for (const thread of threads) {
            removed += (await handle.run('DELETE FROM dm_messages WHERE threadId = @id', { id: thread.id })).changes || 0;
            await handle.run('DELETE FROM dm_participants WHERE threadId = @id', { id: thread.id });
            await handle.run('DELETE FROM dm_threads WHERE id = @id', { id: thread.id });
        }
        // Messages I sent in a thread I somehow no longer sit on.
        removed += (await handle.run('DELETE FROM dm_messages WHERE senderId = @me', { me })).changes || 0;
        return removed;
    }

    async countForUser(userId) {
        const me = String(userId ?? '');
        const threads = await db.get(
            'SELECT COUNT(*) AS c FROM dm_threads WHERE lowId = @me OR highId = @me', { me }
        );
        const messages = await db.get(
            'SELECT COUNT(*) AS c FROM dm_messages WHERE senderId = @me', { me }
        );
        return { threads: Number(threads?.c || 0), messages: Number(messages?.c || 0) };
    }

    // --- Internals ------------------------------------------------------------

    async _threadFor(me, threadId) {
        const id = Number(threadId);
        if (!me || !Number.isSafeInteger(id) || id < 1) {
            throw new DirectMessageError(404, 'NO_SUCH_THREAD', 'No such conversation.');
        }
        const row = await db.get(
            `SELECT t.* FROM dm_threads t
             JOIN dm_participants p ON p.threadId = t.id AND p.userId = @me
             WHERE t.id = @id`,
            { id, me }
        );
        if (!row) throw new DirectMessageError(404, 'NO_SUCH_THREAD', 'No such conversation.');
        return row;
    }

    async _publicThreads(me, rows) {
        if (rows.length === 0) return [];
        const friendService = require('./friendService');
        const others = rows.map(row => (row.lowId === me ? row.highId : row.lowId));
        const [described, friends, online] = await Promise.all([
            friendService.describePeople(others),
            friendService.friendIds(me),
            require('./presenceService').onlineIds(others, { respectVisibility: true })
        ]);
        const ids = rows.map(row => row.id);
        const params = { me };
        const marks = ids.map((id, index) => { params[`t${index}`] = id; return `@t${index}`; });
        const [unreadRows, lastRows] = await Promise.all([
            db.all(
                `SELECT m.threadId, COUNT(*) AS c FROM dm_messages m
                 JOIN dm_participants p ON p.threadId = m.threadId AND p.userId = @me
                 WHERE m.threadId IN (${marks.join(', ')}) AND m.senderId <> @me AND m.id > p.lastReadMessageId
                 GROUP BY m.threadId`,
                params
            ),
            db.all(
                `SELECT m.* FROM dm_messages m
                 JOIN dm_threads t ON t.lastMessageId = m.id
                 WHERE t.id IN (${marks.join(', ')})`,
                params
            )
        ]);
        const unread = new Map(unreadRows.map(row => [Number(row.threadId), Number(row.c)]));
        const last = new Map(lastRows.map(row => [Number(row.threadId), row]));
        return rows.map((row, index) => {
            const otherId = others[index];
            const person = described.get(otherId) || { id: otherId, name: `User ${otherId.slice(-6)}`, avatar: null };
            const lastMessage = last.get(Number(row.id)) || null;
            return {
                id: row.id,
                with: { ...person, online: online.has(otherId) },
                friends: friends.has(otherId),
                unread: unread.get(Number(row.id)) || 0,
                lastMessage: lastMessage ? this._publicMessage(lastMessage, { preview: true }) : null,
                createdAt: row.createdAt,
                lastMessageAt: row.lastMessageAt || null
            };
        });
    }

    _publicMessage(row, { preview = false } = {}) {
        const content = String(row.content ?? '');
        return {
            id: row.id,
            threadId: row.threadId,
            senderId: row.senderId,
            content: preview && content.length > 140 ? `${content.slice(0, 139)}…` : content,
            createdAt: row.createdAt
        };
    }

    /** Both seats refetch the thread list; the open transcript refetches by id. */
    _publish(thread, userIds, { silent = false } = {}) {
        try {
            const eventBus = require('./eventBusService');
            for (const id of new Set(userIds.map(String))) {
                eventBus.publish('dm-message', {
                    userId: id,
                    threadId: thread.id,
                    silent,
                    invalidate: ['dm-threads', `dm-thread:${thread.id}`, 'me']
                });
            }
        } catch { /* cosmetic */ }
    }
}

module.exports = new DirectMessageService();
module.exports.DirectMessageService = DirectMessageService;
module.exports.DirectMessageError = DirectMessageError;
module.exports.MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH;
