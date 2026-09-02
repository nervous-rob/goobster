/**
 * The initiative policy: how much agency Goobster has over one person's
 * attention, and where the hard edges are.
 *
 * Two levers, deliberately separate:
 *
 *  1. **Initiative level** (observe / nudge / assist / delegate) — how loudly
 *     Goobster may act at all. This caps the disposition of every
 *     intervention, so one setting turns the whole system down without
 *     switching it off.
 *  2. **Per-category boundaries** — what kind of work is allowed within a
 *     domain (research, calendar, github, ...). Reading a repo and pushing to
 *     it are not the same permission, and no single "proactive mode" flag can
 *     express that difference.
 *
 * Enrollment is explicit, matching /proactive and /monologue: **no row means
 * the attention system does not run for that person at all.** Nobody gets
 * proactively messaged because a feature shipped.
 *
 * Spec: documentation/attention.md
 */

const db = require('../db');
const config = require('../config/attentionConfig');
const { initiativeAllows } = require('../utils/attentionScore');

const { INITIATIVE_LEVELS, DEFAULT_BOUNDARIES, CATEGORIES, HEARTBEAT } = config;

/** What each action needs from a category boundary. */
const ACTIONS = ['read', 'compute', 'write'];

/** The minimum initiative level each action class requires. */
const ACTION_INITIATIVE = {
    read: 'nudge',
    compute: 'assist',
    write: 'delegate'
};

class AttentionPolicyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AttentionPolicyError';
        this.code = code;
    }
}

function parseJson(text, fallback) {
    if (!text) return fallback;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function normalizeMinute(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n) || n < 0 || n > 1439) return null;
    return n;
}

class AttentionPolicyService {
    get initiativeLevels() {
        return INITIATIVE_LEVELS;
    }

    get categories() {
        return CATEGORIES;
    }

    present(row) {
        if (!row) return null;
        return {
            userId: row.userId,
            initiative: row.initiative,
            boundaries: parseJson(row.boundaries, {}),
            quietStartMinute: row.quietStartMinute ?? null,
            quietEndMinute: row.quietEndMinute ?? null,
            maxContactsPerDay: row.maxContactsPerDay,
            contactCooldownMinutes: row.contactCooldownMinutes,
            enabled: Boolean(row.enabled),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        };
    }

    /**
     * One person's policy, or null when they never opted in.
     * @param {string} userId
     * @returns {Promise<Object|null>}
     */
    async get(userId) {
        if (!userId) return null;
        const row = await db.get(
            'SELECT * FROM attention_policies WHERE userId = @userId',
            { userId }
        );
        return this.present(row);
    }

    /**
     * Enroll a person (idempotent). This is the opt-in: until it is called,
     * nothing in the attention system touches them.
     * @param {Object} params - { userId, initiative }
     * @returns {Promise<Object>} the policy
     */
    async enroll({ userId, initiative = 'nudge' } = {}) {
        if (!userId) throw new AttentionPolicyError('BAD_USER', 'A user id is required.');
        const level = INITIATIVE_LEVELS.includes(initiative) ? initiative : 'nudge';
        const existing = await this.get(userId);
        if (existing) {
            if (!existing.enabled) {
                await db.run(
                    `UPDATE attention_policies
                     SET enabled = 1, updatedAt = CURRENT_TIMESTAMP WHERE userId = @userId`,
                    { userId }
                );
                return await this.get(userId);
            }
            return existing;
        }
        await db.run(
            `INSERT INTO attention_policies
                (userId, initiative, maxContactsPerDay, contactCooldownMinutes)
             VALUES (@userId, @initiative, @maxContacts, @cooldown)`,
            {
                userId,
                initiative: level,
                maxContacts: HEARTBEAT.maxContactsPerDay,
                cooldown: HEARTBEAT.contactCooldownMinutes
            }
        );
        return await this.get(userId);
    }

    /**
     * Stop the attention system for a person without discarding their
     * settings or their ledger (re-enrolling picks up where they left off).
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    async disable(userId) {
        const result = await db.run(
            `UPDATE attention_policies
             SET enabled = 0, updatedAt = CURRENT_TIMESTAMP WHERE userId = @userId`,
            { userId }
        );
        return result.changes > 0;
    }

    /**
     * @param {string} userId
     * @param {string} initiative - observe | nudge | assist | delegate
     * @returns {Promise<Object>} the updated policy
     */
    async setInitiative(userId, initiative) {
        if (!INITIATIVE_LEVELS.includes(initiative)) {
            throw new AttentionPolicyError('BAD_INITIATIVE',
                `Initiative must be one of: ${INITIATIVE_LEVELS.join(', ')}.`);
        }
        await this.enroll({ userId, initiative });
        await db.run(
            `UPDATE attention_policies
             SET initiative = @initiative, updatedAt = CURRENT_TIMESTAMP WHERE userId = @userId`,
            { userId, initiative }
        );
        return await this.get(userId);
    }

    /**
     * Override one category's boundary. Unspecified fields fall back to the
     * shipped default for that category, so a partial override is safe.
     * @param {Object} params - { userId, category, proactiveRead,
     *   proactiveCompute, externalWrite }
     * @returns {Promise<Object>} the updated policy
     */
    async setBoundary({ userId, category, proactiveRead, proactiveCompute, externalWrite } = {}) {
        if (!CATEGORIES.includes(category)) {
            throw new AttentionPolicyError('BAD_CATEGORY',
                `Category must be one of: ${CATEGORIES.join(', ')}.`);
        }
        if (externalWrite !== undefined
            && ![true, false, 'confirm', 'never'].includes(externalWrite)) {
            throw new AttentionPolicyError('BAD_BOUNDARY',
                'externalWrite must be true, false, "confirm", or "never".');
        }
        const policy = await this.enroll({ userId });
        const boundaries = { ...policy.boundaries };
        const current = boundaries[category] || {};
        boundaries[category] = {
            ...current,
            ...(proactiveRead === undefined ? {} : { proactiveRead: Boolean(proactiveRead) }),
            ...(proactiveCompute === undefined ? {} : { proactiveCompute: Boolean(proactiveCompute) }),
            ...(externalWrite === undefined ? {} : { externalWrite })
        };
        await db.run(
            `UPDATE attention_policies
             SET boundaries = @boundaries, updatedAt = CURRENT_TIMESTAMP WHERE userId = @userId`,
            { userId, boundaries: JSON.stringify(boundaries) }
        );
        return await this.get(userId);
    }

    /**
     * Set (or clear, with nulls) the do-not-disturb window. Minutes from UTC
     * midnight; a window that wraps past midnight is supported.
     * @param {Object} params - { userId, startMinute, endMinute }
     * @returns {Promise<Object>}
     */
    async setQuietHours({ userId, startMinute = null, endMinute = null } = {}) {
        await this.enroll({ userId });
        const start = normalizeMinute(startMinute);
        const end = normalizeMinute(endMinute);
        if ((start === null) !== (end === null)) {
            throw new AttentionPolicyError('BAD_QUIET_HOURS',
                'Quiet hours need both a start and an end (or neither, to clear them).');
        }
        await db.run(
            `UPDATE attention_policies
             SET quietStartMinute = @start, quietEndMinute = @end, updatedAt = CURRENT_TIMESTAMP
             WHERE userId = @userId`,
            { userId, start, end }
        );
        return await this.get(userId);
    }

    /**
     * Set the contact budget.
     * @param {Object} params - { userId, maxContactsPerDay, contactCooldownMinutes }
     * @returns {Promise<Object>}
     */
    async setBudget({ userId, maxContactsPerDay = null, contactCooldownMinutes = null } = {}) {
        const policy = await this.enroll({ userId });
        const maxContacts = maxContactsPerDay === null
            ? policy.maxContactsPerDay
            : Math.max(0, Math.min(20, Math.trunc(Number(maxContactsPerDay) || 0)));
        const cooldown = contactCooldownMinutes === null
            ? policy.contactCooldownMinutes
            : Math.max(5, Math.min(24 * 60, Math.trunc(Number(contactCooldownMinutes) || 0)));
        await db.run(
            `UPDATE attention_policies
             SET maxContactsPerDay = @maxContacts, contactCooldownMinutes = @cooldown,
                 updatedAt = CURRENT_TIMESTAMP
             WHERE userId = @userId`,
            { userId, maxContacts, cooldown }
        );
        return await this.get(userId);
    }

    /**
     * Everyone the attention system should consider, least-recently-swept
     * first, with anyone an event has dirtied jumping the queue.
     * @param {number} [limit]
     * @returns {Promise<Object[]>} policies (with lastSweepAt / dirtyAt)
     */
    async listActive(limit = HEARTBEAT.maxUsersPerTick) {
        const rows = await db.all(
            `SELECT p.*, s.lastSweepAt, s.lastContactAt, s.dirtyAt
             FROM attention_policies p
             LEFT JOIN attention_state s ON s.userId = p.userId
             WHERE p.enabled = 1
             ORDER BY (CASE WHEN s.dirtyAt IS NOT NULL THEN 0 ELSE 1 END) ASC,
                      COALESCE(s.lastSweepAt, '0000') ASC
             LIMIT @limit`,
            { limit: Math.max(1, Math.min(100, Number(limit) || 8)) }
        );
        return rows.map(row => ({
            ...this.present(row),
            lastSweepAt: row.lastSweepAt || null,
            lastContactAt: row.lastContactAt || null,
            dirtyAt: row.dirtyAt || null
        }));
    }

    /* ------------------------------------------------------------------ */
    /* Pure decisions over a loaded policy                                 */
    /* ------------------------------------------------------------------ */

    /**
     * A category's effective boundary: the shipped default, overridden by
     * whatever the user changed.
     * @param {Object|null} policy
     * @param {string} category
     * @returns {{proactiveRead: boolean, proactiveCompute: boolean, externalWrite: (boolean|string)}}
     */
    boundariesFor(policy, category) {
        const base = DEFAULT_BOUNDARIES[category] || DEFAULT_BOUNDARIES.general;
        const override = policy?.boundaries?.[category] || {};
        return { ...base, ...override };
    }

    /**
     * Whether one action class is permitted in a category. Both gates must
     * pass: the initiative level (how much agency at all) and the category
     * boundary (what is allowed in this domain).
     * @param {Object|null} policy
     * @param {string} category
     * @param {'read'|'compute'|'write'} action
     * @returns {true|'confirm'|false}
     */
    allows(policy, category, action) {
        if (!policy?.enabled) return false;
        if (!ACTIONS.includes(action)) return false;
        if (!initiativeAllows(policy.initiative, ACTION_INITIATIVE[action])) return false;

        const boundary = this.boundariesFor(policy, category);
        if (action === 'read') return boundary.proactiveRead === true;
        if (action === 'compute') return boundary.proactiveCompute === true;

        const write = boundary.externalWrite;
        if (write === true) return true;
        if (write === 'confirm') return 'confirm';
        return false;
    }

    /**
     * Is it a bad moment to reach out? Quiet hours hold outbound contact
     * only — the inbox keeps filling, because the user asked to be able to
     * look at it.
     * @param {Object|null} policy
     * @param {Date} [now]
     * @returns {boolean}
     */
    inQuietHours(policy, now = new Date()) {
        const start = policy?.quietStartMinute;
        const end = policy?.quietEndMinute;
        if (start === null || start === undefined || end === null || end === undefined) return false;
        const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
        if (start === end) return false;
        // Half-open [start, end). Minutes only go to 1439, so a same-day
        // window that ends at 23:59 would otherwise never cover 23:59 itself
        // (and 00:00–23:59, the natural "all day" encoding, would have a
        // one-minute hole at UTC midnight). Treat end=1439 as exclusive-1440.
        const exclusiveEnd = start < end && end === 1439 ? 1440 : end;
        return start < exclusiveEnd
            ? minute >= start && minute < exclusiveEnd
            : minute >= start || minute < exclusiveEnd; // window wraps past midnight
    }

    /** Erase one person's policy (privacy / forget-me). */
    async forgetUser(userId, handle = db) {
        if (!userId) return 0;
        return (await handle.run(
            'DELETE FROM attention_policies WHERE userId = @userId',
            { userId }
        )).changes;
    }
}

module.exports = new AttentionPolicyService();
module.exports.AttentionPolicyService = AttentionPolicyService;
module.exports.AttentionPolicyError = AttentionPolicyError;
module.exports.ACTIONS = ACTIONS;
module.exports.ACTION_INITIATIVE = ACTION_INITIATIVE;
