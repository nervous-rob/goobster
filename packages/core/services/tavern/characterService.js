const db = require('../../db');
const { TavernError } = require('./tavernError');
const {
    CALLINGS, STAT_KEYS, STAT_POOL, STAT_MAX,
    DEFAULT_MAX_HEALTH, STARTING_SPARK, SPARK_CAP
} = require('./content');

const MAX_NAME_LENGTH = 40;
const MAX_ORIGIN_LENGTH = 100;
const MAX_COMPLICATION_LENGTH = 120;
const MAX_PRONOUNS_LENGTH = 30;
const MAX_INVENTORY_ITEMS = 30;

/**
 * Tavern character sheets: one lightweight character per user per guild.
 * Four stats (+0..+3, distribute STAT_POOL points), a Calling, one
 * complication, health, Spark, inventory, and milestone advancement.
 * All structured state - prose lives in the adventure log, never here.
 */
class CharacterService {
    /**
     * Parse a raw row (JSON inventory) into a character object.
     * @param {Object|undefined} row
     * @returns {Object|null}
     */
    _parse(row) {
        if (!row) return null;
        let inventory;
        try {
            inventory = JSON.parse(row.inventory);
        } catch {
            inventory = [];
        }
        return { ...row, inventory: Array.isArray(inventory) ? inventory : [] };
    }

    /**
     * The user's character in a guild, or null.
     * @param {string} guildId
     * @param {string} userId
     * @returns {Object|null}
     */
    async getCharacter(guildId, userId) {
        return this._parse(await db.get(
            'SELECT * FROM tavern_characters WHERE guildId = @guildId AND userId = @userId',
            { guildId, userId }
        ));
    }

    /**
     * A character by primary key, or null.
     * @param {number} id
     * @returns {Object|null}
     */
    async getById(id) {
        return this._parse(await db.get('SELECT * FROM tavern_characters WHERE id = @id', { id }));
    }

    /**
     * Number of characters in a guild.
     * @param {string} guildId
     * @returns {number}
     */
    async countByGuild(guildId) {
        return (await db.get('SELECT COUNT(*) AS c FROM tavern_characters WHERE guildId = @guildId', { guildId })).c;
    }

    /**
     * Create a character. Stats must each be 0..STAT_MAX and sum to STAT_POOL.
     * @param {Object} params - { guildId, userId, name, pronouns?, origin, calling, stats: {might, finesse, wits, heart}, complication }
     * @returns {Object} the created character
     */
    async createCharacter({ guildId, userId, name, pronouns = null, origin, calling, stats, complication }) {
        const cleanName = String(name || '').trim();
        const cleanOrigin = String(origin || '').trim();
        const cleanComplication = String(complication || '').trim();
        const cleanPronouns = pronouns ? String(pronouns).trim() : null;

        if (!cleanName || cleanName.length > MAX_NAME_LENGTH) {
            throw new TavernError('BAD_NAME', `Character name must be 1-${MAX_NAME_LENGTH} characters.`);
        }
        if (!cleanOrigin || cleanOrigin.length > MAX_ORIGIN_LENGTH) {
            throw new TavernError('BAD_ORIGIN', `Origin must be 1-${MAX_ORIGIN_LENGTH} characters (one flavorful phrase).`);
        }
        if (!cleanComplication || cleanComplication.length > MAX_COMPLICATION_LENGTH) {
            throw new TavernError('BAD_COMPLICATION', `Complication must be 1-${MAX_COMPLICATION_LENGTH} characters.`);
        }
        if (cleanPronouns && cleanPronouns.length > MAX_PRONOUNS_LENGTH) {
            throw new TavernError('BAD_PRONOUNS', `Pronouns must be at most ${MAX_PRONOUNS_LENGTH} characters.`);
        }
        if (!CALLINGS[calling]) {
            throw new TavernError('BAD_CALLING', `Calling must be one of: ${Object.keys(CALLINGS).join(', ')}.`);
        }
        this._validateStats(stats);
        if (await this.getCharacter(guildId, userId)) {
            throw new TavernError('ALREADY_EXISTS', 'You already have a character in this server. Use `/character sheet` to see them, or `/character retire` first.');
        }

        const result = await db.insert(
            `INSERT INTO tavern_characters
                 (guildId, userId, name, pronouns, origin, calling, might, finesse, wits, heart,
                  complication, health, maxHealth, spark, inventory)
             VALUES (@guildId, @userId, @name, @pronouns, @origin, @calling, @might, @finesse, @wits, @heart,
                     @complication, @health, @maxHealth, @spark, '[]')`,
            {
                guildId, userId,
                name: cleanName, pronouns: cleanPronouns, origin: cleanOrigin, calling,
                might: stats.might, finesse: stats.finesse, wits: stats.wits, heart: stats.heart,
                complication: cleanComplication,
                health: DEFAULT_MAX_HEALTH, maxHealth: DEFAULT_MAX_HEALTH, spark: STARTING_SPARK
            }
        );
        return await this.getById(Number(result));
    }

    /**
     * Validate a stat spread.
     * @param {{might: number, finesse: number, wits: number, heart: number}} stats
     */
    _validateStats(stats) {
        if (!stats || typeof stats !== 'object') {
            throw new TavernError('BAD_STATS', 'Stats are required.');
        }
        let total = 0;
        for (const key of STAT_KEYS) {
            const value = stats[key];
            if (!Number.isInteger(value) || value < 0 || value > STAT_MAX) {
                throw new TavernError('BAD_STATS', `Each stat must be a whole number from 0 to +${STAT_MAX}.`);
            }
            total += value;
        }
        if (total !== STAT_POOL) {
            throw new TavernError(
                'BAD_STATS',
                `Distribute exactly ${STAT_POOL} points across Might/Finesse/Wits/Heart (you used ${total}). ` +
                'Classic spreads: 3/2/1/0 or 2/2/1/1.'
            );
        }
    }

    /**
     * Edit descriptive fields (never stats or calling - those advance via play).
     * @param {Object} params - { guildId, userId, name?, pronouns?, origin?, complication? }
     * @returns {Object} the updated character
     */
    async editCharacter({ guildId, userId, name = null, pronouns = null, origin = null, complication = null }) {
        const character = await this.getCharacter(guildId, userId);
        if (!character) throw new TavernError('NO_CHARACTER', 'You have no character here yet. Use `/character create`.');

        const updates = {
            name: name !== null ? String(name).trim() : character.name,
            pronouns: pronouns !== null ? (String(pronouns).trim() || null) : character.pronouns,
            origin: origin !== null ? String(origin).trim() : character.origin,
            complication: complication !== null ? String(complication).trim() : character.complication
        };
        if (!updates.name || updates.name.length > MAX_NAME_LENGTH) {
            throw new TavernError('BAD_NAME', `Character name must be 1-${MAX_NAME_LENGTH} characters.`);
        }
        if (!updates.origin || updates.origin.length > MAX_ORIGIN_LENGTH) {
            throw new TavernError('BAD_ORIGIN', `Origin must be 1-${MAX_ORIGIN_LENGTH} characters.`);
        }
        if (!updates.complication || updates.complication.length > MAX_COMPLICATION_LENGTH) {
            throw new TavernError('BAD_COMPLICATION', `Complication must be 1-${MAX_COMPLICATION_LENGTH} characters.`);
        }
        if (updates.pronouns && updates.pronouns.length > MAX_PRONOUNS_LENGTH) {
            throw new TavernError('BAD_PRONOUNS', `Pronouns must be at most ${MAX_PRONOUNS_LENGTH} characters.`);
        }

        await db.run(
            `UPDATE tavern_characters
             SET name = @name, pronouns = @pronouns, origin = @origin, complication = @complication,
                 updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: character.id, ...updates }
        );
        return await this.getById(character.id);
    }

    /**
     * Retire (delete) a character. Refused while they are in an open party -
     * leave the adventure first.
     * @param {string} guildId
     * @param {string} userId
     * @returns {Object} the retired character (for the farewell message)
     */
    async retireCharacter(guildId, userId) {
        const character = await this.getCharacter(guildId, userId);
        if (!character) throw new TavernError('NO_CHARACTER', 'You have no character here to retire.');

        const openParty = await db.get(
            `SELECT a.id FROM tavern_party_members pm
             JOIN tavern_adventures a ON a.id = pm.adventureId
             WHERE pm.characterId = @characterId AND a.status IN ('RECRUITING', 'ACTIVE')`,
            { characterId: character.id }
        );
        if (openParty) {
            throw new TavernError('IN_PARTY', 'That character is in an open adventure. `/adventure leave` first.');
        }

        await db.run('DELETE FROM tavern_characters WHERE id = @id', { id: character.id });
        return character;
    }

    /**
     * Spend a milestone to raise a stat by one (max +3).
     * @param {string} guildId
     * @param {string} userId
     * @param {string} stat - might|finesse|wits|heart
     * @returns {Object} the updated character
     */
    async advance(guildId, userId, stat) {
        if (!STAT_KEYS.includes(stat)) {
            throw new TavernError('BAD_STATS', `Stat must be one of: ${STAT_KEYS.join(', ')}.`);
        }
        return await db.transaction(async () => {
            const character = await this.getCharacter(guildId, userId);
            if (!character) throw new TavernError('NO_CHARACTER', 'You have no character here yet. Use `/character create`.');
            if (character.milestones <= character.advancesSpent) {
                throw new TavernError('NO_MILESTONE', 'No unspent milestones - finish an adventure to earn one.');
            }
            if (character[stat] >= STAT_MAX) {
                throw new TavernError('STAT_MAXED', `${stat[0].toUpperCase()}${stat.slice(1)} is already at +${STAT_MAX}.`);
            }
            await db.run(
                `UPDATE tavern_characters
                 SET ${stat} = ${stat} + 1, advancesSpent = advancesSpent + 1, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: character.id }
            );
            return await this.getById(character.id);
        });
    }

    /**
     * Apply a signed health change, clamped to 1..maxHealth during play (the
     * Tavern does not do permadeath in the alpha; hitting the floor "staggers"
     * the character instead - the engine turns that into a danger tick).
     * @param {number} characterId
     * @param {number} delta
     * @returns {{health: number, staggered: boolean}}
     */
    async adjustHealth(characterId, delta) {
        return await db.transaction(async () => {
            const character = await this.getById(characterId);
            if (!character) throw new TavernError('NO_CHARACTER', 'Character not found.');
            let health = character.health + delta;
            let staggered = false;
            if (health < 1) {
                health = 1;
                staggered = true;
            }
            if (health > character.maxHealth) health = character.maxHealth;
            await db.run(
                'UPDATE tavern_characters SET health = @health, updatedAt = CURRENT_TIMESTAMP WHERE id = @id',
                { id: characterId, health }
            );
            return { health, staggered };
        });
    }

    /**
     * Restore a character to full health (hearth rest after an adventure).
     * @param {number} characterId
     */
    async restoreHealth(characterId) {
        await db.run(
            'UPDATE tavern_characters SET health = maxHealth, updatedAt = CURRENT_TIMESTAMP WHERE id = @id',
            { id: characterId }
        );
    }

    /**
     * Apply a signed Spark change, clamped to 0..SPARK_CAP.
     * @param {number} characterId
     * @param {number} delta
     * @returns {number} new spark
     */
    async adjustSpark(characterId, delta) {
        return await db.transaction(async () => {
            const character = await this.getById(characterId);
            if (!character) throw new TavernError('NO_CHARACTER', 'Character not found.');
            const spark = Math.max(0, Math.min(SPARK_CAP, character.spark + delta));
            await db.run(
                'UPDATE tavern_characters SET spark = @spark, updatedAt = CURRENT_TIMESTAMP WHERE id = @id',
                { id: characterId, spark }
            );
            return spark;
        });
    }

    /**
     * Add an item to the character's inventory (capped; duplicates allowed -
     * two mysterious bells are twice the mystery).
     * @param {number} characterId
     * @param {string} item
     * @returns {string[]} the new inventory
     */
    async addItem(characterId, item) {
        return await db.transaction(async () => {
            const character = await this.getById(characterId);
            if (!character) throw new TavernError('NO_CHARACTER', 'Character not found.');
            const inventory = [...character.inventory];
            if (inventory.length >= MAX_INVENTORY_ITEMS) {
                // Oldest non-trophy junk falls out of the pack first
                inventory.shift();
            }
            inventory.push(String(item).trim());
            await db.run(
                'UPDATE tavern_characters SET inventory = @inventory, updatedAt = CURRENT_TIMESTAMP WHERE id = @id',
                { id: characterId, inventory }
            );
            return inventory;
        });
    }

    /**
     * Whether the character carries an item by (case-insensitive) name.
     * @param {Object} character
     * @param {string} item
     * @returns {boolean}
     */
    hasItem(character, item) {
        const wanted = String(item).trim().toLowerCase();
        return character.inventory.some(entry => entry.toLowerCase() === wanted);
    }

    /**
     * Remove one copy of an item (case-insensitive, first match).
     * @param {number} characterId
     * @param {string} item
     * @returns {string|null} the removed item's exact name, or null
     */
    async removeItem(characterId, item) {
        return await db.transaction(async () => {
            const character = await this.getById(characterId);
            if (!character) throw new TavernError('NO_CHARACTER', 'Character not found.');
            const wanted = String(item).trim().toLowerCase();
            const index = character.inventory.findIndex(entry => entry.toLowerCase() === wanted);
            if (index === -1) return null;
            const [removed] = character.inventory.splice(index, 1);
            await db.run(
                'UPDATE tavern_characters SET inventory = @inventory, updatedAt = CURRENT_TIMESTAMP WHERE id = @id',
                { id: characterId, inventory: character.inventory }
            );
            return removed;
        });
    }

    /**
     * Hand an item to another character in the same guild (atomic).
     * @param {Object} params - { guildId, fromUserId, toUserId, item }
     * @returns {{item: string, from: Object, to: Object}}
     */
    async transferItem({ guildId, fromUserId, toUserId, item }) {
        if (fromUserId === toUserId) throw new TavernError('SELF_TRANSFER', 'You already have that item. That is where it lives.');
        return await db.transaction(async () => {
            const from = await this.getCharacter(guildId, fromUserId);
            if (!from) throw new TavernError('NO_CHARACTER', 'You have no character here yet.');
            const to = await this.getCharacter(guildId, toUserId);
            if (!to) throw new TavernError('NO_CHARACTER', 'They have no character here to receive it.');
            const removed = await this.removeItem(from.id, item);
            if (!removed) throw new TavernError('NO_ITEM', `You are not carrying "${item}".`);
            await this.addItem(to.id, removed);
            return { item: removed, from: await this.getById(from.id), to: await this.getById(to.id) };
        });
    }

    /**
     * Record an adventure completion: +1 milestone, +1 spark (capped), full
     * health, and the completion counter.
     * @param {number} characterId
     */
    async recordCompletion(characterId) {
        await db.transaction(async () => {
            await db.run(
                `UPDATE tavern_characters
                 SET milestones = milestones + 1,
                     adventuresCompleted = adventuresCompleted + 1,
                     health = maxHealth,
                     spark = MIN(spark + 1, @sparkCap),
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: characterId, sparkCap: SPARK_CAP }
            );
        });
    }
}

module.exports = new CharacterService();
module.exports.CharacterService = CharacterService;
