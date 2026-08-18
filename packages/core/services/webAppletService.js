/**
 * Workshop applets: pinned mini-apps the assistant built in web chat.
 *
 * Discovery scans the user's own web conversations for ```html / ```svg
 * fences (the same blocks the client renders as live applets). Pinning
 * copies the source so a tool survives conversation delete. Nothing is
 * written on discover — pins are the only durable rows.
 *
 * Privacy: /forget-me deletes the table; auditUser counts it.
 */

const crypto = require('node:crypto');
const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');

const FENCE_RE = /```(html|svg)[^\n]*\n([\s\S]*?)```/gi;
const MAX_SOURCE = 200_000;
const MAX_TITLE = 80;
const MAX_PINNED = 40;
const DISCOVER_MESSAGE_LIMIT = 80;
const DISCOVER_RESULT_LIMIT = 40;

class WebAppletError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WebAppletError';
        this.status = status;
        this.code = code;
    }
}

function stripTags(text) {
    return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleFromSource(source, language) {
    const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (title) {
        const clean = stripTags(title[1]);
        if (clean) return clean.slice(0, MAX_TITLE);
    }
    const heading = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (heading) {
        const clean = stripTags(heading[1]);
        if (clean) return clean.slice(0, MAX_TITLE);
    }
    return language === 'svg' ? 'Untitled drawing' : 'Untitled applet';
}

function contentHash(language, source) {
    return crypto.createHash('sha256').update(`${language}\n${source}`).digest('hex');
}

/**
 * Pull html/svg fences out of a markdown message. Exported for tests.
 * @param {string} text
 * @returns {Array<{language:string, source:string, title:string}>}
 */
function extractApplets(text) {
    const out = [];
    if (!text) return out;
    const re = new RegExp(FENCE_RE.source, 'gi');
    let match;
    while ((match = re.exec(text))) {
        const language = match[1].toLowerCase();
        const source = String(match[2] || '').trim();
        if (!source || source.length > MAX_SOURCE) continue;
        out.push({
            language,
            source,
            title: titleFromSource(source, language)
        });
    }
    return out;
}

function serialize(row) {
    return {
        id: row.id,
        title: row.title,
        language: row.language,
        source: row.source,
        conversationId: row.conversationId ?? null,
        conversationTitle: row.conversationTitle || null,
        messageId: row.messageId ?? null,
        pinned: true,
        createdAt: row.createdAt,
        lastOpenedAt: row.lastOpenedAt || null
    };
}

class WebAppletService {
    /**
     * Pinned applets for the Workshop, newest first.
     * @param {string} userId
     */
    async listPinned(userId) {
        return (await db.all(
            `SELECT a.id, a.title, a.language, a.source, a.conversationId, a.messageId,
                    a.createdAt, a.lastOpenedAt, wc.title AS conversationTitle
             FROM web_applets a
             LEFT JOIN web_conversations wc ON wc.id = a.conversationId
             WHERE a.userId = @userId
             ORDER BY COALESCE(a.lastOpenedAt, a.createdAt) DESC, a.id DESC
             LIMIT @limit`,
            { userId, limit: MAX_PINNED }
        )).map(serialize);
    }

    /**
     * Scan recent assistant messages for unpinned applets.
     * @param {string} userId
     */
    async discover(userId) {
        const pinned = new Set((await db.all(
            'SELECT contentHash FROM web_applets WHERE userId = @userId',
            { userId }
        )).map(row => row.contentHash));

        const rows = await db.all(
            `SELECT m.id AS messageId, m.message, wc.id AS conversationId, wc.title AS conversationTitle
             FROM messages m
             JOIN guild_conversations gc ON gc.id = m.guildConversationId
             JOIN web_conversations wc ON wc.channelId = gc.channelId AND wc.userId = @userId
             WHERE gc.guildId = @scope AND m.isBot = 1
               AND (m.message LIKE '%\`\`\`html%' OR m.message LIKE '%\`\`\`svg%')
             ORDER BY m.id DESC LIMIT @limit`,
            { userId, scope: dmScopeId(userId), limit: DISCOVER_MESSAGE_LIMIT }
        );

        const found = [];
        const seen = new Set();
        for (const row of rows) {
            for (const applet of extractApplets(row.message)) {
                const hash = contentHash(applet.language, applet.source);
                if (pinned.has(hash) || seen.has(hash)) continue;
                seen.add(hash);
                found.push({
                    id: null,
                    title: applet.title,
                    language: applet.language,
                    source: applet.source,
                    conversationId: row.conversationId,
                    conversationTitle: row.conversationTitle || null,
                    messageId: row.messageId,
                    pinned: false,
                    contentHash: hash,
                    createdAt: null,
                    lastOpenedAt: null
                });
                if (found.length >= DISCOVER_RESULT_LIMIT) return found;
            }
        }
        return found;
    }

    /**
     * Workshop payload: pinned copies plus unpinned discoveries.
     * @param {string} userId
     */
    async listWorkshop(userId) {
        return {
            pinned: await this.listPinned(userId),
            discovered: await this.discover(userId)
        };
    }

    /**
     * Pin a mini-app. Same source + language for the same user is a no-op
     * that returns the existing row (re-pinning from chat is idempotent).
     * @param {Object} params
     */
    async pin({ userId, title, language, source, conversationId = null, messageId = null }) {
        const lang = String(language || '').toLowerCase();
        if (lang !== 'html' && lang !== 'svg') {
            throw new WebAppletError(400, 'BAD_LANGUAGE', 'Applets must be html or svg.');
        }
        const body = String(source || '').trim();
        if (!body) {
            throw new WebAppletError(400, 'BAD_SOURCE', 'Applet source is empty.');
        }
        if (body.length > MAX_SOURCE) {
            throw new WebAppletError(400, 'SOURCE_TOO_LARGE',
                `Applet source is too large (${MAX_SOURCE} character cap).`);
        }

        const hash = contentHash(lang, body);
        const existing = await db.get(
            'SELECT id FROM web_applets WHERE userId = @userId AND contentHash = @hash',
            { userId, hash }
        );
        if (existing) {
            return await this.get({ userId, appletId: existing.id });
        }

        const count = await db.get(
            'SELECT COUNT(*) AS c FROM web_applets WHERE userId = @userId',
            { userId }
        );
        if ((count?.c || 0) >= MAX_PINNED) {
            throw new WebAppletError(400, 'PIN_LIMIT',
                `You can pin ${MAX_PINNED} applets. Unpin one to keep another.`);
        }

        let conversation = null;
        if (conversationId !== null && conversationId !== undefined && conversationId !== '') {
            conversation = await db.get(
                'SELECT id, title FROM web_conversations WHERE id = @id AND userId = @userId',
                { id: Number(conversationId), userId }
            );
        }

        const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE)
            || titleFromSource(body, lang);

        const row = await db.get(
            `INSERT INTO web_applets
                (userId, contentHash, title, language, source, conversationId, messageId)
             VALUES (@userId, @hash, @title, @language, @source, @conversationId, @messageId)
             RETURNING id, title, language, source, conversationId, messageId, createdAt, lastOpenedAt`,
            {
                userId,
                hash,
                title: cleanTitle,
                language: lang,
                source: body,
                conversationId: conversation?.id ?? null,
                messageId: messageId ? Number(messageId) : null
            }
        );
        return { ...serialize(row), conversationTitle: conversation?.title || null };
    }

    /**
     * One pinned applet the user owns.
     */
    async get({ userId, appletId }) {
        const row = await db.get(
            `SELECT a.id, a.title, a.language, a.source, a.conversationId, a.messageId,
                    a.createdAt, a.lastOpenedAt, wc.title AS conversationTitle
             FROM web_applets a
             LEFT JOIN web_conversations wc ON wc.id = a.conversationId
             WHERE a.id = @appletId AND a.userId = @userId`,
            { appletId: Number(appletId), userId }
        );
        if (!row) {
            throw new WebAppletError(404, 'NOT_FOUND', 'No such pinned applet.');
        }
        return serialize(row);
    }

    /**
     * Rename or mark opened. Source is immutable (re-pin a new version).
     */
    async update({ userId, appletId, title = undefined, touchOpened = false }) {
        await this.get({ userId, appletId });
        const fields = [];
        const params = { appletId: Number(appletId), userId };
        if (title !== undefined) {
            const clean = String(title || '').trim().slice(0, MAX_TITLE);
            if (!clean) {
                throw new WebAppletError(400, 'BAD_TITLE', 'Title cannot be empty.');
            }
            fields.push('title = @title');
            params.title = clean;
        }
        if (touchOpened) {
            fields.push("lastOpenedAt = datetime('now')");
        }
        if (fields.length === 0) {
            return await this.get({ userId, appletId });
        }
        await db.run(
            `UPDATE web_applets SET ${fields.join(', ')}
             WHERE id = @appletId AND userId = @userId`,
            params
        );
        return await this.get({ userId, appletId });
    }

    /**
     * Unpin (delete the stored copy). Discovered applets have no row.
     */
    async unpin({ userId, appletId }) {
        const result = await db.run(
            'DELETE FROM web_applets WHERE id = @appletId AND userId = @userId',
            { appletId: Number(appletId), userId }
        );
        if (result.changes === 0) {
            throw new WebAppletError(404, 'NOT_FOUND', 'No such pinned applet.');
        }
        return { deleted: true };
    }

    /** /forget-me: every pin belonging to the user. */
    async forgetUser(userId) {
        return (await db.run(
            'DELETE FROM web_applets WHERE userId = @userId',
            { userId }
        )).changes;
    }

    async countUser(userId) {
        return (await db.get(
            'SELECT COUNT(*) AS c FROM web_applets WHERE userId = @userId',
            { userId }
        ))?.c || 0;
    }
}

module.exports = new WebAppletService();
module.exports.WebAppletError = WebAppletError;
module.exports.extractApplets = extractApplets;
module.exports.titleFromSource = titleFromSource;
