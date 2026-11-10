/**
 * Source adapter `followed_source` (DA-8, ADR 0026): an item the person
 * kept from a source they follow.
 *
 * Keeping an item is the person saying "this matters"; the adapter turns
 * that into one proposed piece of work. Nothing else in a followed source
 * is an opportunity - a new entry nobody kept is observed and never
 * proposed - and an item kept before the responsibility existed is history.
 *
 * It reads only sources the responsibility names: a `read` grant on the
 * process `followed_source:<id>`, the scope `followed_source`, and a source
 * the acting person owns. Unfollowing a source, un-keeping an item, or
 * revoking the grant takes the proposal away on the next pass (`stale`).
 *
 * Record adapter. A source per entry: `entry:<id>`; the cursor remembers
 * whether the entry was kept, so un-keep then keep again is the same
 * opportunity, not a second one (the proposal is deduplicated on the
 * content hash).
 */

const db = require('../../../db');
const { fingerprint } = require('./fingerprint');
const access = require('./access');

const KIND = 'followed_source';
const SCOPE = 'followed_source';
const CAPABILITY = 'sources';
const MAX_PER_DAY = 3;
/** Entries older than this are not looked at. */
const WINDOW_DAYS = 30;
/** Entries examined per source and pass. */
const PER_SOURCE = 50;
/** The most of an entry's saved text that enters a run's prompt. */
const TEXT_CHARS = 6000;

const PROCESS_REF = /^followed_source:(\d+)$/;

function utcText(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** The followed sources this responsibility may read, by id. */
async function readable(responsibility, { preview = false } = {}) {
    if (!access.scoped(responsibility, KIND)) return [];
    const wanted = new Set();
    for (const resource of access.grants(responsibility, 'read', 'process')) {
        for (const ref of resource.ids || []) {
            const match = PROCESS_REF.exec(String(ref));
            if (match) wanted.add(Number(match[1]));
        }
    }
    const out = [];
    for (const id of wanted) {
        if (await access.permits(responsibility, 'read', { kind: 'process', id: `followed_source:${id}` }, { preview })) out.push(id);
    }
    return out;
}

module.exports = {
    KIND,
    SCOPE,
    capability: CAPABILITY,
    MAX_PER_DAY,
    TEXT_CHARS,

    dailyCap() { return MAX_PER_DAY; },

    async read(responsibility, { now = new Date() } = {}) {
        const actor = access.actorOf(responsibility);
        const since = utcText(new Date(now.getTime() - WINDOW_DAYS * 86400000));
        const out = [];
        for (const id of await readable(responsibility)) {
            const rows = await db.all(
                `SELECT e.id, e.sourceId, e.contentHash, e.kept, s.label
                 FROM followed_source_entries e
                 JOIN followed_sources s ON s.id = e.sourceId
                 WHERE e.sourceId = @id AND s.userId = @actor AND e.isChange = 1 AND e.retrievedAt >= @since
                 ORDER BY e.id DESC LIMIT @limit`,
                { id, actor, since, limit: PER_SOURCE }
            );
            for (const row of rows) {
                const kept = Number(row.kept) === 1;
                out.push({
                    sourceId: `entry:${Number(row.id)}`,
                    revision: fingerprint([row.contentHash]),
                    cursorRevision: `${kept ? 'kept' : 'seen'}:${row.contentHash}`,
                    observe: !kept,
                    title: `Kept an item from "${String(row.label || 'a followed source').slice(0, 120)}"`,
                    reason: 'an item you kept from a source you follow',
                    category: 'research',
                    origin: { kind: 'followed_source_entry', followedSourceId: Number(row.sourceId), entryId: Number(row.id) }
                });
            }
        }
        return out;
    },

    /** Proposed or queued attempts whose item is gone, un-kept or no longer covered. */
    async stale(responsibility) {
        const out = [];
        for (const attempt of await access.openAttempts(db, responsibility, KIND)) {
            const found = await module.exports.locate(responsibility, attempt.origin);
            if (!found.ok) out.push({ id: attempt.id, code: found.code });
        }
        return out;
    },

    /**
     * The entry an attempt came from, as it is now, for the person the
     * responsibility acts for.
     * @returns {Promise<{ ok: true, entry: Object } | { ok: false, code: 'SOURCE_GONE'|'SOURCE_NOT_COVERED' }>}
     */
    async locate(responsibility, originValue) {
        const origin = access.originOf(originValue);
        if (!origin || origin.kind !== 'followed_source_entry') return { ok: false, code: 'SOURCE_GONE' };
        const entry = await db.get(
            `SELECT e.id, e.sourceId, e.url, e.title, e.author, e.publishedAt, e.extractedText, e.kept, s.label
             FROM followed_source_entries e
             JOIN followed_sources s ON s.id = e.sourceId
             WHERE e.id = @id AND e.sourceId = @sourceId AND s.userId = @actor AND e.isChange = 1`,
            { id: Number(origin.entryId), sourceId: Number(origin.followedSourceId), actor: access.actorOf(responsibility) }
        );
        if (!entry || Number(entry.kept) !== 1) return { ok: false, code: 'SOURCE_GONE' };
        if (!access.scoped(responsibility, KIND)
            || !(await access.permits(responsibility, 'read', { kind: 'process', id: `followed_source:${Number(entry.sourceId)}` }))) {
            return { ok: false, code: 'SOURCE_NOT_COVERED' };
        }
        return { ok: true, entry };
    },

    /** What the owner sees before activating: items already kept, which count as history. */
    async lookback(responsibility) {
        const actor = access.actorOf(responsibility);
        const examples = [];
        let ignored = 0;
        const ids = await readable(responsibility, { preview: true });
        for (const id of ids) {
            const rows = await db.all(
                `SELECT e.title, s.label FROM followed_source_entries e JOIN followed_sources s ON s.id = e.sourceId
                 WHERE e.sourceId = @id AND s.userId = @actor AND e.isChange = 1 AND e.kept = 1 ORDER BY e.id DESC LIMIT 50`,
                { id, actor }
            );
            ignored += rows.length;
            for (const row of rows) if (examples.length < 3) examples.push(`Kept an item from "${String(row.label).slice(0, 80)}"`);
        }
        return { sources: ids.length, ignored, examples };
    }
};
