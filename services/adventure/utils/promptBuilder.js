/**
 * Prompt Builder
 * Constructs consistent prompts for AI interactions
 */

const logger = require('./logger');

class PromptBuilder {
    constructor() {
        this.templates = {
            scene: {
                base: `Create a detailed scene in JSON format with the following structure:
{
    "title": "Scene title",
    "description": "Vivid scene description",
    "choices": [
        {
            "text": "Choice description",
            "consequences": ["potential", "consequences"],
            "requirements": [],
            "metadata": {}
        }
    ],
    "metadata": {
        "mood": "scene mood",
        "difficulty": "scene difficulty"
    }
}

Theme: {theme}
Difficulty: {difficulty}
Previous Context: {context}

Requirements:
1. Return ONLY valid JSON
2. Include {minChoices}-{maxChoices} meaningful choices
3. Provide rich environmental details in description
4. Each choice should have clear consequences`,
                combat: `Create an intense combat scene in JSON format:
{
    "title": "Combat scene title",
    "description": "Vivid combat description",
    "choices": [
        {
            "text": "Tactical option description",
            "consequences": ["potential", "outcomes"],
            "requirements": [],
            "metadata": {"type": "combat"}
        }
    ],
    "metadata": {
        "type": "combat",
        "difficulty": "combat difficulty"
    }
}

Context: {context}
Participants: {participants}
Environment: {environment}

Requirements:
1. Return ONLY valid JSON
2. Include tactical options as choices
3. Consider environmental factors
4. Balance risk/reward in choices`,
                puzzle: `Design an engaging puzzle in JSON format:
{
    "title": "Puzzle title",
    "description": "Clear puzzle description",
    "choices": [
        {
            "text": "Solution attempt description",
            "consequences": ["outcome", "if", "chosen"],
            "requirements": [],
            "metadata": {"type": "puzzle"}
        }
    ],
    "metadata": {
        "type": "puzzle",
        "difficulty": "puzzle difficulty"
    }
}

Type: {puzzleType}
Difficulty: {difficulty}
Context: {context}

Requirements:
1. Return ONLY valid JSON
2. Include multiple solution paths as choices
3. Embed hints in the description
4. Define clear success/failure conditions`,
            },
            character: {
                npc: `Create an NPC with:
                    Role: {role}
                    Context: {context}
                    Personality: {personality}
                    
                    Include:
                    1. Distinct traits
                    2. Motivations
                    3. Potential interactions
                    4. Secrets or hidden aspects`,
            },
            consequence: {
                base: `Generate consequences for:
                    Action: {action}
                    Context: {context}
                    Party Size: {partySize}
                    Previous Choices: {history}
                    
                    Include:
                    1. Immediate effects
                    2. Long-term implications
                    3. Party impact
                    4. World state changes`,
            },
        };
    }

    /**
     * Build a scene prompt
     * @param {Object} options Scene options
     * @returns {string} Formatted prompt
     */
    buildScenePrompt(options) {
        try {
            const template = options.type ? 
                this.templates.scene[options.type] : 
                this.templates.scene.base;

            return this._fillTemplate(template, options);
        } catch (error) {
            logger.error('Failed to build scene prompt', { error });
            throw error;
        }
    }

    /**
     * Build a consequence prompt
     * @param {Object} options Consequence options
     * @returns {string} Formatted prompt
     */
    buildConsequencePrompt(options) {
        try {
            return this._fillTemplate(this.templates.consequence.base, options);
        } catch (error) {
            logger.error('Failed to build consequence prompt', { error });
            throw error;
        }
    }

    /**
     * Build an NPC prompt
     * @param {Object} options NPC options
     * @returns {string} Formatted prompt
     */
    buildNPCPrompt(options) {
        try {
            return this._fillTemplate(this.templates.character.npc, options);
        } catch (error) {
            logger.error('Failed to build NPC prompt', { error });
            throw error;
        }
    }

    /**
     * Fill template with values
     * @param {string} template Template string
     * @param {Object} values Values to insert
     * @returns {string} Filled template
     * @private
     */
    _fillTemplate(template, values) {
        return template.replace(
            /{(\w+)}/g,
            (match, key) => values[key] || match
        );
    }
}

module.exports = new PromptBuilder(); 