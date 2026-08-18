const db = require('../../db');
const { TavernError } = require('./tavernError');
const characterService = require('./characterService');
const questLoader = require('./questLoader');
const worldService = require('./worldService');
const { DIFFICULTY, STAT_KEYS, NPCS, BOT_CHARACTER } = require('./content');

const DEFAULT_FREEFORM_DC = DIFFICULTY.challenging;
const MAX_EFFECT_DEPTH = 3;
const RECAP_MAX_BEATS = 20;
const ATTACK_DAMAGE = 2;
const CRIT_BONUS_DAMAGE = 1;

/**
 * Keyword fallback for freeform actions when no AI provider is available (or
 * the model answer is unusable). Deterministic and cheap.
 */
const STAT_KEYWORDS = Object.freeze({
    might: ['smash', 'ram', 'break', 'fight', 'attack', 'punch', 'kick', 'lift', 'shove', 'wrestle', 'force', 'charge', 'intimidate', 'hold', 'carry', 'swing', 'bash', 'tackle', 'push', 'pull', 'drag'],
    finesse: ['sneak', 'steal', 'pick', 'dodge', 'climb', 'swim', 'dive', 'throw', 'shoot', 'aim', 'slip', 'hide', 'tumble', 'balance', 'swipe', 'snatch', 'juggle', 'tiptoe', 'catch'],
    wits: ['examine', 'study', 'read', 'decipher', 'investigate', 'search', 'plan', 'calculate', 'recall', 'identify', 'analyze', 'inspect', 'solve', 'cast', 'rig', 'build', 'repair', 'tinker', 'invent', 'remember'],
    heart: ['persuade', 'convince', 'charm', 'comfort', 'inspire', 'plead', 'befriend', 'sing', 'perform', 'negotiate', 'apologize', 'rally', 'soothe', 'encourage', 'pray', 'promise', 'reassure', 'talk']
});

/**
 * The adventure engine: party lifecycle, the scene state machine, d20 checks,
 * clocks, Spark rerolls, Calling big moves, and automatic recaps.
 *
 * Structured state is deterministic JSON in tavern_adventures.state; prose
 * goes to tavern_adventure_log. The RNG is constructor-injectable so game
 * logic is fully deterministic under test.
 */
class AdventureService {
    /**
     * @param {Function} [rng] - returns [0,1); injectable for tests
     */
    constructor(rng = Math.random) {
        this.rng = rng;
    }

    _d20() {
        return 1 + Math.floor(this.rng() * 20);
    }

    // ------------------------------------------------------------------
    // Lookups
    // ------------------------------------------------------------------

    /**
     * An adventure row with parsed state, or null.
     * @param {number} adventureId
     * @returns {Object|null}
     */
    async getAdventure(adventureId) {
        const row = await db.get('SELECT * FROM tavern_adventures WHERE id = @adventureId', { adventureId });
        if (!row) return null;
        let state;
        try {
            state = JSON.parse(row.state);
        } catch {
            state = {};
        }
        return { ...row, state };
    }

    /**
     * The open (recruiting or active) adventure in a channel, or null.
     * One adventure per channel at a time.
     * @param {string} channelId
     * @returns {Object|null}
     */
    async getOpenAdventureInChannel(channelId) {
        const row = await db.get(
            `SELECT id FROM tavern_adventures
             WHERE channelId = @channelId AND status IN ('RECRUITING', 'ACTIVE')
             ORDER BY id DESC LIMIT 1`,
            { channelId }
        );
        return row ? await this.getAdventure(row.id) : null;
    }

    /**
     * The open adventure a user is partied into within a guild, or null.
     * @param {string} guildId
     * @param {string} userId
     * @returns {Object|null}
     */
    async getOpenAdventureForUser(guildId, userId) {
        const row = await db.get(
            `SELECT a.id FROM tavern_adventures a
             JOIN tavern_party_members pm ON pm.adventureId = a.id
             WHERE a.guildId = @guildId AND pm.userId = @userId AND a.status IN ('RECRUITING', 'ACTIVE')
             ORDER BY a.id DESC LIMIT 1`,
            { guildId, userId }
        );
        return row ? await this.getAdventure(row.id) : null;
    }

    /**
     * Party members with their character sheets (join order).
     * @param {number} adventureId
     * @returns {Array<Object>} [{userId, character}]
     */
    async getMembers(adventureId) {
        const rows = await db.all(
            `SELECT pm.userId, pm.characterId FROM tavern_party_members pm
             WHERE pm.adventureId = @adventureId ORDER BY pm.joinedAt, pm.userId`,
            { adventureId }
        );
        return Promise.all(rows.map(async row => ({ userId: row.userId, character: await characterService.getById(row.characterId) })));
    }

    /**
     * Open adventures in a guild (for the tavern status board).
     * @param {string} guildId
     * @returns {Array<Object>}
     */
    async listOpenAdventures(guildId) {
        return await db.all(
            `SELECT a.id, a.questId, a.status, a.channelId,
                    (SELECT COUNT(*) FROM tavern_party_members pm WHERE pm.adventureId = a.id) AS partySize
             FROM tavern_adventures a
             WHERE a.guildId = @guildId AND a.status IN ('RECRUITING', 'ACTIVE')
             ORDER BY a.id DESC`,
            { guildId }
        );
    }

    /**
     * Everything a view needs to render an adventure.
     * @param {number} adventureId
     * @returns {{adventure: Object, quest: Object, scene: Object|null, members: Array}}
     */
    async describe(adventureId) {
        const adventure = await this.getAdventure(adventureId);
        if (!adventure) throw new TavernError('NO_ADVENTURE', 'That adventure no longer exists.');
        const quest = questLoader.getQuest(adventure.questId);
        if (!quest) throw new TavernError('NO_QUEST', `The campaign '${adventure.questId}' is no longer installed.`);
        const scene = adventure.sceneId ? quest.scenes[adventure.sceneId] : null;
        return { adventure, quest, scene, members: await this.getMembers(adventureId) };
    }

    // ------------------------------------------------------------------
    // Party lifecycle
    // ------------------------------------------------------------------

    /**
     * Post a party for a quest in a channel and join it as the first member.
     * @param {Object} params - { guildId, channelId, questId, userId }
     * @returns {{adventure: Object, quest: Object, character: Object}}
     */
    async createParty({ guildId, channelId, questId, userId }) {
        const quest = questLoader.getQuest(questId);
        if (!quest || quest.hidden) throw new TavernError('NO_QUEST', 'No such quest on the board. `/adventure browse` lists them.');
        if (!await this.isQuestUnlocked(guildId, quest)) {
            const required = questLoader.getQuest(quest.requires);
            throw new TavernError(
                'QUEST_LOCKED',
                `That chapter isn't on the board yet - the server must first complete **${required?.title || quest.requires}**.`
            );
        }

        const busy = await this.getOpenAdventureInChannel(channelId);
        if (busy) {
            throw new TavernError('CHANNEL_BUSY', `There is already an open adventure in this channel (**${questLoader.getQuest(busy.questId)?.title || busy.questId}**). One story per table.`);
        }
        const elsewhere = await this.getOpenAdventureForUser(guildId, userId);
        if (elsewhere) {
            throw new TavernError('ALREADY_IN_PARTY', 'You are already in an open adventure in this server. `/adventure leave` first.');
        }
        const character = await characterService.getCharacter(guildId, userId);
        if (!character) {
            throw new TavernError('NO_CHARACTER', 'You need a character first - `/character create` takes about a minute.');
        }

        const adventureId = await db.transaction(async () => {
            const result = await db.run(
                `INSERT INTO tavern_adventures (guildId, channelId, questId, status, createdBy)
                 VALUES (@guildId, @channelId, @questId, 'RECRUITING', @userId)`,
                { guildId, channelId, questId, userId }
            );
            const id = Number(result.lastInsertRowid);
            await db.run(
                `INSERT INTO tavern_party_members (adventureId, userId, characterId)
                 VALUES (@adventureId, @userId, @characterId)`,
                { adventureId: id, userId, characterId: character.id }
            );
            return id;
        });

        return { adventure: await this.getAdventure(adventureId), quest, character };
    }

    /**
     * Whether a quest's chapter requirement is satisfied in this guild
     * (a completed adventure of the required quest exists).
     * @param {string} guildId
     * @param {Object} quest
     * @returns {boolean}
     */
    async isQuestUnlocked(guildId, quest) {
        if (!quest.requires) return true;
        // A story-twist fork of the required quest counts: it descends from
        // the same canonical campaign (fork ids are '<canonical>--twist-<n>')
        const done = await db.get(
            `SELECT 1 AS ok FROM tavern_adventures
             WHERE guildId = @guildId AND status = 'COMPLETED'
               AND (questId = @questId OR questId LIKE @questId || '--twist-%') LIMIT 1`,
            { guildId, questId: quest.requires }
        );
        return Boolean(done);
    }

    /**
     * Invite Goobster himself to a recruiting party. His character is created
     * lazily per guild (keyed on his real bot account id) and he skips the
     * one-party-per-user rule - the Tavern's spirit can be in several places.
     * @param {number} adventureId
     * @param {string} inviterUserId - must be a party member
     * @param {string} botUserId - the bot's real Discord account id
     * @returns {{adventure: Object, quest: Object, members: Array, character: Object}}
     */
    async inviteBot(adventureId, inviterUserId, botUserId) {
        const adventure = await this.getAdventure(adventureId);
        if (!adventure || adventure.status !== 'RECRUITING') {
            throw new TavernError('NOT_RECRUITING', 'Goobster can only be invited while the party is forming.');
        }
        const quest = questLoader.getQuest(adventure.questId);
        if (!quest) throw new TavernError('NO_QUEST', `The campaign '${adventure.questId}' is no longer installed.`);

        const members = await this.getMembers(adventureId);
        if (!members.some(m => m.userId === inviterUserId)) {
            throw new TavernError('NOT_MEMBER', 'Only party members can invite Goobster to the table.');
        }
        if (members.some(m => m.userId === botUserId)) {
            throw new TavernError('ALREADY_MEMBER', 'Goobster is already at this table, polishing a tankard expectantly.');
        }
        if (members.length >= quest.players.max) {
            throw new TavernError('PARTY_FULL', `This party is full (${quest.players.max} adventurers) - Goobster will cheer from the bar.`);
        }

        let character = await characterService.getCharacter(adventure.guildId, botUserId);
        if (!character) {
            character = await characterService.createCharacter({
                guildId: adventure.guildId, userId: botUserId, ...BOT_CHARACTER
            });
        }
        await db.run(
            `INSERT INTO tavern_party_members (adventureId, userId, characterId)
             VALUES (@adventureId, @userId, @characterId)`,
            { adventureId, userId: botUserId, characterId: character.id }
        );
        return { adventure: await this.getAdventure(adventureId), quest, members: await this.getMembers(adventureId), character };
    }

    /**
     * Join a recruiting party.
     * @param {number} adventureId
     * @param {string} userId
     * @returns {{adventure: Object, quest: Object, character: Object, members: Array}}
     */
    async join(adventureId, userId) {
        const adventure = await this.getAdventure(adventureId);
        if (!adventure || adventure.status !== 'RECRUITING') {
            throw new TavernError('NOT_RECRUITING', 'That party is no longer recruiting.');
        }
        const quest = questLoader.getQuest(adventure.questId);
        if (!quest) throw new TavernError('NO_QUEST', `The campaign '${adventure.questId}' is no longer installed.`);

        const members = await this.getMembers(adventureId);
        if (members.some(m => m.userId === userId)) {
            throw new TavernError('ALREADY_MEMBER', 'You are already in this party.');
        }
        if (members.length >= quest.players.max) {
            throw new TavernError('PARTY_FULL', `This party is full (${quest.players.max} adventurers).`);
        }
        const elsewhere = await this.getOpenAdventureForUser(adventure.guildId, userId);
        if (elsewhere) {
            throw new TavernError('ALREADY_IN_PARTY', 'You are already in an open adventure in this server. `/adventure leave` first.');
        }
        const character = await characterService.getCharacter(adventure.guildId, userId);
        if (!character) {
            throw new TavernError('NO_CHARACTER', 'You need a character first - `/character create` takes about a minute.');
        }

        await db.run(
            `INSERT INTO tavern_party_members (adventureId, userId, characterId)
             VALUES (@adventureId, @userId, @characterId)`,
            { adventureId, userId, characterId: character.id }
        );
        return { adventure: await this.getAdventure(adventureId), quest, character, members: await this.getMembers(adventureId) };
    }

    /**
     * Leave a party. Leaving mid-adventure is always allowed (safety tool) and
     * never punishes the character. An emptied party is abandoned.
     * @param {number} adventureId
     * @param {string} userId
     * @returns {{remaining: number, abandoned: boolean}}
     */
    async leave(adventureId, userId) {
        const adventure = await this.getAdventure(adventureId);
        if (!adventure || !['RECRUITING', 'ACTIVE'].includes(adventure.status)) {
            throw new TavernError('NO_ADVENTURE', 'That adventure is not open.');
        }
        const removed = (await db.run(
            'DELETE FROM tavern_party_members WHERE adventureId = @adventureId AND userId = @userId',
            { adventureId, userId }
        )).changes;
        if (!removed) throw new TavernError('NOT_MEMBER', 'You are not in that party.');

        // Keep the spotlight order in sync
        const state = adventure.state;
        if (Array.isArray(state.spotlight) && state.spotlight.includes(userId)) {
            state.spotlight = state.spotlight.filter(id => id !== userId);
            if (state.spotlightIndex >= Math.max(state.spotlight.length, 1)) state.spotlightIndex = 0;
            await this._saveState(adventureId, adventure);
        }

        const remaining = (await this.getMembers(adventureId)).length;
        if (remaining === 0) {
            await db.run(
                `UPDATE tavern_adventures SET status = 'ABANDONED', updatedAt = CURRENT_TIMESTAMP WHERE id = @adventureId`,
                { adventureId }
            );
            await this._log(adventureId, 'EVENT', null, 'The party dispersed; the tale waits for braver (or at least more available) souls.');
        }
        return { remaining, abandoned: remaining === 0 };
    }

    /**
     * Begin the adventure: initialize clocks/spotlight and enter the first scene.
     * @param {number} adventureId
     * @param {string} userId - must be a party member
     * @returns {{adventure: Object, quest: Object, scene: Object, members: Array}}
     */
    async begin(adventureId, userId) {
        const adventure = await this.getAdventure(adventureId);
        if (!adventure) throw new TavernError('NO_ADVENTURE', 'That adventure no longer exists.');
        if (adventure.status !== 'RECRUITING') throw new TavernError('NOT_RECRUITING', 'That adventure has already begun (or ended).');
        const quest = questLoader.getQuest(adventure.questId);
        if (!quest) throw new TavernError('NO_QUEST', `The campaign '${adventure.questId}' is no longer installed.`);

        const members = await this.getMembers(adventureId);
        if (!members.some(m => m.userId === userId)) {
            throw new TavernError('NOT_MEMBER', 'Only party members can begin the adventure.');
        }
        if (members.length < quest.players.min) {
            throw new TavernError('PARTY_TOO_SMALL', `This quest needs at least ${quest.players.min} adventurer(s); the party has ${members.length}.`);
        }

        const state = {
            clocks: Object.fromEntries((quest.clocks || []).map(clock => [clock.id, 0])),
            flags: {},
            usedOptions: {},
            spotlight: members.map(m => m.userId),
            spotlightIndex: 0,
            bigMovesUsed: {},
            autoSuccess: {},
            lastCheck: null,
            combat: this._freshCombat(quest.scenes[quest.start])
        };

        await db.run(
            `UPDATE tavern_adventures
             SET status = 'ACTIVE', sceneId = @sceneId, state = @state, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @adventureId`,
            { adventureId, sceneId: quest.start, state }
        );
        const scene = quest.scenes[quest.start];
        await this._log(adventureId, 'SCENE', null, `${scene.title}: the party set out. (${members.map(m => m.character?.name || m.userId).join(', ')})`);

        return await this.describe(adventureId);
    }

    /**
     * Abandon an adventure (creator or an admin override).
     * @param {number} adventureId
     * @param {string} userId
     * @param {{force?: boolean}} [opts] - force = Manage Server override
     */
    async abandon(adventureId, userId, { force = false } = {}) {
        const adventure = await this.getAdventure(adventureId);
        if (!adventure || !['RECRUITING', 'ACTIVE'].includes(adventure.status)) {
            throw new TavernError('NO_ADVENTURE', 'That adventure is not open.');
        }
        if (!force && adventure.createdBy !== userId) {
            throw new TavernError('NOT_CREATOR', 'Only the party founder (or a server admin) can abandon the adventure - anyone can `/adventure leave`.');
        }
        await db.run(
            `UPDATE tavern_adventures SET status = 'ABANDONED', updatedAt = CURRENT_TIMESTAMP WHERE id = @adventureId`,
            { adventureId }
        );
        await this._log(adventureId, 'EVENT', userId, 'The adventure was set aside. The Tavern keeps the tab open.');
    }

    // ------------------------------------------------------------------
    // Playing scenes
    // ------------------------------------------------------------------

    /**
     * Scene options still available (once-options disappear after use).
     * @param {Object} adventure - parsed adventure
     * @param {Object} quest
     * @returns {Array<Object>}
     */
    availableOptions(adventure, quest) {
        const scene = quest.scenes[adventure.sceneId];
        if (!scene) return [];
        const used = adventure.state.usedOptions?.[adventure.sceneId] || [];
        return (scene.options || []).filter(option => !option.once || !used.includes(option.key));
    }

    /**
     * Resolve a listed scene option for a player - either a travel option
     * (direct goto/end) or a d20 check with structured effects.
     * @param {number} adventureId
     * @param {string} userId
     * @param {string} optionKey
     * @returns {Object} result (see _buildResult)
     */
    async chooseOption(adventureId, userId, optionKey) {
        const { adventure, quest, scene, character } = await this._requireActiveTurn(adventureId, userId);
        const option = this.availableOptions(adventure, quest).find(o => o.key === optionKey);
        if (!option) throw new TavernError('NO_OPTION', 'That option is not available right now.');

        if (option.goto !== undefined || option.end !== undefined) {
            return await this._resolveTravel({ adventure, quest, scene, character, userId, option });
        }
        return await this._resolveCheck({
            adventure, quest, scene, character, userId,
            source: { type: 'option', option },
            stat: option.stat,
            dc: questLoader.resolveDc(option.dc),
            actionLabel: option.label
        });
    }

    /**
     * Resolve a freeform action ("I use my cooking pot as a helmet and ram
     * the door"). The stat/DC may come from an AI interpretation; otherwise
     * the deterministic keyword fallback picks the stat and the DC defaults
     * to 'challenging'.
     * @param {number} adventureId
     * @param {string} userId
     * @param {string} actionText
     * @param {{stat?: string, dc?: number}} [interpretation]
     * @returns {Object} result
     */
    async freeform(adventureId, userId, actionText, interpretation = null) {
        const { adventure, quest, scene, character } = await this._requireActiveTurn(adventureId, userId);
        const clean = String(actionText || '').trim();
        if (!clean) throw new TavernError('BAD_ACTION', 'Describe what you do.');
        if (clean.length > 300) throw new TavernError('BAD_ACTION', 'Keep an action under 300 characters - save the novel for the recap.');

        let stat = interpretation?.stat;
        if (!STAT_KEYS.includes(stat)) stat = this.inferStat(clean);
        let dc = interpretation?.dc;
        if (!Number.isInteger(dc) || dc < 2 || dc > 30) dc = DEFAULT_FREEFORM_DC;

        return await this._resolveCheck({
            adventure, quest, scene, character, userId,
            source: { type: 'freeform', actionText: clean },
            stat, dc,
            actionLabel: clean
        });
    }

    /**
     * Attack a living enemy in the scene's encounter: d20 + stat (default
     * your best of Might/Finesse) vs the enemy's defense DC. A hit deals
     * fixed damage (+1 on a natural 20); defeats fire loot effects, and the
     * last enemy falling fires the encounter's onVictory block.
     * @param {number} adventureId
     * @param {string} userId
     * @param {string} enemyId
     * @param {string} [statOverride] - might|finesse|wits|heart
     * @returns {Object} result
     */
    async attack(adventureId, userId, enemyId, statOverride = null) {
        const { adventure, quest, scene, character } = await this._requireActiveTurn(adventureId, userId);
        const enemy = this._requireLivingEnemy(adventure, scene, enemyId);
        const stat = STAT_KEYS.includes(statOverride)
            ? statOverride
            : (character.might >= character.finesse ? 'might' : 'finesse');
        return await this._resolveAttack({ adventure, quest, scene, character, userId, enemy, stat });
    }

    /**
     * Living enemies of the current scene's encounter (empty when no combat).
     * @param {Object} adventure
     * @param {Object} quest
     * @returns {Array<Object>} enemy definitions + currentHealth
     */
    livingEnemies(adventure, quest) {
        const scene = quest.scenes[adventure.sceneId];
        const combat = adventure.state.combat;
        if (!scene?.encounter || !combat || combat.sceneId !== adventure.sceneId) return [];
        return scene.encounter.enemies
            .map(enemy => ({ ...enemy, currentHealth: combat.enemies[enemy.id]?.health ?? 0 }))
            .filter(enemy => enemy.currentHealth > 0);
    }

    /**
     * The intent an enemy is currently telegraphing (what it does next).
     * @param {Object} adventure
     * @param {Object} enemy - enemy definition
     * @returns {string}
     */
    telegraphedIntent(adventure, enemy) {
        const index = adventure.state.combat?.intentIndex?.[enemy.id] || 0;
        return enemy.intents[index % enemy.intents.length];
    }

    /**
     * Use a consumable during an adventure. Only items the campaign defines
     * as usable (quest.yaml `items:`) do anything; the item is consumed and
     * its use effects (heal/spark) land on the user. Using an item counts as
     * an action - in combat, the enemies notice.
     * @param {number} adventureId
     * @param {string} userId
     * @param {string} itemName
     * @returns {Object} result
     */
    async useItem(adventureId, userId, itemName) {
        const { adventure, quest, scene, character } = await this._requireActiveTurn(adventureId, userId);
        const defs = quest.items || {};
        const defKey = Object.keys(defs).find(key => key.toLowerCase() === String(itemName).trim().toLowerCase());
        if (!defKey) {
            throw new TavernError('NOT_USABLE', `You fiddle with "${itemName}" but nothing obvious happens here. (Not every keepsake is a tool.)`);
        }
        const removed = await characterService.removeItem(character.id, defKey);
        if (!removed) throw new TavernError('NO_ITEM', `You are not carrying "${defKey}".`);

        const use = defs[defKey].use;
        const happenings = [];
        const result = this._buildResult({
            kind: 'item', userId, character,
            actionLabel: `Use ${removed}`,
            outcomeText: use.text ? String(use.text).trim() : ''
        });
        const context = { adventure, quest, character, happenings, result };
        if (use.heal) {
            const { health } = await characterService.adjustHealth(character.id, use.heal);
            happenings.push(`💚 ${character.name} recovers ${use.heal} (${health}/${character.maxHealth} health).`);
        }
        if (use.spark) {
            const spark = await characterService.adjustSpark(character.id, use.spark);
            happenings.push(`✨ ${character.name} gains ${use.spark} Spark (${spark} total).`);
        }
        happenings.push(`🎒 ${removed} is spent.`);

        await this._tickCombat(context, scene);
        this._advanceSpotlight(adventure);
        adventure.state.lastCheck = null;
        if (!result.ended) await this._saveState(adventure.id, adventure);
        await this._log(adventure.id, 'ACTION', userId, `${character.name} used "${removed}".`);

        result.happenings = happenings;
        result.adventure = await this.getAdventure(adventure.id);
        result.character = await characterService.getById(character.id);
        return result;
    }

    /**
     * Re-point a running adventure at a forge-built story fork: the questId
     * moves to the (hidden) fork campaign and the party enters its entry
     * scene. Once per adventure.
     * @param {number} adventureId
     * @param {string} forkQuestId
     * @param {string} entrySceneId
     * @param {string} note - one-line summary of the twist (logged)
     * @returns {{adventure: Object, quest: Object, scene: Object, members: Array}}
     */
    async applyTwist(adventureId, forkQuestId, entrySceneId, note) {
        const adventure = await this.getAdventure(adventureId);
        if (!adventure || adventure.status !== 'ACTIVE') throw new TavernError('NOT_ACTIVE', 'That adventure is not in play right now.');
        const quest = questLoader.getQuest(forkQuestId);
        if (!quest || !quest.scenes[entrySceneId]) {
            throw new TavernError('NO_QUEST', 'The story fork failed to materialize.');
        }
        await db.run(
            'UPDATE tavern_adventures SET questId = @forkQuestId, updatedAt = CURRENT_TIMESTAMP WHERE id = @adventureId',
            { adventureId, forkQuestId }
        );
        adventure.questId = forkQuestId;
        adventure.state.twistUsed = true;
        await this._log(adventureId, 'EVENT', null, `The story bends: ${String(note).trim()}`);
        const happenings = [];
        await this._enterScene(adventure, quest, entrySceneId, happenings);
        await this._saveState(adventureId, adventure);
        return await this.describe(adventureId);
    }

    /**
     * Spend 1 Spark to reroll your most recent failed check (or missed
     * attack). The cost of the first stumble stands; a success now carries
     * the action through.
     * @param {number} adventureId
     * @param {string} userId
     * @returns {Object} result
     */
    async sparkReroll(adventureId, userId) {
        const { adventure, quest, scene, character } = await this._requireActiveTurn(adventureId, userId);
        const last = adventure.state.lastCheck;
        if (!last || last.userId !== userId) {
            throw new TavernError('NO_REROLL', 'No check of yours to reroll - the moment has passed.');
        }
        if (last.success) throw new TavernError('NO_REROLL', 'That check succeeded - save the Spark for a darker hour.');
        if (last.rerolled) throw new TavernError('NO_REROLL', 'You already spent Spark on that moment. The story moves on.');
        if (last.sceneId !== adventure.sceneId) throw new TavernError('NO_REROLL', 'The scene has moved on.');
        if (character.spark < 1) throw new TavernError('NO_SPARK', 'You have no Spark left. Complications will make more.');

        await characterService.adjustSpark(character.id, -1);

        if (last.enemyId) {
            const enemy = this._requireLivingEnemy(adventure, scene, last.enemyId);
            return await this._resolveAttack({
                adventure, quest, scene,
                character: await characterService.getById(character.id),
                userId, enemy, stat: last.stat, reroll: true
            });
        }

        let source, actionLabel;
        if (last.optionKey) {
            const option = (scene.options || []).find(o => o.key === last.optionKey);
            if (!option) throw new TavernError('NO_REROLL', 'That option has vanished from the scene.');
            source = { type: 'option', option };
            actionLabel = `${option.label} (Spark reroll)`;
        } else {
            source = { type: 'freeform', actionText: last.actionText };
            actionLabel = `${last.actionText} (Spark reroll)`;
        }

        return await this._resolveCheck({
            adventure, quest, scene,
            character: await characterService.getById(character.id),
            userId, source,
            stat: last.stat, dc: last.dc,
            actionLabel,
            reroll: true
        });
    }

    /**
     * Fire your Calling's once-per-adventure big move: your next check
     * automatically succeeds.
     * @param {number} adventureId
     * @param {string} userId
     * @returns {{calling: string}}
     */
    async useBigMove(adventureId, userId) {
        const { adventure, character } = await this._requireActiveTurn(adventureId, userId);
        if (adventure.state.bigMovesUsed?.[userId]) {
            throw new TavernError('BIG_MOVE_USED', 'Your big moment already happened this adventure.');
        }
        adventure.state.bigMovesUsed = { ...adventure.state.bigMovesUsed, [userId]: true };
        adventure.state.autoSuccess = { ...adventure.state.autoSuccess, [userId]: true };
        await this._saveState(adventureId, adventure);
        await this._log(adventureId, 'EVENT', userId, `${character.name} readies their big moment - the next thing they try will simply work.`);
        return { calling: character.calling };
    }

    // ------------------------------------------------------------------
    // Recaps
    // ------------------------------------------------------------------

    /**
     * The latest stored recap in a guild (optionally scoped to a channel).
     * @param {string} guildId
     * @param {string} [channelId]
     * @returns {{adventureId: number, questId: string, content: string, createdAt: string}|null}
     */
    async getLatestRecap(guildId, channelId = null) {
        const row = await db.get(
            `SELECT l.adventureId, a.questId, l.content, l.createdAt
             FROM tavern_adventure_log l
             JOIN tavern_adventures a ON a.id = l.adventureId
             WHERE l.kind = 'RECAP' AND a.guildId = @guildId
               AND (@channelId IS NULL OR a.channelId = @channelId)
             ORDER BY l.id DESC LIMIT 1`,
            { guildId, channelId }
        );
        return row || null;
    }

    /**
     * Assemble the deterministic recap for an adventure from its log.
     * @param {number} adventureId
     * @returns {string}
     */
    async buildRecap(adventureId) {
        const adventure = await this.getAdventure(adventureId);
        const quest = questLoader.getQuest(adventure.questId);
        const members = await this.getMembers(adventureId);
        const rows = await db.all(
            `SELECT kind, content FROM tavern_adventure_log
             WHERE adventureId = @adventureId AND kind IN ('SCENE', 'ACTION', 'CHECK', 'EVENT')
             ORDER BY id`,
            { adventureId }
        );
        const beats = rows.slice(-RECAP_MAX_BEATS).map(row => `• ${row.content}`);
        const ending = adventure.endingId ? quest?.endings?.[adventure.endingId] : null;
        const partyLine = members.map(m => m.character?.name).filter(Boolean).join(', ') || 'a party of mysterious strangers';

        const lines = [
            `**${quest?.title || adventure.questId}** — as survived by ${partyLine}.`,
            '',
            ...beats
        ];
        if (ending) {
            lines.push('', `**${ending.title}** — ${ending.text.trim()}`);
        }
        return lines.join('\n');
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /**
     * Deterministic keyword-based stat inference for freeform actions.
     * @param {string} actionText
     * @returns {string} stat key
     */
    inferStat(actionText) {
        const words = String(actionText).toLowerCase().split(/[^a-z]+/);
        const scores = { might: 0, finesse: 0, wits: 0, heart: 0 };
        for (const word of words) {
            for (const [stat, keywords] of Object.entries(STAT_KEYWORDS)) {
                if (keywords.includes(word)) scores[stat]++;
            }
        }
        let best = 'wits';
        let bestScore = 0;
        for (const stat of STAT_KEYS) {
            if (scores[stat] > bestScore) {
                best = stat;
                bestScore = scores[stat];
            }
        }
        return best;
    }

    /**
     * Common guards for anything that plays a turn.
     */
    async _requireActiveTurn(adventureId, userId) {
        const adventure = await this.getAdventure(adventureId);
        if (!adventure) throw new TavernError('NO_ADVENTURE', 'That adventure no longer exists.');
        if (adventure.status !== 'ACTIVE') throw new TavernError('NOT_ACTIVE', 'That adventure is not in play right now.');
        const quest = questLoader.getQuest(adventure.questId);
        if (!quest) throw new TavernError('NO_QUEST', `The campaign '${adventure.questId}' is no longer installed.`);
        const scene = quest.scenes[adventure.sceneId];
        if (!scene) throw new TavernError('NO_SCENE', 'The scene is missing from the campaign files.');
        const membership = await db.get(
            'SELECT characterId FROM tavern_party_members WHERE adventureId = @adventureId AND userId = @userId',
            { adventureId, userId }
        );
        if (!membership) throw new TavernError('NOT_MEMBER', 'You are not in this party. Join before the next one starts!');
        const character = await characterService.getById(membership.characterId);
        if (!character) throw new TavernError('NO_CHARACTER', 'Your character sheet has gone missing.');
        return { adventure, quest, scene, character };
    }

    /**
     * A travel option: no roll, straight to a new scene or an ending
     * (optionally with side effects - e.g. an ending choice that moves an
     * NPC relationship - applied before the travel itself).
     */
    async _resolveTravel({ adventure, quest, scene, character, userId, option }) {
        const happenings = [];
        this._markUsed(adventure, scene.id, option);

        const result = this._buildResult({
            kind: 'travel', userId, character,
            actionLabel: option.label,
            outcomeText: option.text ? String(option.text).trim() : ''
        });

        await this._log(adventure.id, 'ACTION', userId, `${character.name} chose "${option.label}".`);

        if (option.effects) {
            await this._applyEffects({ adventure, quest, character, happenings, result }, option.effects, 0);
        }

        if (option.end !== undefined) {
            result.ended = await this._finish(adventure, quest, option.end);
        } else {
            await this._enterScene(adventure, quest, option.goto, happenings);
            result.sceneChanged = true;
        }

        this._advanceSpotlight(adventure);
        adventure.state.lastCheck = null;
        if (!result.ended) await this._saveState(adventure.id, adventure);

        result.happenings = happenings;
        result.adventure = await this.getAdventure(adventure.id);
        return result;
    }

    /**
     * A d20 check: roll + stat (+ item bonus) vs DC, then apply the outcome's
     * structured effects. Nat 20 grants Spark (triumph); nat 1 also grants
     * Spark and ticks the scene's danger clock (complications are story fuel).
     */
    async _resolveCheck({ adventure, quest, scene, character, userId, source, stat, dc, actionLabel, reroll = false }) {
        const happenings = [];

        // Item bonus (declared per option: e.g. the Waterlogged Hymnal helps the hymn)
        let bonus = 0;
        let bonusNote = null;
        if (source.type === 'option' && source.option.bonus && characterService.hasItem(character, source.option.bonus.item)) {
            bonus = source.option.bonus.value;
            bonusNote = source.option.bonus.item;
        }

        // Calling big move: consume pending auto-success
        let auto = false;
        if (adventure.state.autoSuccess?.[userId] && !reroll) {
            auto = true;
            const autoSuccess = { ...adventure.state.autoSuccess };
            delete autoSuccess[userId];
            adventure.state.autoSuccess = autoSuccess;
        }

        const roll = this._d20();
        const statValue = character[stat];
        const total = roll + statValue + bonus;
        const success = auto || total >= dc;

        // Outcome text + effects
        let outcomeText;
        let effects;
        if (source.type === 'option') {
            const outcome = success ? source.option.success : source.option.failure;
            outcomeText = String(outcome?.text || '').trim();
            effects = outcome?.effects || null;
            this._markUsed(adventure, scene.id, source.option);
        } else {
            const freeform = scene.freeform || {};
            outcomeText = String((success ? freeform.success : freeform.failure) || '').trim();
            effects = this._freeformEffects(quest, scene, success);
        }

        const result = this._buildResult({
            kind: source.type === 'option' ? 'check' : 'freeform',
            userId, character, actionLabel, outcomeText,
            stat, dc, roll, total, statValue, bonus, bonusNote, auto, success, reroll
        });

        if (auto) happenings.push(`✨ ${character.name}'s big moment: no dice required.`);
        if (bonusNote) happenings.push(`🎒 The ${bonusNote} helps (+${bonus}).`);

        const context = { adventure, quest, character, happenings, result };
        if (effects) await this._applyEffects(context, effects, 0);

        // Natural roll flourishes (skipped when the big move made dice moot)
        if (!auto && roll === 20) {
            const spark = await characterService.adjustSpark(character.id, 1);
            happenings.push(`🌟 Natural 20! ${character.name} gains 1 Spark (${spark} total).`);
        }
        if (!auto && roll === 1) {
            const spark = await characterService.adjustSpark(character.id, 1);
            happenings.push(`💫 Natural 1 - a complication blooms, and ${character.name} gains 1 Spark from the chaos (${spark} total).`);
            await this._tickDangerClock(context);
        }

        // In an encounter, every action draws the round forward
        await this._tickCombat(context, scene);

        // Remember the check for a possible Spark reroll (unless the story moved)
        if (!result.ended && !result.sceneChanged) {
            adventure.state.lastCheck = {
                userId,
                sceneId: scene.id,
                optionKey: source.type === 'option' ? source.option.key : null,
                actionText: source.type === 'freeform' ? source.actionText : null,
                stat, dc, roll, total, success,
                rerolled: reroll
            };
        } else {
            adventure.state.lastCheck = null;
        }

        this._advanceSpotlight(adventure);
        if (!result.ended) await this._saveState(adventure.id, adventure);

        const rollText = auto ? 'auto-success (big move)' : `rolled ${roll}+${statValue + bonus} = ${total} vs DC ${dc}`;
        await this._log(
            adventure.id, 'CHECK', userId,
            `${character.name} tried "${actionLabel}" - ${rollText}: ${success ? 'success' : 'failure'}.`,
            JSON.stringify({ stat, dc, roll, total, bonus, auto, success, reroll })
        );

        result.happenings = happenings;
        result.canReroll = !success && !reroll && !result.ended && !result.sceneChanged
            && (await characterService.getById(character.id)).spark > 0;
        result.adventure = await this.getAdventure(adventure.id);
        result.character = await characterService.getById(character.id);
        return result;
    }

    /** Guard: the named enemy exists in this scene's encounter and stands. */
    _requireLivingEnemy(adventure, scene, enemyId) {
        const combat = adventure.state.combat;
        if (!scene.encounter || !combat || combat.sceneId !== adventure.sceneId) {
            throw new TavernError('NO_COMBAT', 'There is nothing here that wants fighting. (Options and freeform actions still work.)');
        }
        const enemy = scene.encounter.enemies.find(e => e.id === enemyId);
        if (!enemy) throw new TavernError('NO_ENEMY', 'No such foe in this scene.');
        if ((combat.enemies[enemy.id]?.health ?? 0) <= 0) {
            throw new TavernError('ENEMY_DOWN', `${enemy.name} is already down. Gracious in victory, please.`);
        }
        return enemy;
    }

    /**
     * An attack roll against an enemy: d20 + stat vs its defense DC. Hits
     * deal fixed damage (+1 on nat 20); the last enemy falling fires
     * onVictory. Misses still advance the enemy round.
     */
    async _resolveAttack({ adventure, quest, scene, character, userId, enemy, stat, reroll = false }) {
        const happenings = [];
        const dc = questLoader.resolveDc(enemy.defense);
        const combat = adventure.state.combat;

        let auto = false;
        if (adventure.state.autoSuccess?.[userId] && !reroll) {
            auto = true;
            const autoSuccess = { ...adventure.state.autoSuccess };
            delete autoSuccess[userId];
            adventure.state.autoSuccess = autoSuccess;
        }

        const roll = this._d20();
        const statValue = character[stat];
        const total = roll + statValue;
        const success = auto || total >= dc;

        const result = this._buildResult({
            kind: 'attack', userId, character,
            actionLabel: `${reroll ? 'Attack (Spark reroll): ' : 'Attack '}${enemy.name}`,
            outcomeText: '',
            stat, dc, roll, total, statValue, bonus: 0, bonusNote: null, auto, success, reroll,
            enemyId: enemy.id
        });
        const context = { adventure, quest, character, happenings, result };

        if (auto) happenings.push(`✨ ${character.name}'s big moment: no dice required.`);

        if (success) {
            const damage = ATTACK_DAMAGE + (!auto && roll === 20 ? CRIT_BONUS_DAMAGE : 0);
            const newHealth = Math.max(0, (combat.enemies[enemy.id]?.health ?? 0) - damage);
            combat.enemies[enemy.id] = { health: newHealth };
            happenings.push(`⚔️ ${character.name} strikes **${enemy.name}** for ${damage} (${newHealth}/${enemy.health}).`);

            if (newHealth === 0) {
                happenings.push(`💀 **${enemy.name}** is defeated!${enemy.onDefeat?.text ? ` ${String(enemy.onDefeat.text).trim()}` : ''}`);
                if (enemy.onDefeat?.effects) await this._applyEffects(context, enemy.onDefeat.effects, 0);

                const anyoneLeft = this.livingEnemies(adventure, quest).length > 0;
                if (!anyoneLeft && !result.ended && !result.sceneChanged) {
                    const victory = scene.encounter.onVictory;
                    happenings.push(`🏆 The encounter is won!${victory?.text ? ` ${String(victory.text).trim()}` : ''}`);
                    if (victory?.effects) await this._applyEffects(context, victory.effects, 0);
                    if (!result.ended && !result.sceneChanged) adventure.state.combat = null;
                }
            }
        } else {
            happenings.push(`🛡️ **${enemy.name}** weathers the attempt.`);
        }

        if (!auto && roll === 20) {
            const spark = await characterService.adjustSpark(character.id, 1);
            happenings.push(`🌟 Natural 20! ${character.name} gains 1 Spark (${spark} total).`);
        }
        if (!auto && roll === 1) {
            const spark = await characterService.adjustSpark(character.id, 1);
            happenings.push(`💫 Natural 1 - a complication blooms, and ${character.name} gains 1 Spark from the chaos (${spark} total).`);
            await this._tickDangerClock(context);
        }

        await this._tickCombat(context, scene);

        if (!result.ended && !result.sceneChanged && adventure.state.combat) {
            adventure.state.lastCheck = {
                userId, sceneId: scene.id,
                optionKey: null, actionText: null, enemyId: enemy.id,
                stat, dc, roll, total, success,
                rerolled: reroll
            };
        } else {
            adventure.state.lastCheck = null;
        }

        this._advanceSpotlight(adventure);
        if (!result.ended) await this._saveState(adventure.id, adventure);

        const rollText = auto ? 'auto-success (big move)' : `rolled ${roll}+${statValue} = ${total} vs defense ${dc}`;
        await this._log(
            adventure.id, 'CHECK', userId,
            `${character.name} attacked ${enemy.name} - ${rollText}: ${success ? 'hit' : 'miss'}.`,
            JSON.stringify({ attack: enemy.id, stat, dc, roll, total, auto, success, reroll })
        );

        result.happenings = happenings;
        result.canReroll = !success && !reroll && !result.ended && !result.sceneChanged
            && Boolean(adventure.state.combat)
            && (await characterService.getById(character.id)).spark > 0;
        result.adventure = await this.getAdventure(adventure.id);
        result.character = await characterService.getById(character.id);
        return result;
    }

    /** Fresh combat state for a scene (null when it has no encounter). */
    _freshCombat(scene) {
        if (!scene?.encounter) return null;
        return {
            sceneId: scene.id,
            enemies: Object.fromEntries(scene.encounter.enemies.map(e => [e.id, { health: e.health }])),
            intentIndex: Object.fromEntries(scene.encounter.enemies.map(e => [e.id, 0])),
            actions: 0
        };
    }

    /**
     * Advance the encounter round: once the party has taken as many actions
     * as it has members, every living enemy executes its telegraphed intent
     * against the character who just acted, then telegraphs the next one.
     */
    async _tickCombat(context, scene) {
        const { adventure, quest, character, happenings, result } = context;
        const combat = adventure.state.combat;
        if (!combat || result.ended || result.sceneChanged) return;
        if (!scene?.encounter || combat.sceneId !== adventure.sceneId) return;

        const living = this.livingEnemies(adventure, quest);
        if (living.length === 0) return;

        combat.actions = (combat.actions || 0) + 1;
        const partySize = Math.max(1, (await this.getMembers(adventure.id)).length);
        if (combat.actions < partySize) return;
        combat.actions = 0;

        for (const enemy of living) {
            if (result.ended) break;
            const index = combat.intentIndex[enemy.id] || 0;
            const intent = enemy.intents[index % enemy.intents.length];
            combat.intentIndex[enemy.id] = index + 1;

            happenings.push(`👹 **${enemy.name}**: *${intent}*`);
            if (enemy.damage > 0) {
                const { health, staggered } = await characterService.adjustHealth(character.id, -enemy.damage);
                happenings.push(`💥 It catches ${character.name} for ${enemy.damage} (${health}/${character.maxHealth} health).`);
                if (staggered) {
                    happenings.push(`😵 ${character.name} is knocked flat and staggers back up - barely.`);
                    await this._tickDangerClock(context);
                }
            }
            const next = enemy.intents[(index + 1) % enemy.intents.length];
            happenings.push(`🔮 Next: *${next}*`);
        }
    }

    /**
     * Default structured effects for freeform actions: success advances the
     * scene's progress clock, failure ticks its danger clock.
     */
    _freeformEffects(quest, scene, success) {
        const freeform = scene.freeform || {};
        if (success) {
            const clockId = freeform.progressClock
                || (quest.clocks || []).find(c => c.kind === 'progress')?.id;
            return clockId ? { clock: { id: clockId, delta: 1 } } : null;
        }
        const clockId = freeform.dangerClock
            || (quest.clocks || []).find(c => c.kind === 'danger')?.id;
        return clockId ? { clock: { id: clockId, delta: 1 } } : null;
    }

    /**
     * Apply a structured effects object (the closed vocabulary) to the
     * adventure + acting character, appending human-readable happenings.
     */
    async _applyEffects(context, effects, depth) {
        if (!effects || depth > MAX_EFFECT_DEPTH) return;
        const { adventure, quest, character, happenings, result } = context;

        if (effects.clock) {
            await this._tickClock(context, effects.clock.id, effects.clock.delta, depth);
        }
        if (effects.damage) {
            const { health, staggered } = await characterService.adjustHealth(character.id, -effects.damage);
            happenings.push(`💔 ${character.name} takes ${effects.damage} harm (${health}/${character.maxHealth} health).`);
            if (staggered) {
                happenings.push(`😵 ${character.name} is knocked flat and staggers back up - barely.`);
                await this._tickDangerClock(context, depth + 1);
            }
        }
        if (effects.heal) {
            const { health } = await characterService.adjustHealth(character.id, effects.heal);
            happenings.push(`💚 ${character.name} recovers ${effects.heal} (${health}/${character.maxHealth} health).`);
        }
        if (effects.item) {
            await characterService.addItem(character.id, effects.item);
            happenings.push(`🎒 ${character.name} gains **${effects.item}**.`);
        }
        if (effects.spark) {
            const spark = await characterService.adjustSpark(character.id, effects.spark);
            happenings.push(`✨ ${character.name} gains ${effects.spark} Spark (${spark} total).`);
        }
        if (effects.flag) {
            adventure.state.flags = { ...adventure.state.flags, [effects.flag.key]: effects.flag.value };
        }
        if (effects.npc) {
            const npc = NPCS[effects.npc.key];
            if (npc) {
                const standing = await worldService.adjustRelationship(adventure.guildId, effects.npc.key, context.result.userId, effects.npc.delta);
                const arrow = effects.npc.delta >= 0 ? '💞' : '💢';
                happenings.push(`${arrow} ${npc.name} will remember this (${character.name}: ${standing.label}).`);
            }
        }
        if (effects.end !== undefined && !result.ended) {
            result.ended = await this._finish(adventure, quest, effects.end);
            return;
        }
        if (effects.goto !== undefined && !result.ended) {
            await this._enterScene(adventure, quest, effects.goto, happenings);
            result.sceneChanged = true;
        }
    }

    /**
     * Advance a clock (clamped 0..size); a clock reaching full fires its
     * onFull effects once.
     */
    async _tickClock(context, clockId, delta, depth) {
        const { adventure, quest, happenings } = context;
        const clock = (quest.clocks || []).find(c => c.id === clockId);
        if (!clock) return;
        const before = adventure.state.clocks[clockId] || 0;
        const after = Math.max(0, Math.min(clock.size, before + delta));
        if (after === before) return;
        adventure.state.clocks[clockId] = after;
        const face = clock.kind === 'danger' ? '⚠️' : '🕰️';
        happenings.push(`${face} **${clock.name}**: ${after}/${clock.size}`);
        if (after === clock.size && before < clock.size && clock.onFull) {
            await this._applyEffects(context, clock.onFull, depth + 1);
        }
    }

    /** Tick the quest's danger clock by 1 (used by nat-1s and staggers). */
    async _tickDangerClock(context, depth = 1) {
        const scene = context.quest.scenes[context.adventure.sceneId] || {};
        const clockId = scene.freeform?.dangerClock
            || (context.quest.clocks || []).find(c => c.kind === 'danger')?.id;
        if (clockId) await this._tickClock(context, clockId, 1, depth);
    }

    /** Move the adventure into a new scene and log its opening beat. */
    async _enterScene(adventure, quest, sceneId, happenings) {
        const scene = quest.scenes[sceneId];
        if (!scene) return;
        adventure.sceneId = sceneId;
        adventure.state.lastCheck = null;
        adventure.state.combat = this._freshCombat(scene);
        await db.run(
            'UPDATE tavern_adventures SET sceneId = @sceneId, updatedAt = CURRENT_TIMESTAMP WHERE id = @adventureId',
            { adventureId: adventure.id, sceneId }
        );
        happenings.push(`📖 The story moves on: **${scene.title}**`);
        if (adventure.state.combat) {
            const foes = scene.encounter.enemies.map(e => e.name).join(', ');
            happenings.push(`⚔️ An encounter begins: **${foes}**!`);
        }
        await this._log(adventure.id, 'SCENE', null, `The party reached "${scene.title}".`);
    }

    /**
     * Complete the adventure: persist the ending, reward the party (milestone,
     * Spark, hearth rest, trophy), and store the automatic recap.
     * @returns {{endingId: string, ending: Object}}
     */
    async _finish(adventure, quest, endingId) {
        const ending = quest.endings[endingId];
        const members = await this.getMembers(adventure.id);

        await db.transaction(async () => {
            await db.run(
                `UPDATE tavern_adventures
                 SET status = 'COMPLETED', endingId = @endingId, state = @state,
                     completedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @adventureId`,
                { adventureId: adventure.id, endingId, state: adventure.state }
            );
            for (const member of members) {
                if (!member.character) continue;
                await characterService.recordCompletion(member.character.id);
                if (ending?.trophy) await characterService.addItem(member.character.id, ending.trophy);
            }
            // The world remembers: the ending writes its lore into the guild
            for (const entry of ending?.world || []) {
                await worldService.recordLore({
                    guildId: adventure.guildId,
                    kind: entry.kind, name: entry.name, content: entry.text,
                    sourceQuestId: adventure.questId, sourceAdventureId: adventure.id
                });
            }
        });

        await this._log(adventure.id, 'EVENT', null, `The adventure concluded: ${ending?.title || endingId}.`);
        await this._log(adventure.id, 'RECAP', null, await this.buildRecap(adventure.id));
        return { endingId, ending };
    }

    /** Mark a once-option as used in the scene. */
    _markUsed(adventure, sceneId, option) {
        if (!option.once) return;
        const usedOptions = { ...adventure.state.usedOptions };
        usedOptions[sceneId] = [...(usedOptions[sceneId] || []), option.key];
        adventure.state.usedOptions = usedOptions;
    }

    /** Rotate the spotlight to the next party member. */
    _advanceSpotlight(adventure) {
        const spotlight = adventure.state.spotlight || [];
        if (spotlight.length === 0) return;
        adventure.state.spotlightIndex = ((adventure.state.spotlightIndex || 0) + 1) % spotlight.length;
    }

    /** Whose narrative spotlight it is (a nudge, never a gate). */
    spotlightUser(adventure) {
        const spotlight = adventure.state.spotlight || [];
        if (spotlight.length === 0) return null;
        return spotlight[(adventure.state.spotlightIndex || 0) % spotlight.length];
    }

    async _saveState(adventureId, adventure) {
        await db.run(
            'UPDATE tavern_adventures SET state = @state, updatedAt = CURRENT_TIMESTAMP WHERE id = @adventureId',
            { adventureId, state: adventure.state }
        );
    }

    async _log(adventureId, kind, userId, content, detail = null) {
        await db.run(
            `INSERT INTO tavern_adventure_log (adventureId, kind, userId, content, detail)
             VALUES (@adventureId, @kind, @userId, @content, @detail)`,
            { adventureId, kind, userId, content, detail }
        );
    }

    _buildResult(fields) {
        return {
            ended: null,
            sceneChanged: false,
            happenings: [],
            canReroll: false,
            ...fields
        };
    }
}

module.exports = new AdventureService();
module.exports.AdventureService = AdventureService;
