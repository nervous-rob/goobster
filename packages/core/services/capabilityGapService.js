/**
 * Capability gaps (documentation/capability_gaps.md): the things Goobster
 * was asked to do and found no tool for, recorded by the model through the
 * noteCapabilityGap tool and read by the operator in the Host room as a
 * backlog of what to build next.
 *
 * Anonymous and aggregated on purpose: one row per distinct capability,
 * counted, with no actor and no conversation text. The capability is a
 * short generic phrase; anything longer is clipped, and the tool's
 * description tells the model never to put names, content or links in it.
 */

const db = require('../db');
const logger = require('../utils/logger');

const MAX_CAPABILITY_CHARS = 160;
const MAX_AREA_CHARS = 40;
const MIN_CAPABILITY_CHARS = 8;
const MAX_ROWS = 500;
const STATUSES = Object.freeze(['open', 'planned', 'dismissed']);

class CapabilityGapError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'CapabilityGapError';
        this.status = status;
        this.code = code;
    }
}

function clean(text, max) {
    return String(text ?? '')
        .split('')
        .map(ch => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
        .join('')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** The phrase two reports of the same gap share: lowercase words only. */
function gapKeyOf(capability) {
    return capability.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Count one sighting of a missing capability. Best effort: never throws
 * into the turn that hit the gap; a refusal comes back as { ok: false }.
 * @returns {Promise<{ ok: boolean, id?: number, hits?: number, status?: string, code?: string }>}
 */
async function note({ capability, area = null } = {}) {
    const text = clean(capability, MAX_CAPABILITY_CHARS);
    if (text.length < MIN_CAPABILITY_CHARS) return { ok: false, code: 'TOO_SHORT' };
    const gapKey = gapKeyOf(text);
    if (!gapKey) return { ok: false, code: 'TOO_SHORT' };
    const cleanArea = clean(area, MAX_AREA_CHARS) || null;
    try {
        const existing = await db.get('SELECT id FROM capability_gaps WHERE gapKey = @gapKey', { gapKey });
        if (!existing) {
            const total = (await db.get('SELECT COUNT(*) AS c FROM capability_gaps'))?.c || 0;
            if (total >= MAX_ROWS) return { ok: false, code: 'FULL' };
        }
        const row = await db.get(
            `INSERT INTO capability_gaps (gapKey, capability, area)
             VALUES (@gapKey, @capability, @area)
             ON CONFLICT(gapKey) DO UPDATE SET
                hits = capability_gaps.hits + 1,
                lastSeenAt = datetime('now'),
                area = COALESCE(capability_gaps.area, excluded.area)
             RETURNING id, hits, status`,
            { gapKey, capability: text, area: cleanArea }
        );
        return { ok: true, id: row?.id, hits: row?.hits, status: row?.status };
    } catch (error) {
        logger.warn?.(`[capability-gaps] could not record a gap: ${error.message}`);
        return { ok: false, code: 'UNAVAILABLE' };
    }
}

/** The backlog, most-hit first. status: one of STATUSES or 'all'. */
async function list({ status = 'open', limit = 100 } = {}) {
    const max = Math.min(Math.max(Number(limit) || 100, 1), MAX_ROWS);
    const where = status === 'all' ? '' : 'WHERE status = @status';
    if (status !== 'all' && !STATUSES.includes(status)) {
        throw new CapabilityGapError(400, 'BAD_STATUS', `status is one of ${STATUSES.join(', ')} or all.`);
    }
    const gaps = await db.all(
        `SELECT id, capability, area, hits, status, firstSeenAt, lastSeenAt
         FROM capability_gaps ${where} ORDER BY hits DESC, lastSeenAt DESC LIMIT ${max}`,
        { status }
    );
    const counts = await db.all('SELECT status, COUNT(*) AS c FROM capability_gaps GROUP BY status');
    return { gaps, counts: Object.fromEntries(counts.map(row => [row.status, row.c])) };
}

/** Mark a gap planned, dismissed or open again. */
async function setStatus(id, status) {
    if (!STATUSES.includes(status)) {
        throw new CapabilityGapError(400, 'BAD_STATUS', `status is one of ${STATUSES.join(', ')}.`);
    }
    const row = await db.get(
        'UPDATE capability_gaps SET status = @status WHERE id = @id RETURNING id, capability, status',
        { id: Number(id), status }
    );
    if (!row) throw new CapabilityGapError(404, 'NOT_FOUND', 'No such capability gap.');
    return row;
}

/** Delete one gap (it was built, or it was noise). */
async function remove(id) {
    const row = await db.get('DELETE FROM capability_gaps WHERE id = @id RETURNING id, capability', { id: Number(id) });
    if (!row) throw new CapabilityGapError(404, 'NOT_FOUND', 'No such capability gap.');
    return row;
}

module.exports = { note, list, setStatus, remove, gapKeyOf, STATUSES, MAX_ROWS, CapabilityGapError };
