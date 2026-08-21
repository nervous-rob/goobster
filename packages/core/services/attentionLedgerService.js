/**
 * The attention ledger: the working set of open loops Goobster believes are
 * currently relevant to one person.
 *
 * This is deliberately a different structure from the knowledge graph. The
 * graph is durable and answers "what does Goobster know?"; the ledger is
 * small, volatile, and answers "what currently matters?". A graph node about
 * a project stays true forever; a ledger item about that project stops
 * mattering the moment the presentation happens.
 *
 * It is called a ledger rather than a task list on purpose: entries are
 * Goobster's beliefs, not the user's commitments. An item is allowed to be
 * wrong, uncertain, or quietly expire, and nothing here obliges the user to
 * do anything.
 *
 * The mutation path follows the knowledge graph's rule — **the model
 * proposes, deterministic code decides**: applyMutations() legalizes an
 * LLM-shaped payload (caps, clamps, kind/state whitelists, provenance
 * required for mined items) before anything is written.
 *
 * Spec: documentation/attention.md
 */

const db = require('../db');
const config = require('../config/attentionConfig');
const domainEventBus = require('./domainEventBus');
const logger = require('../utils/logger');

const {
    ITEM_KINDS,
    ITEM_STATES,
    LIVE_STATES,
    INITIATIVE_LEVELS,
    MAX_SUBJECT_LENGTH,
    MAX_GOAL_LENGTH,
    MAX_UNRESOLVED_ITEMS,
    MAX_UNRESOLVED_LENGTH,
    MAX_ITEMS_PER_USER,
    CATEGORIES
} = config;

const PROVENANCE_KINDS = [
    'memory', 'kg_node', 'message', 'observatory_job', 'followup',
    'automation', 'reflection', 'user', 'tool', 'event'
];

/** Machine-readable ledger error (the EconomyError code+message contract). */
class AttentionError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AttentionError';
        this.code = code;
    }
}

function clamp01(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
}

function normalizeSubject(subject) {
    return String(subject || '').trim().replace(/\s+/g, ' ').slice(0, MAX_SUBJECT_LENGTH);
}

/** 'YYYY-MM-DD HH:MM:SS' UTC text (the timestamp format the tables use). */
function toUtcText(date) {
    return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** Parse a stored/proposed timestamp into UTC text, or null when unusable. */
function normalizeTimestamp(value) {
    if (!value) return null;
    const raw = String(value).trim();
    // Stored values are already UTC text; ISO input from a model is not.
    const date = new Date(/\dT/.test(raw) || /Z$|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return null;
    return toUtcText(date);
}

function normalizeUnresolved(list) {
    if (!Array.isArray(list)) return null;
    const cleaned = list
        .map(entry => String(entry ?? '').trim().slice(0, MAX_UNRESOLVED_LENGTH))
        .filter(Boolean)
        .slice(0, MAX_UNRESOLVED_ITEMS);
    return cleaned.length > 0 ? cleaned : null;
}

function parseJson(text, fallback) {
    if (!text) return fallback;
    try {
        const parsed = JSON.parse(text);
        return parsed ?? fallback;
    } catch {
        return fallback;
    }
}

class AttentionLedgerService {
    get kinds() {
        return ITEM_KINDS;
    }

    get states() {
        return ITEM_STATES;
    }

    /* ------------------------------------------------------------------ */
    /* Reads                                                              */
    /* ------------------------------------------------------------------ */

    /** Shape one row for callers (JSON columns parsed, nothing else changed). */
    present(row) {
        if (!row) return null;
        return {
            id: row.id,
            guildId: row.guildId,
            userId: row.userId,
            kind: row.kind,
            subject: row.subject,
            goal: row.goal || null,
            unresolved: parseJson(row.unresolved, []),
            state: row.state,
            importance: row.importance,
            confidence: row.confidence,
            allowedInitiative: row.allowedInitiative || null,
            category: row.category || 'general',
            deadlineAt: row.deadlineAt || null,
            lastActivityAt: row.lastActivityAt || null,
            expiresAt: row.expiresAt || null,
            corroborations: row.corroborations,
            metadata: parseJson(row.metadata, null),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            resolvedAt: row.resolvedAt || null
        };
    }

    /**
     * One person's ledger.
     * @param {Object} params
     * @param {string} params.userId
     * @param {string} [params.guildId] - restrict to one conversation scope
     * @param {string[]} [params.states] - defaults to the live states
     * @param {string[]} [params.kinds]
     * @param {number} [params.limit]
     * @returns {Promise<Object[]>}
     */
    async listItems({ userId, guildId = null, states = LIVE_STATES, kinds = null, limit = 50 } = {}) {
        if (!userId) return [];
        const stateList = (Array.isArray(states) ? states : [states])
            .filter(state => ITEM_STATES.includes(state));
        if (stateList.length === 0) return [];
        const params = { userId, limit: Math.max(1, Math.min(200, Number(limit) || 50)) };
        const clauses = ['userId = @userId'];

        clauses.push(`state IN (${stateList.map((_, i) => `@state${i}`).join(', ')})`);
        stateList.forEach((state, i) => { params[`state${i}`] = state; });

        if (guildId) {
            clauses.push('guildId = @guildId');
            params.guildId = guildId;
        }
        const kindList = Array.isArray(kinds) ? kinds.filter(k => ITEM_KINDS.includes(k)) : [];
        if (kindList.length > 0) {
            clauses.push(`kind IN (${kindList.map((_, i) => `@kind${i}`).join(', ')})`);
            kindList.forEach((kind, i) => { params[`kind${i}`] = kind; });
        }

        const rows = await db.all(
            `SELECT * FROM attention_items
             WHERE ${clauses.join(' AND ')}
             ORDER BY (importance * confidence) DESC, COALESCE(deadlineAt, '9999') ASC, id DESC
             LIMIT @limit`,
            params
        );
        return rows.map(row => this.present(row));
    }

    async getItem(id) {
        const row = await db.get('SELECT * FROM attention_items WHERE id = @id', { id: Number(id) });
        return this.present(row);
    }

    async findItem({ guildId, userId, kind, subject } = {}) {
        const cleanSubject = normalizeSubject(subject);
        if (!guildId || !userId || !cleanSubject) return null;
        const row = await db.get(
            `SELECT * FROM attention_items
             WHERE guildId = @guildId AND userId = @userId AND kind = @kind AND subject = @subject`,
            { guildId, userId, kind, subject: cleanSubject }
        );
        return this.present(row);
    }

    /**
     * The prompt-facing view of what currently matters. Compact on purpose:
     * this rides in system prompts, so it is a few lines per loop, not a dump.
     * @param {Object} params - { userId, limit }
     * @returns {Promise<string|null>}
     */
    async describeForPrompt({ userId, limit = 8 } = {}) {
        const items = await this.listItems({
            userId,
            states: config.CONTACTABLE_STATES,
            limit
        });
        if (items.length === 0) return null;
        const now = Date.now();
        const lines = items.map(item => {
            const bits = [];
            if (item.deadlineAt) {
                const due = new Date(`${item.deadlineAt.replace(' ', 'T')}Z`).getTime();
                const days = Math.round((due - now) / 86_400_000);
                bits.push(days < 0
                    ? `deadline passed ${Math.abs(days)}d ago`
                    : `deadline in ${days}d`);
            }
            if (item.unresolved.length > 0) bits.push(`open: ${item.unresolved.join('; ')}`);
            return `- [${item.kind}] ${item.subject}${item.goal ? ` — ${item.goal}` : ''}${bits.length ? ` (${bits.join(', ')})` : ''}`;
        });
        return `OPEN LOOPS YOU ARE TRACKING FOR THIS PERSON (your own working notes — bring one up only if it is genuinely relevant to what they just said; never recite the list):\n${lines.join('\n')}`;
    }

    /** Counts by state for status surfaces. */
    async getStats(userId) {
        const rows = await db.all(
            'SELECT state, COUNT(*) AS c FROM attention_items WHERE userId = @userId GROUP BY state',
            { userId }
        );
        const stats = { total: 0 };
        for (const state of ITEM_STATES) stats[state] = 0;
        for (const row of rows) {
            stats[row.state] = row.c;
            stats.total += row.c;
        }
        return stats;
    }

    /* ------------------------------------------------------------------ */
    /* Writes                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Create or update one loop. Identity is (guildId, userId, kind, subject),
     * so re-observing the same loop corroborates it instead of duplicating it:
     * confidence and importance move toward the new evidence, the
     * corroboration counter rises, and a candidate with enough independent
     * support is promoted.
     *
     * @param {Object} item
     * @returns {Promise<{id: number, created: boolean, promoted: boolean}|null>}
     */
    async upsertItem({
        guildId,
        userId,
        kind = 'open_question',
        subject,
        goal = null,
        unresolved = null,
        state = null,
        importance,
        confidence,
        allowedInitiative = null,
        category = null,
        deadlineAt = null,
        lastActivityAt = null,
        expiresAt = null,
        metadata = null,
        corroborate = false
    } = {}) {
        const cleanSubject = normalizeSubject(subject);
        const cleanKind = ITEM_KINDS.includes(kind) ? kind : 'open_question';
        if (!guildId || !userId || !cleanSubject) return null;

        const cleanGoal = goal ? String(goal).trim().slice(0, MAX_GOAL_LENGTH) : null;
        const cleanUnresolved = normalizeUnresolved(unresolved);
        const cleanCategory = category && CATEGORIES.includes(category) ? category : null;
        const cleanInitiative = allowedInitiative && INITIATIVE_LEVELS.includes(allowedInitiative)
            ? allowedInitiative
            : null;
        const cleanState = state && ITEM_STATES.includes(state) ? state : null;

        const existing = await db.get(
            `SELECT * FROM attention_items
             WHERE guildId = @guildId AND userId = @userId AND kind = @kind AND subject = @subject`,
            { guildId, userId, kind: cleanKind, subject: cleanSubject }
        );

        if (existing) {
            // Corroboration nudges confidence up rather than trusting one
            // observation outright: two independent hints beat one confident
            // guess. Promotion out of `candidate` is the only automatic state
            // change - going active or resolved is always explicit.
            const corroborations = existing.corroborations + (corroborate ? 1 : 0);
            const promoted = existing.state === 'candidate' && corroborations >= 2;
            await db.run(
                `UPDATE attention_items SET
                     goal = COALESCE(@goal, goal),
                     unresolved = COALESCE(@unresolved, unresolved),
                     state = @state,
                     importance = COALESCE(@importance, importance),
                     confidence = COALESCE(@confidence, confidence),
                     allowedInitiative = COALESCE(@allowedInitiative, allowedInitiative),
                     category = COALESCE(@category, category),
                     deadlineAt = COALESCE(@deadlineAt, deadlineAt),
                     lastActivityAt = COALESCE(@lastActivityAt, lastActivityAt),
                     expiresAt = COALESCE(@expiresAt, expiresAt),
                     metadata = COALESCE(@metadata, metadata),
                     corroborations = @corroborations,
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                {
                    id: existing.id,
                    goal: cleanGoal,
                    unresolved: cleanUnresolved ? JSON.stringify(cleanUnresolved) : null,
                    state: cleanState || (promoted ? 'corroborated' : existing.state),
                    importance: importance === undefined ? null : clamp01(importance, 0.5),
                    confidence: confidence === undefined ? null : clamp01(confidence, 0.5),
                    allowedInitiative: cleanInitiative,
                    category: cleanCategory,
                    deadlineAt: normalizeTimestamp(deadlineAt),
                    lastActivityAt: normalizeTimestamp(lastActivityAt),
                    expiresAt: normalizeTimestamp(expiresAt),
                    metadata: metadata ? JSON.stringify(metadata) : null,
                    corroborations
                }
            );
            return { id: existing.id, created: false, promoted };
        }

        const id = Number(await db.insert(
            `INSERT INTO attention_items (
                guildId, userId, kind, subject, goal, unresolved, state,
                importance, confidence, allowedInitiative, category,
                deadlineAt, lastActivityAt, expiresAt, metadata
             ) VALUES (
                @guildId, @userId, @kind, @subject, @goal, @unresolved, @state,
                @importance, @confidence, @allowedInitiative, @category,
                @deadlineAt, @lastActivityAt, @expiresAt, @metadata
             )`,
            {
                guildId,
                userId,
                kind: cleanKind,
                subject: cleanSubject,
                goal: cleanGoal,
                unresolved: cleanUnresolved ? JSON.stringify(cleanUnresolved) : null,
                state: cleanState || 'candidate',
                importance: clamp01(importance, 0.5),
                confidence: clamp01(confidence, 0.5),
                allowedInitiative: cleanInitiative,
                category: cleanCategory || 'general',
                deadlineAt: normalizeTimestamp(deadlineAt),
                lastActivityAt: normalizeTimestamp(lastActivityAt) || toUtcText(new Date()),
                expiresAt: normalizeTimestamp(expiresAt),
                metadata: metadata ? JSON.stringify(metadata) : null
            }
        ));
        await this.pruneUser(userId);
        domainEventBus.publish(domainEventBus.TOPICS.ATTENTION_ITEM_CREATED, {
            userId, itemId: id, kind: cleanKind
        });
        return { id, created: true, promoted: false };
    }

    /**
     * Record why an item is believed. Provenance is what makes an uncertain
     * candidate reviewable instead of a hallucination, so mined items are
     * required to carry at least one row.
     * @param {Object} params - { itemId, sourceKind, sourceId, detail }
     * @returns {Promise<boolean>} whether a new row was added
     */
    async addProvenance({ itemId, sourceKind, sourceId = null, detail = null } = {}) {
        if (!itemId || !PROVENANCE_KINDS.includes(sourceKind)) return false;
        const result = await db.run(
            `INSERT INTO attention_provenance (itemId, sourceKind, sourceId, detail)
             VALUES (@itemId, @sourceKind, @sourceId, @detail)
             ON CONFLICT DO NOTHING`,
            {
                itemId: Number(itemId),
                sourceKind,
                sourceId: sourceId === null ? null : String(sourceId),
                detail: detail ? String(detail).slice(0, 500) : null
            }
        );
        return result.changes > 0;
    }

    async getProvenance(itemId) {
        return await db.all(
            `SELECT sourceKind, sourceId, detail, createdAt FROM attention_provenance
             WHERE itemId = @itemId ORDER BY id ASC`,
            { itemId: Number(itemId) }
        );
    }

    /** Mark that a loop moved (any evidence of progress resets staleness). */
    async touchActivity(itemId, at = new Date()) {
        await db.run(
            `UPDATE attention_items
             SET lastActivityAt = @at, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: Number(itemId), at: toUtcText(at instanceof Date ? at : new Date(at)) }
        );
    }

    /**
     * Move an item along its lifecycle. Terminal states stamp resolvedAt so
     * the ledger keeps a short history rather than deleting the evidence.
     * @param {number} itemId
     * @param {string} state
     * @returns {Promise<boolean>}
     */
    async setState(itemId, state) {
        if (!ITEM_STATES.includes(state)) {
            throw new AttentionError('BAD_STATE', `Unknown attention state: ${state}`);
        }
        const terminal = state === 'resolved' || state === 'abandoned';
        const result = await db.run(
            `UPDATE attention_items
             SET state = @state,
                 resolvedAt = ${terminal ? 'CURRENT_TIMESTAMP' : 'NULL'},
                 updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: Number(itemId), state }
        );
        if (result.changes > 0 && terminal) {
            const item = await this.getItem(itemId);
            if (item) {
                domainEventBus.publish(domainEventBus.TOPICS.ATTENTION_ITEM_RESOLVED, {
                    userId: item.userId, itemId: item.id, kind: item.kind, state
                });
            }
        }
        return result.changes > 0;
    }

    /**
     * Retire items that stopped mattering: expired by their own expiresAt,
     * long-resolved, or over the per-person cap (weakest first). Bounding the
     * working set is the point of the layer — an unbounded ledger is just a
     * second knowledge graph.
     * @param {string} userId
     * @returns {Promise<{expired: number, deleted: number}>}
     */
    async pruneUser(userId) {
        if (!userId) return { expired: 0, deleted: 0 };
        const expired = (await db.run(
            `UPDATE attention_items
             SET state = 'abandoned', resolvedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
             WHERE userId = @userId AND expiresAt IS NOT NULL
               AND expiresAt < CURRENT_TIMESTAMP
               AND state IN ('candidate', 'corroborated', 'active')`,
            { userId }
        )).changes;

        // Terminal rows older than a fortnight have served their purpose.
        let deleted = (await db.run(
            `DELETE FROM attention_items
             WHERE userId = @userId AND state IN ('resolved', 'abandoned')
               AND resolvedAt IS NOT NULL
               AND resolvedAt < datetime('now', '-14 days')`,
            { userId }
        )).changes;

        const live = await db.get(
            `SELECT COUNT(*) AS c FROM attention_items
             WHERE userId = @userId AND state IN ('candidate', 'corroborated', 'active')`,
            { userId }
        );
        const overflow = (live?.c || 0) - MAX_ITEMS_PER_USER;
        if (overflow > 0) {
            deleted += (await db.run(
                `DELETE FROM attention_items WHERE id IN (
                    SELECT id FROM attention_items
                    WHERE userId = @userId AND state IN ('candidate', 'corroborated', 'active')
                    ORDER BY (importance * confidence) ASC, COALESCE(lastActivityAt, createdAt) ASC
                    LIMIT @overflow
                 )`,
                { userId, overflow }
            )).changes;
        }
        return { expired, deleted };
    }

    /* ------------------------------------------------------------------ */
    /* Legalizer (the model proposes, this decides)                        */
    /* ------------------------------------------------------------------ */

    /**
     * Apply an LLM-shaped mutation payload to one person's ledger.
     *
     * Accepted shape:
     *   {
     *     upsert:  [{ kind, subject, goal, unresolved: [], importance,
     *                 confidence, category, deadline, provenance: [...] }],
     *     resolve: [{ kind, subject, state: 'resolved'|'abandoned' }],
     *     touch:   [{ kind, subject }]
     *   }
     *
     * Everything is bounded and whitelisted here: unknown kinds/states are
     * dropped, confidence for mined items is capped (they are guesses),
     * resolves may only target items that already exist, and per-run caps
     * bound how much one model response can change.
     *
     * @param {Object} params
     * @returns {Promise<{itemsUpserted: number, itemsCreated: number,
     *                    itemsResolved: number, itemsTouched: number,
     *                    itemsPromoted: number}>}
     */
    async applyMutations({
        guildId,
        userId,
        source = 'reflection',
        mutations = {},
        limits = config.ATTEND
    } = {}) {
        const applied = {
            itemsUpserted: 0,
            itemsCreated: 0,
            itemsResolved: 0,
            itemsTouched: 0,
            itemsPromoted: 0
        };
        if (!guildId || !userId || !mutations || typeof mutations !== 'object') return applied;

        const maxConfidence = limits.maxMinedConfidence ?? 1;
        const upserts = Array.isArray(mutations.upsert)
            ? mutations.upsert.slice(0, limits.maxUpserts ?? 8)
            : [];

        for (const proposal of upserts) {
            if (!proposal || typeof proposal !== 'object') continue;
            const provenance = Array.isArray(proposal.provenance) ? proposal.provenance : [];
            const result = await this.upsertItem({
                guildId,
                userId,
                kind: proposal.kind,
                subject: proposal.subject,
                goal: proposal.goal ?? null,
                unresolved: proposal.unresolved ?? null,
                importance: proposal.importance,
                confidence: Math.min(maxConfidence, clamp01(proposal.confidence, 0.4)),
                category: proposal.category ?? null,
                deadlineAt: proposal.deadline ?? proposal.deadlineAt ?? null,
                expiresAt: proposal.expiresAt ?? null,
                corroborate: true
            });
            if (!result) continue;
            applied.itemsUpserted++;
            if (result.created) applied.itemsCreated++;
            if (result.promoted) applied.itemsPromoted++;
            for (const entry of provenance.slice(0, 6)) {
                await this.addProvenance({
                    itemId: result.id,
                    sourceKind: typeof entry === 'object' ? entry.kind : source,
                    sourceId: typeof entry === 'object' ? entry.id : entry,
                    detail: typeof entry === 'object' ? entry.detail : null
                });
            }
            if (provenance.length === 0) {
                await this.addProvenance({ itemId: result.id, sourceKind: source });
            }
        }

        const resolves = Array.isArray(mutations.resolve)
            ? mutations.resolve.slice(0, limits.maxResolves ?? 6)
            : [];
        for (const proposal of resolves) {
            if (!proposal || typeof proposal !== 'object') continue;
            const state = proposal.state === 'abandoned' ? 'abandoned' : 'resolved';
            const existing = await this.findItem({
                guildId,
                userId,
                kind: ITEM_KINDS.includes(proposal.kind) ? proposal.kind : 'open_question',
                subject: proposal.subject
            });
            if (!existing) continue;
            if (await this.setState(existing.id, state)) applied.itemsResolved++;
        }

        const touches = Array.isArray(mutations.touch) ? mutations.touch.slice(0, 12) : [];
        for (const proposal of touches) {
            if (!proposal || typeof proposal !== 'object') continue;
            const existing = await this.findItem({
                guildId,
                userId,
                kind: ITEM_KINDS.includes(proposal.kind) ? proposal.kind : 'open_question',
                subject: proposal.subject
            });
            if (!existing) continue;
            await this.touchActivity(existing.id);
            applied.itemsTouched++;
        }

        if (applied.itemsUpserted > 0 || applied.itemsResolved > 0) {
            logger.debug?.(`[attention] ledger for ${userId}: ${JSON.stringify(applied)}`);
        }
        return applied;
    }

    /** Whether a legalizer result actually changed anything. */
    static hasWork(applied) {
        if (!applied) return false;
        return Object.values(applied).some(value => typeof value === 'number' && value > 0);
    }

    /** Whether a proposed payload is worth handing to the legalizer at all. */
    static hasPayload(mutations) {
        if (!mutations || typeof mutations !== 'object') return false;
        return ['upsert', 'resolve', 'touch']
            .some(key => Array.isArray(mutations[key]) && mutations[key].length > 0);
    }

    /** Erase one person's ledger (privacy / forget-me). */
    async forgetUser(userId, handle = db) {
        if (!userId) return 0;
        return (await handle.run(
            'DELETE FROM attention_items WHERE userId = @userId',
            { userId }
        )).changes;
    }
}

module.exports = new AttentionLedgerService();
module.exports.AttentionLedgerService = AttentionLedgerService;
module.exports.AttentionError = AttentionError;
module.exports.toUtcText = toUtcText;
module.exports.normalizeTimestamp = normalizeTimestamp;
module.exports.PROVENANCE_KINDS = PROVENANCE_KINDS;
