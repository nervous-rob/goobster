const db = require('../../db');
const { TavernError } = require('./tavernError');
const { NPCS } = require('./content');

const SCORE_MIN = -5;
const SCORE_MAX = 5;
const MAX_ROOM_DESCRIPTION = 500;
const MAX_LORE_PER_GUILD = 200;

/** Human labels for relationship scores (evolves through adventures). */
const STANDING_LABELS = [
    { min: 4, label: 'Sworn friend' },
    { min: 2, label: 'Trusted regular' },
    { min: 1, label: 'Friendly face' },
    { min: 0, label: 'Just another guest' },
    { min: -1, label: 'On thin ice' },
    { min: -3, label: 'Politely unwelcome' },
    { min: -SCORE_MAX, label: 'Banned from the good chairs' }
];

/**
 * Phase 2 - the world remembers: per-member NPC relationships, Guest Rooms,
 * and the guild's shared lore record (locations, factions, events, artifacts,
 * characters) written by adventure endings.
 */
class WorldService {
    // ------------------------------------------------------------------
    // NPC relationships
    // ------------------------------------------------------------------

    /**
     * A member's standing with one NPC.
     * @returns {{score: number, label: string}}
     */
    getRelationship(guildId, npcKey, userId) {
        const row = db.get(
            `SELECT score FROM tavern_npc_relationships
             WHERE guildId = @guildId AND npcKey = @npcKey AND userId = @userId`,
            { guildId, npcKey, userId }
        );
        const score = row?.score || 0;
        return { score, label: this.standingLabel(score) };
    }

    /**
     * All of a member's NPC relationships (only ones that moved off zero).
     * @returns {Array<{npcKey: string, score: number, label: string}>}
     */
    listRelationships(guildId, userId) {
        return db.all(
            `SELECT npcKey, score FROM tavern_npc_relationships
             WHERE guildId = @guildId AND userId = @userId AND score != 0
             ORDER BY score DESC, npcKey`,
            { guildId, userId }
        ).map(row => ({ ...row, label: this.standingLabel(row.score) }));
    }

    /**
     * Apply a signed relationship change (clamped -5..+5).
     * @returns {{score: number, label: string}}
     */
    adjustRelationship(guildId, npcKey, userId, delta) {
        if (!NPCS[npcKey]) throw new TavernError('NO_NPC', `No NPC named '${npcKey}' lives here.`);
        return db.transaction(() => {
            const current = db.get(
                `SELECT score FROM tavern_npc_relationships
                 WHERE guildId = @guildId AND npcKey = @npcKey AND userId = @userId`,
                { guildId, npcKey, userId }
            )?.score || 0;
            const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, current + delta));
            db.run(
                `INSERT INTO tavern_npc_relationships (guildId, npcKey, userId, score)
                 VALUES (@guildId, @npcKey, @userId, @score)
                 ON CONFLICT(guildId, npcKey, userId) DO UPDATE SET score = @score, updatedAt = CURRENT_TIMESTAMP`,
                { guildId, npcKey, userId, score }
            );
            return { score, label: this.standingLabel(score) };
        });
    }

    /**
     * @param {number} score
     * @returns {string}
     */
    standingLabel(score) {
        return STANDING_LABELS.find(band => score >= band.min)?.label || STANDING_LABELS.at(-1).label;
    }

    // ------------------------------------------------------------------
    // Guest Rooms
    // ------------------------------------------------------------------

    /**
     * A member's room description, or null when they haven't moved in.
     * @returns {string|null}
     */
    getRoom(guildId, userId) {
        const row = db.get(
            'SELECT description FROM tavern_rooms WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        );
        return row?.description || null;
    }

    /**
     * Set (or clear with empty text) a member's room description.
     * @returns {string|null} the stored description
     */
    setRoom(guildId, userId, description) {
        const clean = String(description || '').trim();
        if (!clean) {
            db.run('DELETE FROM tavern_rooms WHERE guildId = @guildId AND userId = @userId', { guildId, userId });
            return null;
        }
        if (clean.length > MAX_ROOM_DESCRIPTION) {
            throw new TavernError('BAD_ROOM', `Keep the room description under ${MAX_ROOM_DESCRIPTION} characters - it's a room, not a wing.`);
        }
        db.run(
            `INSERT INTO tavern_rooms (guildId, userId, description) VALUES (@guildId, @userId, @description)
             ON CONFLICT(guildId, userId) DO UPDATE SET description = @description, updatedAt = CURRENT_TIMESTAMP`,
            { guildId, userId, description: clean }
        );
        return clean;
    }

    // ------------------------------------------------------------------
    // Shared world lore
    // ------------------------------------------------------------------

    /**
     * Record (or refresh) a lore entry. Retellings update the content and
     * source; the discovery date stays.
     * @param {Object} params - { guildId, kind, name, content, sourceQuestId?, sourceAdventureId? }
     */
    recordLore({ guildId, kind, name, content, sourceQuestId = null, sourceAdventureId = null }) {
        db.transaction(() => {
            db.run(
                `INSERT INTO tavern_lore (guildId, kind, name, content, sourceQuestId, sourceAdventureId)
                 VALUES (@guildId, @kind, @name, @content, @sourceQuestId, @sourceAdventureId)
                 ON CONFLICT(guildId, kind, name) DO UPDATE SET
                     content = @content, sourceQuestId = @sourceQuestId,
                     sourceAdventureId = @sourceAdventureId, updatedAt = CURRENT_TIMESTAMP`,
                { guildId, kind, name: String(name).trim(), content: String(content).trim(), sourceQuestId, sourceAdventureId }
            );
            // Bound the shared record; the oldest, least-recently-retold falls off
            db.run(
                `DELETE FROM tavern_lore WHERE guildId = @guildId AND id NOT IN (
                     SELECT id FROM tavern_lore WHERE guildId = @guildId
                     ORDER BY updatedAt DESC, id DESC LIMIT @cap)`,
                { guildId, cap: MAX_LORE_PER_GUILD }
            );
        });
    }

    /**
     * The guild's discovered world, grouped by kind.
     * @returns {Object<string, Array<{name: string, content: string, sourceQuestId: string|null}>>}
     */
    getWorld(guildId) {
        const rows = db.all(
            `SELECT kind, name, content, sourceQuestId FROM tavern_lore
             WHERE guildId = @guildId ORDER BY kind, name`,
            { guildId }
        );
        const world = {};
        for (const row of rows) {
            (world[row.kind] = world[row.kind] || []).push(row);
        }
        return world;
    }

    /**
     * One lore entry by (case-insensitive) name, or null.
     */
    getLore(guildId, name) {
        return db.get(
            `SELECT kind, name, content, sourceQuestId, createdAt FROM tavern_lore
             WHERE guildId = @guildId AND name = @name COLLATE NOCASE
             ORDER BY updatedAt DESC LIMIT 1`,
            { guildId, name: String(name).trim() }
        ) || null;
    }

    /**
     * Lore names for autocomplete.
     * @returns {string[]}
     */
    listLoreNames(guildId, prefix = '') {
        return db.all(
            `SELECT name FROM tavern_lore
             WHERE guildId = @guildId AND name LIKE @pattern COLLATE NOCASE
             ORDER BY updatedAt DESC LIMIT 25`,
            { guildId, pattern: `%${String(prefix).trim()}%` }
        ).map(row => row.name);
    }
}

module.exports = new WorldService();
module.exports.WorldService = WorldService;
module.exports.SCORE_MIN = SCORE_MIN;
module.exports.SCORE_MAX = SCORE_MAX;
