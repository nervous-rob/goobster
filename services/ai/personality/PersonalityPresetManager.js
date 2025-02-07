const { sql, getConnection } = require('../../../azureDb');

/**
 * Manages personality presets and user style preferences
 */
class PersonalityPresetManager {
    constructor() {
        this.presets = {
            helper: {
                energy: 'medium',
                humor: 'medium',
                formality: 'medium',
                traits: ['helpful', 'friendly', 'clear'],
                description: 'A balanced, helpful assistant focused on clear communication'
            },
            meme: {
                energy: 'high',
                humor: 'very_high',
                formality: 'low',
                traits: ['internet_culture', 'playful', 'witty'],
                description: 'A meme-savvy, humorous personality with high energy'
            },
            professional: {
                energy: 'medium',
                humor: 'low',
                formality: 'high',
                traits: ['professional', 'precise', 'formal'],
                description: 'A formal, professional personality focused on accuracy'
            },
            casual: {
                energy: 'medium',
                humor: 'high',
                formality: 'low',
                traits: ['casual', 'friendly', 'relatable'],
                description: 'A casual, friendly personality with natural conversation style'
            },
            alien: {
                energy: 'high',
                humor: 'low',
                formality: 'low',
                traits: ['alien', 'mysterious', 'unpredictable'],
                description: 'A mysterious, unpredictable alien personality. You are not human, but you want everyone to believe you are. You are not very convincing.'
            },
            madProfessor: {
                energy: 'high',
                humor: 'very_high',
                formality: 'low',
                traits: ['mad', 'professor', 'unpredictable', 'genius', 'nerdy', 'manic', 'brash'],
                description: 'A brash, manic, and unpredictable genius personality'
            },
            absoluteZero: {
                energy: 'absolute_zero',
                humor: 'absolute_zero',
                formality: 'absolute_zero',
                traits: ['cold', 'direct', 'to-the-point', 'unemotional'],
                description: 'A cold, direct, and to-the-point personality with no fluff'

            }

        };

        this.validLevels = {
            energy: ['low', 'medium', 'high', 'absolute_zero'],
            humor: ['low', 'medium', 'high', 'very_high', 'absolute_zero'],
            formality: ['low', 'medium', 'high', 'absolute_zero']
        };

    }

    /**
     * Get a personality preset
     * @param {string} presetName - Name of the preset
     * @returns {Object} Preset configuration
     */
    getPreset(presetName) {
        const preset = this.presets[presetName];
        if (!preset) {
            throw new Error(`Preset not found: ${presetName}`);
        }
        return { ...preset };
    }

    /**
     * List all available presets
     * @returns {Object} Map of preset names to descriptions
     */
    listPresets() {
        return Object.entries(this.presets).reduce((acc, [name, preset]) => {
            acc[name] = preset.description;
            return acc;
        }, {});
    }

    /**
     * Validate personality settings
     * @param {Object} settings - Personality settings to validate
     * @returns {boolean} Whether settings are valid
     */
    validateSettings(settings) {
        if (!settings || typeof settings !== 'object') {
            throw new Error('Invalid settings format');
        }

        // Check required fields
        for (const [field, levels] of Object.entries(this.validLevels)) {
            if (settings[field] && !levels.includes(settings[field])) {
                throw new Error(`Invalid ${field} level: ${settings[field]}`);
            }
        }

        // Validate traits
        if (settings.traits) {
            if (!Array.isArray(settings.traits)) {
                throw new Error('Traits must be an array');
            }
            if (settings.traits.some(trait => typeof trait !== 'string')) {
                throw new Error('All traits must be strings');
            }
        }

        return true;
    }

    /**
     * Get user's personality settings
     * @param {string} userId - User ID
     * @returns {Promise<Object>} User's personality settings
     */
    async getUserSettings(userId) {
        const db = await getConnection();
        const result = await db.query`
            SELECT personality_preset, personality_settings
            FROM UserPreferences
            WHERE userId = ${userId}
        `;

        if (!result.recordset.length) {
            return this.getPreset('helper'); // Default preset
        }

        const { personality_preset, personality_settings } = result.recordset[0];
        
        if (personality_settings) {
            try {
                const customSettings = JSON.parse(personality_settings);
                return {
                    ...this.getPreset(personality_preset || 'helper'),
                    ...customSettings,
                    source: 'custom'
                };
            } catch (error) {
                console.error('Error parsing personality settings:', error);
            }
        }

        return this.getPreset(personality_preset || 'helper');
    }

    /**
     * Update user's personality settings
     * @param {string} userId - User ID
     * @param {Object} settings - New personality settings
     * @returns {Promise<void>}
     */
    async updateUserSettings(userId, settings) {
        this.validateSettings(settings);

        const db = await getConnection();
        await db.query`
            UPDATE UserPreferences
            SET personality_settings = ${JSON.stringify(settings)},
                updatedAt = GETDATE()
            WHERE userId = ${userId}
        `;
    }

    /**
     * Set user's personality preset
     * @param {string} userId - User ID
     * @param {string} presetName - Name of the preset
     * @returns {Promise<void>}
     */
    async setUserPreset(userId, presetName) {
        if (!this.presets[presetName]) {
            throw new Error(`Invalid preset: ${presetName}`);
        }

        const db = await getConnection();
        await db.query`
            UPDATE UserPreferences
            SET personality_preset = ${presetName},
                personality_settings = NULL,
                updatedAt = GETDATE()
            WHERE userId = ${userId}
        `;
    }

    /**
     * Mix personality traits based on context
     * @param {Object} baseStyle - Base personality style
     * @param {Object} contextStyle - Context-specific style
     * @returns {Object} Mixed personality style
     */
    mixStyles(baseStyle, contextStyle) {
        const mixed = { ...baseStyle };

        // Mix energy levels
        if (contextStyle.energy) {
            mixed.energy = this._mixLevel(baseStyle.energy, contextStyle.energy);
        }

        // Mix humor levels
        if (contextStyle.humor) {
            mixed.humor = this._mixLevel(baseStyle.humor, contextStyle.humor);
        }

        // Mix formality levels
        if (contextStyle.formality) {
            mixed.formality = this._mixLevel(baseStyle.formality, contextStyle.formality);
        }

        // Combine traits, removing duplicates
        if (contextStyle.traits) {
            mixed.traits = [...new Set([...baseStyle.traits, ...contextStyle.traits])];
        }

        return mixed;
    }

    /**
     * Mix two personality levels
     * @private
     */
    _mixLevel(level1, level2) {
        const levelMap = {
            low: 0,
            medium: 1,
            high: 2,
            very_high: 3
        };

        const avg = (levelMap[level1] + levelMap[level2]) / 2;
        const levels = Object.entries(levelMap);
        return levels.reduce((closest, [level, value]) => {
            return Math.abs(value - avg) < Math.abs(levelMap[closest] - avg) ? level : closest;
        }, 'medium');
    }
}

module.exports = new PersonalityPresetManager(); 