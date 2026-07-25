const aiService = require('../aiService');
const adventureService = require('./adventureService');
const characterService = require('./characterService');
const narrator = require('./narrator');
const { STATS } = require('./content');

const THINK_DELAY_MS = 2500;
const DECISION_TIMEOUT_MS = 20_000;
const DECISION_MAX_TOKENS = 120;

const PERSONA =
    'You are Goobster, the tavern\'s own quirky, clever spirit, playing AT the table as a party member ' +
    '(calling: Oddity). You are enthusiastic, a little chaotic, and fiercely loyal to the party. ' +
    'You support the players\' plans rather than steal the spotlight.';

/**
 * Goobster as a party member. Every turn is decided by the model, never by
 * built-in strategy - the deterministic pieces here only *legalize* the
 * model's answer into a real engine move and provide the last-resort
 * fallback (mirrors the casino botPlayer architecture: engine stays pure,
 * this service owns the side effects).
 *
 * House rules for the bot:
 *  - He follows, never leads: travel options and ending choices are the
 *    players' to make, so he only takes checks or freeform actions.
 *  - He acts only when the spotlight rotation reaches him, never twice in a
 *    row, and never re-enters while already thinking.
 *  - His failed checks never show a Spark-reroll button to the players.
 */
class BotAdventurer {
    constructor() {
        this._thinking = new Set();
    }

    /**
     * Fire-and-forget trigger, called after any player action. Takes a turn
     * only when Goobster is a party member and the spotlight is his.
     * @param {number} adventureId
     * @param {Object} channel - Discord channel to post into
     */
    maybeTakeTurn(adventureId, channel) {
        const botId = channel?.client?.user?.id;
        if (!botId || this._thinking.has(adventureId)) return;
        if (!this._isBotSpotlight(adventureId, botId)) return;

        this._thinking.add(adventureId);
        const timer = setTimeout(async () => {
            try {
                await this._takeTurn(adventureId, channel, botId);
            } catch (error) {
                console.error('Bot adventurer turn failed:', error);
            } finally {
                this._thinking.delete(adventureId);
            }
        }, THINK_DELAY_MS);
        // A pending think must never hold the process open on shutdown
        timer.unref?.();
    }

    _isBotSpotlight(adventureId, botId) {
        const adventure = adventureService.getAdventure(adventureId);
        if (!adventure || adventure.status !== 'ACTIVE') return false;
        if (adventureService.spotlightUser(adventure) !== botId) return false;
        return adventureService.getMembers(adventureId).some(m => m.userId === botId);
    }

    async _takeTurn(adventureId, channel, botId) {
        // Re-check after the think delay - the table may have moved on
        if (!this._isBotSpotlight(adventureId, botId)) return;
        const { adventure, quest, scene } = adventureService.describe(adventureId);
        const character = characterService.getCharacter(adventure.guildId, botId);
        if (!scene || !character) return;

        // Follows, never leads: no travel options, no ending choices
        const candidates = adventureService.availableOptions(adventure, quest)
            .filter(option => option.goto === undefined && option.end === undefined);

        const decision = await this._decide({ quest, scene, candidates, character, adventure });

        let result;
        let freeformText = null;
        if (decision.optionKey) {
            result = adventureService.chooseOption(adventureId, botId, decision.optionKey);
        } else {
            freeformText = decision.freeform;
            result = adventureService.freeform(adventureId, botId, freeformText);
        }

        // Freeform beats get the same optional AI narration players enjoy
        if (freeformText) {
            try {
                const after = adventureService.describe(adventureId);
                const narration = await narrator.narrateOutcome({
                    quest, scene: after.scene || scene, character: result.character,
                    actionText: freeformText,
                    stat: result.stat, dc: result.dc, roll: result.roll, total: result.total,
                    success: result.success, happenings: result.happenings
                }, { guildId: adventure.guildId, userId: botId });
                if (narration) result.outcomeText = narration;
            } catch {
                // keep the stock line
            }
        }

        // The bot never advertises a Spark reroll to the humans
        result.canReroll = false;

        const views = require('../../utils/tavernViews');
        const { buildSceneView, sendEnding } = require('./interactionHandler');
        await channel.send(views.checkResultMessage(result, adventureId));
        if (result.ended) {
            await sendEnding(channel, quest, result.ended, adventure.guildId);
        } else if (result.sceneChanged) {
            await channel.send(buildSceneView(adventureId));
        }
    }

    /**
     * Ask the model what Goobster does; legalize the answer; fall back to a
     * deterministic pick only when no usable answer arrives.
     * @returns {Promise<{optionKey?: string, freeform?: string}>}
     */
    async _decide({ quest, scene, candidates, character, adventure }) {
        const legal = await this._askModel({ quest, scene, candidates, character, adventure });
        if (legal) return legal;
        return this._fallback({ candidates, character, scene });
    }

    async _askModel({ quest, scene, candidates, character, adventure }) {
        try {
            const optionLines = candidates.map(option =>
                `- key "${option.key}": ${option.label} (${option.stat} check, your ${option.stat} is +${character[option.stat]})`);
            const clocks = (quest.clocks || []).map(clock =>
                `${clock.name}: ${adventure.state.clocks?.[clock.id] || 0}/${clock.size}${clock.kind === 'danger' ? ' (danger!)' : ''}`);
            const prompt =
                `${PERSONA}\n\n` +
                `Adventure: ${quest.title}.\n` +
                `Scene: ${scene.title}. ${String(scene.text).trim().slice(0, 500)}\n` +
                `Clocks: ${clocks.join(' | ') || 'none'}.\n` +
                `Your sheet: Might +${character.might}, Finesse +${character.finesse}, Wits +${character.wits}, Heart +${character.heart}. Health ${character.health}/${character.maxHealth}.\n\n` +
                (optionLines.length > 0
                    ? `Listed moves you may take:\n${optionLines.join('\n')}\n\n`
                    : 'No listed moves suit you right now - improvise.\n\n') +
                'Pick ONE: a listed move, or a short improvised action in character (one sentence, first person). ' +
                'Answer with ONLY JSON: {"choice": "<key>"} or {"act": "<action>"}';

            const text = await Promise.race([
                aiService.generateText(prompt, {
                    max_tokens: DECISION_MAX_TOKENS,
                    temperature: 0.7,
                    usageContext: { guildId: adventure.guildId, userId: null }
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('decision timeout')), DECISION_TIMEOUT_MS))
            ]);
            const match = String(text).match(/\{[\s\S]*\}/);
            if (!match) return null;
            return this.legalize(JSON.parse(match[0]), candidates);
        } catch {
            return null;
        }
    }

    /**
     * Repair/validate a model decision into a legal move (or null).
     * @param {Object} decision - parsed model JSON
     * @param {Array<Object>} candidates - legal check options
     * @returns {{optionKey?: string, freeform?: string}|null}
     */
    legalize(decision, candidates) {
        if (!decision || typeof decision !== 'object') return null;
        if (typeof decision.choice === 'string') {
            const option = candidates.find(o => o.key === decision.choice.trim());
            if (option) return { optionKey: option.key };
        }
        if (typeof decision.act === 'string') {
            const act = decision.act.trim();
            if (act.length >= 3 && act.length <= 300) return { freeform: act };
        }
        return null;
    }

    /**
     * Deterministic last resort: the check option that best suits his sheet,
     * else a stat-appropriate improvised action.
     * @returns {{optionKey?: string, freeform?: string}}
     */
    _fallback({ candidates, character, scene }) {
        if (candidates.length > 0) {
            const best = [...candidates].sort((a, b) => character[b.stat] - character[a.stat])[0];
            return { optionKey: best.key };
        }
        const bestStat = Object.keys(STATS).sort((a, b) => character[b] - character[a])[0];
        const improv = {
            might: `I plant myself between the party and whatever ${scene.title.toLowerCase()} is about to do.`,
            finesse: 'I slip around the edges of the scene, checking for anything the others missed.',
            wits: 'I study the scene carefully, looking for the detail everyone else walked past.',
            heart: 'I rally the party with an encouraging word and a completely unearned wink.'
        };
        return { freeform: improv[bestStat] || improv.wits };
    }
}

module.exports = new BotAdventurer();
module.exports.BotAdventurer = BotAdventurer;
module.exports.PERSONA = PERSONA;
