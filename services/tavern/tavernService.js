const content = require('./content');
const questLoader = require('./questLoader');
const adventureService = require('./adventureService');
const characterService = require('./characterService');

/**
 * The Tavern's front-of-house: aggregates everything the Common Room views
 * need (daily rumor, ambience, NPCs on shift, the quest board, open parties).
 */
class TavernService {
    /**
     * Everything the /tavern status embed shows.
     * @param {string} guildId
     * @returns {Object}
     */
    getStatus(guildId) {
        const quests = questLoader.getVisibleQuests();
        return {
            rumor: content.dailyRumor(guildId),
            weather: content.dailyWeather(guildId),
            npcs: Object.values(content.NPCS).map(npc => ({
                ...npc,
                line: content.npcChatter(npc, guildId)
            })),
            quests,
            openAdventures: adventureService.listOpenAdventures(guildId).map(row => ({
                ...row,
                title: questLoader.getQuest(row.questId)?.title || row.questId
            })),
            characterCount: characterService.countByGuild(guildId)
        };
    }

    /**
     * The quest board entries.
     * @returns {Array<Object>}
     */
    getQuestBoard() {
        return questLoader.getVisibleQuests();
    }

    /**
     * One NPC by key, with today's line of chatter.
     * @param {string} guildId
     * @param {string} npcKey
     * @returns {Object|null}
     */
    getNpc(guildId, npcKey) {
        const npc = content.NPCS[npcKey];
        if (!npc) return null;
        return { ...npc, line: content.npcChatter(npc, guildId) };
    }

    /**
     * A member's tavern profile (their character, or null).
     * @param {string} guildId
     * @param {string} userId
     * @returns {Object|null}
     */
    getProfile(guildId, userId) {
        return characterService.getCharacter(guildId, userId);
    }
}

module.exports = new TavernService();
module.exports.TavernService = TavernService;
