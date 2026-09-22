/**
 * Activity correlation (package E5).
 *
 * An attention notice that `_contact` also delivered to the Inbox is one
 * item. The inbox row already records the link (`kind = 'notice'`,
 * `sourceType = 'attention'`, `sourceId` = the notice ids, comma-joined).
 * This module reads that link in both directions so each view can name the
 * other. It does not merge the stores, move an action, or count a notice
 * as a second unread item — the sidebar badge stays `inboxService.unreadCount`.
 *
 * Acknowledge, snooze and dismiss stay `attentionService.actOnNotice`.
 * Read and archive stay inbox writes. A later read of either side shows
 * what the other side did.
 */

const db = require('../db');

const SOURCE_TYPE = 'attention';
const INBOX_PATH = '/activity/inbox';

/** Integer ids. Postgres returns BIGINT as a number; coerce so a string never misses the map. */
function asId(value) {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 1 ? value : null;
    const id = Number(String(value ?? '').trim());
    return Number.isInteger(id) && id >= 1 ? id : null;
}

function parseNoticeIds(sourceId) {
    if (sourceId == null || sourceId === '') return [];
    const ids = [];
    const seen = new Set();
    for (const part of String(sourceId).split(',')) {
        const id = asId(part);
        if (id == null || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

function presentNoticeLink(row) {
    return {
        id: asId(row.id),
        title: row.title,
        status: row.status,
        snoozeUntil: row.snoozeUntil || null
    };
}

function presentMissingNotice(id) {
    return { id, title: null, status: null, snoozeUntil: null };
}

/**
 * Notices named by attention-sourced inbox rows, keyed by notice id.
 * One query for a page. Only the row's own user is visible.
 * @param {Object[]} rows - inbox_items rows
 * @returns {Promise<Map<number, Object>>}
 */
async function noticesByIdForRows(rows) {
    const map = new Map();
    const byUser = new Map();
    for (const row of rows || []) {
        if (row?.sourceType !== SOURCE_TYPE) continue;
        const userId = String(row.userId);
        const ids = parseNoticeIds(row.sourceId);
        if (ids.length === 0) continue;
        if (!byUser.has(userId)) byUser.set(userId, new Set());
        const bucket = byUser.get(userId);
        for (const id of ids) bucket.add(id);
    }
    for (const [userId, idSet] of byUser) {
        const ids = [...idSet];
        const params = { userId };
        ids.forEach((id, i) => { params[`id${i}`] = id; });
        const found = await db.all(
            `SELECT id, title, status, snoozeUntil FROM attention_notices
             WHERE userId = @userId AND id IN (${ids.map((_, i) => `@id${i}`).join(', ')})`,
            params
        );
        for (const row of found) {
            const link = presentNoticeLink(row);
            if (link.id != null) map.set(link.id, link);
        }
    }
    return map;
}

/**
 * The attention half of one inbox row, or null when this row is not a
 * notice delivery. Missing notice rows stay in the list (id only) so the
 * Inbox can still say what it delivered.
 */
function presentDelivery(row, noticeById) {
    if (!row || row.sourceType !== SOURCE_TYPE) return null;
    const ids = parseNoticeIds(row.sourceId);
    if (ids.length === 0) return null;
    return {
        notices: ids.map((id) => (noticeById && noticeById.get(id)) || presentMissingNotice(id))
    };
}

function presentInboxDelivery(row) {
    return {
        itemId: asId(row.id),
        read: Boolean(row.readAt),
        archived: Boolean(row.archivedAt),
        link: INBOX_PATH
    };
}

/**
 * Inbox rows that delivered this person's notices, keyed by notice id.
 * The newest row wins if a notice was ever named twice.
 * @param {string} userId
 * @returns {Promise<Map<number, Object>>}
 */
async function inboxByNoticeId(userId) {
    const map = new Map();
    if (!userId) return map;
    const rows = await db.all(
        `SELECT id, sourceId, readAt, archivedAt
         FROM inbox_items
         WHERE userId = @userId AND sourceType = @sourceType AND kind = 'notice'`,
        { userId: String(userId), sourceType: SOURCE_TYPE }
    );
    for (const row of rows) {
        const delivery = presentInboxDelivery(row);
        for (const id of parseNoticeIds(row.sourceId)) {
            const prev = map.get(id);
            if (!prev || delivery.itemId > prev.itemId) map.set(id, delivery);
        }
    }
    return map;
}

/** Attach `inboxDelivery` onto presented notices. Absent when `_contact` never filed one. */
async function attachToNotices(userId, notices) {
    const index = await inboxByNoticeId(userId);
    return (notices || []).map((notice) => ({
        ...notice,
        inboxDelivery: index.get(asId(notice.id)) || null
    }));
}

module.exports = {
    SOURCE_TYPE,
    INBOX_PATH,
    parseNoticeIds,
    noticesByIdForRows,
    presentDelivery,
    inboxByNoticeId,
    attachToNotices
};
