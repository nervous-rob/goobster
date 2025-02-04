/**
 * Decision Generator
 * Handles processing player decisions and generating their consequences
 */

require('dotenv').config();
const OpenAI = require('openai');
const logger = require('../utils/logger');
const promptBuilder = require('../utils/promptBuilder');
const responseParser = require('../utils/responseParser');
const adventureValidator = require('../validators/adventureValidator');

class DecisionGenerator {
    constructor() {
        // Get API key from environment or config
        const apiKey = process.env.OPENAI_API_KEY || require('../../../config.json').openaiKey;
        if (!apiKey) {
            throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable or add to config.json');
        }

        // Initialize OpenAI client
        this.openai = new OpenAI({
            apiKey: apiKey
        });
        
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
     * @returns {Promise<Object>} Decision consequences
     */
    async processDecision({ scene, choice, party, history }) {
        try {
            // Validate decision
            adventureValidator.validateDecision({
                adventureId: scene.adventureId,
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

        const response = await this.openai.chat.completions.create({
            model: this.defaultSettings.aiModel,
            messages: [{
                role: 'system',
                content: 'You are an expert in analyzing player decisions and generating meaningful consequences.',
            }, {
                role: 'user',
                content: prompt,
            }],
            temperature: this.defaultSettings.temperature,
        });

        try {
            return responseParser.parseConsequenceResponse(response.choices[0].message.content);
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
}

module.exports = DecisionGenerator; 