/**
 * Decision Generator
 * Handles processing player decisions and generating their consequences
 */

require('dotenv').config();
const logger = require('../utils/logger');
const promptBuilder = require('../utils/promptBuilder');
const responseParser = require('../utils/responseParser');
const AdventureValidator = require('../validators/adventureValidator');
const adventureValidatorInstance = new AdventureValidator();
const { getPrompt, getPromptWithGuildPersonality } = require('../../../utils/memeMode');
const { formatJSON } = require('../utils/responseFormatter');
const aiService = require('../../aiService');

class DecisionGenerator {
    constructor(openai, userId) {
        this.openai = openai;
        this.userId = userId;
        this.guildId = null;
        
        // Default settings for decision processing
        this.defaultSettings = {
            aiModel: 'gpt-4o',
            temperature: 0.7,
            considerPartySize: true,
            considerPreviousChoices: true,
        };
    }

    /**
     * Process a player's decision and generate consequences
     * @param {Object} options Decision processing options
     * @param {Object} options.scene Current scene
     * @param {Object} options.choice Chosen action
     * @param {Object} options.party Current party state
     * @param {Array} options.history Previous decisions
     * @param {string} options.adventureId Adventure ID
     * @returns {Promise<Object>} Decision consequences
     */
    async processDecision({ scene, choice, party, history, adventureId }) {
        try {
            // Validate decision using the instance
            adventureValidatorInstance.validateDecision({
                adventureId,
                userId: choice.userId,
                decision: choice.id,
            });

            logger.info('Processing decision', {
                sceneId: scene.id,
                choiceId: choice.id,
            });

            const consequences = await this._generateConsequences({
                scene,
                choice,
                party,
                history,
            });

            // Analyze the impact of the decision
            const impact = this._analyzeDecisionImpact(consequences);

            logger.info('Decision processed', {
                sceneId: scene.id,
                choiceId: choice.id,
                impact,
            });

            return {
                consequences,
                impact,
                timestamp: new Date(),
            };
        } catch (error) {
            logger.error('Failed to process decision', { error });
            throw error;
        }
    }

    /**
     * Generate consequences for a decision
     * @param {Object} options Consequence generation options
     * @returns {Promise<Object>} Generated consequences
     * @private
     */
    async _generateConsequences({ scene, choice, party, history }) {
        const prompt = promptBuilder.buildConsequencePrompt({
            action: choice.text,
            context: scene.description,
            partySize: party.members.length,
            history: JSON.stringify(history.slice(-3)),
        });

        const responseText = await aiService.chat([
            {
                role: 'system',
                content: 'You are an expert in analyzing player decisions and generating meaningful consequences. Format your response as a valid JSON object containing `immediate` (string array), `longTerm` (string array), `objectiveProgress` (object), `resourcesUsed` (object), `gameState` (object), and `partyImpact` (object). The objectiveProgress object should reflect changes to objectives (e.g., { "mainQuest": "updated", "sideQuestA": "completed" }). The resourcesUsed object should detail resources consumed (e.g., { "arrows": 5, "mana": 10 }). The gameState object should reflect changes to world state or flags (e.g., { "alertedGuard": true, "foundSecretDoor": true }). The partyImpact object should describe effects on the party (e.g., { "moraleChange": -1, "statusEffects": ["poisoned"], "relationshipChanges": { "memberA_memberB": "strained" } }). If no changes occurred for a field, provide an empty object or null.'
            },
            {
                role: 'user',
                content: prompt
            }
        ], {
            preset: 'chat',
            temperature: this.defaultSettings.temperature,
            max_tokens: 1000
        });

        try {
            return responseParser.parseConsequenceResponse(responseText);
        } catch (error) {
            logger.error('Failed to parse consequences response', { error });
            throw new Error('Invalid consequences format');
        }
    }

    /**
     * Analyze the impact of a decision based on its consequences
     * @param {Object} consequences Decision consequences
     * @returns {Object} Impact analysis
     * @private
     */
    _analyzeDecisionImpact(consequences) {
        const impact = {
            severity: 'normal',
            type: 'neutral',
            score: 0,
        };

        // Analyze immediate consequences
        consequences.immediate.forEach(consequence => {
            impact.score += this._calculateConsequenceScore(consequence);
        });

        // Consider long-term effects
        consequences.longTerm.forEach(effect => {
            impact.score += this._calculateConsequenceScore(effect) * 0.5; // Less weight for potential effects
        });

        // Determine severity and type based on score
        if (Math.abs(impact.score) >= 8) {
            impact.severity = 'major';
        } else if (Math.abs(impact.score) >= 4) {
            impact.severity = 'moderate';
        }

        impact.type = impact.score > 0 ? 'positive' : impact.score < 0 ? 'negative' : 'neutral';

        return impact;
    }

    /**
     * Calculate a numeric score for a consequence
     * @param {Object} consequence Consequence to analyze
     * @returns {number} Consequence score
     * @private
     */
    _calculateConsequenceScore(consequence) {
        // This is a simple scoring system that could be expanded
        const keywords = {
            positive: ['success', 'gain', 'help', 'improve', 'benefit'],
            negative: ['failure', 'loss', 'harm', 'damage', 'penalty'],
        };

        let score = 0;
        const text = consequence.toLowerCase();

        keywords.positive.forEach(word => {
            if (text.includes(word)) score += 1;
        });

        keywords.negative.forEach(word => {
            if (text.includes(word)) score -= 1;
        });

        return score;
    }

    /**
     * Validate if a decision is possible given the current state
     * @param {Object} options Validation options
     * @returns {Object} Validation result
     */
    validateDecision({ scene, choice, party, requirements = [] }) {
        const validationResult = {
            valid: true,
            reasons: [],
        };

        // Check party requirements
        if (this.defaultSettings.considerPartySize) {
            const minPartySize = choice.requirements?.minPartySize || 1;
            if (party.members.length < minPartySize) {
                validationResult.valid = false;
                validationResult.reasons.push(`Requires at least ${minPartySize} party members`);
            }
        }

        // Check custom requirements
        requirements.forEach(req => {
            if (!this._checkRequirement(req, { scene, party })) {
                validationResult.valid = false;
                validationResult.reasons.push(req.description || 'Failed to meet requirement');
            }
        });

        return validationResult;
    }

    /**
     * Check if a specific requirement is met
     * @param {Object} requirement Requirement to check
     * @param {Object} context Current context
     * @returns {boolean} Whether the requirement is met
     * @private
     */
    _checkRequirement(requirement, context) {
        // This could be expanded based on requirement types
        switch (requirement.type) {
            case 'item':
                return context.party.items?.includes(requirement.item);
            case 'skill':
                return context.party.members.some(m => m.skills?.includes(requirement.skill));
            case 'state':
                return context.scene.state[requirement.key] === requirement.value;
            default:
                return true;
        }
    }

    async generateDecision(params) {
        const systemPrompt = await getPromptWithGuildPersonality(this.userId, this.guildId);
        return await aiService.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: this.buildDecisionPrompt(params) }
        ], {
            preset: 'creative',
            max_tokens: 1000
        });
    }
}

module.exports = DecisionGenerator; 