/**
 * Response Formatter Service
 * Handles formatting responses for Discord and other platforms
 */

const logger = require('./logger');
const path = require('path');

class ResponseFormattingService {
    constructor() {
        this.defaultSettings = {
            maxFieldLength: 1024,
            maxDescriptionLength: 4096,
            maxTotalLength: 6000,
            defaultColor: 0x0099ff,
            defaultEmptyValue: 'Not available',
            errorColors: {
                timeout: 0xFFA500,  // Orange for timeouts
                critical: 0xFF0000, // Red for critical errors
                warning: 0xFFFF00   // Yellow for warnings
            },
            retryMessages: {
                timeout: 'The adventure system is experiencing some delays. Please try again in a few moments.',
                database: 'Unable to connect to the adventure database. Please try again shortly.',
                generic: 'Something went wrong. Please try again.'
            }
        };
    }

    /**
     * Format adventure start response
     * @param {Object} options Format options
     * @returns {Object} Formatted response
     */
    formatAdventureStart({ adventure, party = null, images = {}, initialScene }) {
        try {
            this._validateRequiredFields({ adventure, initialScene }, 'formatAdventureStart');

            const mainEmbed = {
                color: this.defaultSettings.defaultColor,
                title: '🎮 Adventure Begins!',
                description: this._truncateText(adventure.theme || 'A new adventure begins...'),
                fields: [
                    {
                        name: 'Setting',
                        value: this._truncateText(adventure.setting?.geography || adventure.setting?.description || this.defaultSettings.defaultEmptyValue),
                    },
                    {
                        name: 'Plot',
                        value: this._truncateText(adventure.plotSummary?.mainObjective || adventure.plotSummary || this.defaultSettings.defaultEmptyValue),
                    },
                    {
                        name: 'Initial State',
                        value: this._formatInitialState(initialScene),
                    },
                    {
                        name: 'Objectives',
                        value: this._truncateText(adventure.winCondition?.primary || adventure.winCondition?.requirements?.join('\n') || this.defaultSettings.defaultEmptyValue),
                    },
                    {
                        name: '\u200B',
                        value: '\u200B',
                    },
                    {
                        name: 'Initial Scene',
                        value: this._truncateText(initialScene.description),
                    },
                    {
                        name: 'Available Choices',
                        value: this._formatChoices(initialScene.choices),
                    },
                ],
                footer: {
                    text: 'Use /makedecision to choose your action',
                },
            };

            // Add images if available
            if (images.location) {
                mainEmbed.image = { url: `attachment://${path.basename(images.location)}` };
            }
            if (images.scenes?.[0]) {
                mainEmbed.thumbnail = { url: `attachment://${path.basename(images.scenes[0])}` };
            }

            // Create character portrait embeds only if party exists
            const characterEmbeds = party ? (images.characters || []).map(char => ({
                color: this.defaultSettings.defaultColor,
                title: `${char.name}'s Portrait`,
                description: party.members.find(m => m.adventurerName === char.name)?.backstory || '',
                image: { url: `attachment://${path.basename(char.url)}` },
            })) : [];

            return {
                embeds: [mainEmbed, ...characterEmbeds],
                files: this._formatImageFiles(images),
            };
        } catch (error) {
            logger.error('Failed to format adventure start response', { error });
            return this.formatError(error);
        }
    }

    /**
     * Format decision response
     * @param {Object} options Format options
     * @returns {Object} Formatted response
     */
    formatDecisionResponse({ decision, consequences, nextScene, adventurerName }) {
        try {
            this._validateRequiredFields({ decision, consequences, nextScene, adventurerName }, 'formatDecisionResponse');

            return {
                color: this.defaultSettings.defaultColor,
                title: `Decision for ${adventurerName}`,
                description: `Chose: ${decision.text}`,
                fields: [
                    {
                        name: 'What Happened',
                        value: this._truncateText(consequences.narration || consequences.immediate?.[0] || this.defaultSettings.defaultEmptyValue),
                    },
                    {
                        name: 'Additional Details',
                        value: this._truncateText(consequences.details || consequences.longTerm?.[0] || this.defaultSettings.defaultEmptyValue),
                    },
                    {
                        name: 'Objective Progress',
                        value: this._formatObjectiveProgress(consequences.objectiveProgress),
                    },
                    {
                        name: 'Resources Used',
                        value: this._truncateText(
                            consequences.objectiveProgress?.resourcesUsed?.join(', ') || this.defaultSettings.defaultEmptyValue
                        ),
                    },
                    {
                        name: 'Game State',
                        value: this._formatGameState(consequences.gameState),
                    },
                    {
                        name: '\u200B',
                        value: '\u200B',
                    },
                    {
                        name: 'Next Scene',
                        value: this._truncateText(nextScene.description),
                    },
                    {
                        name: 'Available Choices',
                        value: this._formatChoices(nextScene.choices),
                    },
                ],
            };
        } catch (error) {
            logger.error('Failed to format decision response', { error });
            return this.formatError(error);
        }
    }

    /**
     * Format party status response
     * @param {Object} options Format options
     * @returns {Object} Formatted response
     */
    formatPartyStatus({ party, state, section = 'overview' }) {
        try {
            const embed = {
                color: this.defaultSettings.defaultColor,
                title: '🎭 Party Status',
                description: party.adventureId ? 
                    this._truncateText(`Current Adventure: ${state.theme}`, 4096) : 
                    'No active adventure',
                fields: [],
            };

            // Add section-specific fields
            switch(section) {
                case 'overview':
                    this._addOverviewFields(embed, party, state);
                    break;
                case 'story':
                    this._addStoryFields(embed, state);
                    break;
                case 'state':
                    this._addStateFields(embed, state);
                    break;
                case 'members':
                    this._addMemberFields(embed, party);
                    break;
                case 'events':
                    this._addEventFields(embed, state);
                    break;
            }

            return { embeds: [embed] };
        } catch (error) {
            logger.error('Failed to format party status response', { error });
            throw error;
        }
    }

    /**
     * Format error response with enhanced error handling
     * @param {Error} error Error object
     * @param {boolean} isDevelopment Whether in development mode
     * @returns {Object} Formatted response
     */
    formatError(error, isDevelopment = false) {
        // Determine error type and format appropriate response
        const errorType = this._getErrorType(error);
        const embed = {
            color: this._getErrorColor(errorType),
            title: this._getErrorTitle(errorType),
            description: this._getErrorMessage(error, errorType),
            fields: []
        };

        // Add user-friendly action suggestion
        embed.fields.push({
            name: 'What to do',
            value: this._getErrorAction(errorType)
        });

        // Add technical details in development mode
        if (isDevelopment) {
            embed.fields.push({
                name: 'Technical Details',
                value: this._formatTechnicalDetails(error)
            });
        }

        // Add error code if available
        if (error.code) {
            embed.fields.push({
                name: 'Error Code',
                value: error.code
            });
        }

        return { embeds: [embed] };
    }

    /**
     * Determine error type from error object
     * @param {Error} error Error object
     * @returns {string} Error type
     * @private
     */
    _getErrorType(error) {
        if (error.code === 'ETIMEOUT') return 'timeout';
        if (error.code?.startsWith('E')) return 'database';
        if (error.name === 'ValidationError') return 'validation';
        return 'generic';
    }

    /**
     * Get appropriate color for error type
     * @param {string} errorType Error type
     * @returns {number} Color code
     * @private
     */
    _getErrorColor(errorType) {
        return this.defaultSettings.errorColors[errorType] || this.defaultSettings.errorColors.critical;
    }

    /**
     * Get error title based on type
     * @param {string} errorType Error type
     * @returns {string} Error title
     * @private
     */
    _getErrorTitle(errorType) {
        const titles = {
            timeout: '⏳ Connection Timeout',
            database: '🔌 Database Connection Issue',
            validation: '⚠️ Invalid Input',
            generic: '❌ Error'
        };
        return titles[errorType] || titles.generic;
    }

    /**
     * Get user-friendly error message
     * @param {Error} error Error object
     * @param {string} errorType Error type
     * @returns {string} Error message
     * @private
     */
    _getErrorMessage(error, errorType) {
        return this.defaultSettings.retryMessages[errorType] || error.message || this.defaultSettings.retryMessages.generic;
    }

    /**
     * Get action suggestion based on error type
     * @param {string} errorType Error type
     * @returns {string} Action suggestion
     * @private
     */
    _getErrorAction(errorType) {
        const actions = {
            timeout: '• Wait a few moments\n• Try your command again\n• If the issue persists, the adventure system might be experiencing high load',
            database: '• Try again in a few moments\n• If the issue continues, the adventure system might be undergoing maintenance',
            validation: '• Check your input\n• Make sure all required fields are filled\n• Try again with valid input',
            generic: '• Try your command again\n• If the issue persists, contact support'
        };
        return actions[errorType] || actions.generic;
    }

    /**
     * Format technical error details
     * @param {Error} error Error object
     * @returns {string} Formatted error details
     * @private
     */
    _formatTechnicalDetails(error) {
        const details = [];
        if (error.message) details.push(`Message: ${error.message}`);
        if (error.code) details.push(`Code: ${error.code}`);
        if (error.stack) details.push(`Stack: ${error.stack.split('\n')[0]}`);
        return this._truncateText(details.join('\n'));
    }

    /**
     * Format party creation response
     * @param {Object} options Format options
     * @param {Object} options.party The created party object
     * @param {Object} options.leader The party leader information
     * @returns {Object} Formatted response
     */
    formatPartyCreation({ party, leader }) {
        try {
            const embed = {
                color: this.defaultSettings.defaultColor,
                title: '🎭 New Adventure Party Created!',
                description: 'A new party has been formed and awaits its first adventure.',
                fields: [
                    {
                        name: 'Party Leader',
                        value: this._truncateText(leader.adventurerName),
                        inline: true
                    },
                    {
                        name: 'Party Size',
                        value: `1/${party.settings.maxSize || 4}`,
                        inline: true
                    },
                    {
                        name: 'Status',
                        value: party.status || 'Forming',
                        inline: true
                    }
                ]
            };

            // Add backstory if provided
            if (leader.backstory) {
                embed.fields.push({
                    name: 'Leader\'s Backstory',
                    value: this._truncateText(leader.backstory)
                });
            }

            // Add instructions for next steps
            embed.fields.push({
                name: 'Next Steps',
                value: 'Other players can join using `/joinparty`\nStart your adventure with `/startadventure` when ready!'
            });

            return { embeds: [embed] };
        } catch (error) {
            logger.error('Failed to format party creation response', { error });
            throw error;
        }
    }

    // Private helper methods
    _validateRequiredFields(fields, methodName) {
        const missing = Object.entries(fields)
            .filter(([_, value]) => !value)
            .map(([key]) => key);

        if (missing.length > 0) {
            throw new Error(`Missing required fields for ${methodName}: ${missing.join(', ')}`);
        }
    }

    _truncateText(text, maxLength = this.defaultSettings.maxFieldLength) {
        if (!text) return this.defaultSettings.defaultEmptyValue;
        const str = String(text);
        return str.length > maxLength ? `${str.slice(0, maxLength - 3)}...` : str;
    }

    _formatChoices(choices = []) {
        if (!choices?.length) return this.defaultSettings.defaultEmptyValue;
        return choices.map((choice, index) => 
            `${index + 1}. ${this._truncateText(choice.text, 200)}`
        ).join('\n');
    }

    _formatInitialState(scene) {
        if (!scene) return this.defaultSettings.defaultEmptyValue;
        
        const location = scene.location || {};
        return this._truncateText([
            `Location: ${location.place || 'Unknown'}`,
            `Weather: ${location.weather || 'Clear'}`,
            `Time: ${location.timeOfDay || 'Morning'}`
        ].join('\n'));
    }

    _formatObjectiveProgress(progress = {}) {
        if (!progress) return this.defaultSettings.defaultEmptyValue;
        return this._truncateText(
            Object.entries(progress)
                .filter(([key]) => key !== 'resourcesUsed')
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n') || this.defaultSettings.defaultEmptyValue
        );
    }

    _formatGameState(gameState = {}) {
        if (!gameState) return this.defaultSettings.defaultEmptyValue;
        return this._truncateText(
            Object.entries(gameState)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n') || this.defaultSettings.defaultEmptyValue
        );
    }

    _formatImageFiles(images = {}) {
        const files = [];
        
        if (images.location) {
            files.push({ 
                attachment: images.location, 
                name: path.basename(images.location) 
            });
        }
        
        if (images.scenes?.[0]) {
            files.push({ 
                attachment: images.scenes[0], 
                name: path.basename(images.scenes[0]) 
            });
        }
        
        if (images.characters?.length) {
            files.push(...images.characters.map(char => ({
                attachment: char.url,
                name: path.basename(char.url),
            })));
        }
        
        return files;
    }

    _addOverviewFields(embed, party, state) {
        embed.fields.push(
            {
                name: 'Party Status',
                value: `Status: ${this._formatPartyStatus(party)}\nMembers: ${party.members.length}/${party.settings.maxSize}`,
                inline: true,
            },
            {
                name: 'Current Location',
                value: state.currentScene ? 
                    `${state.currentScene.location}\n${state.currentScene.description}` : 
                    'Not in a scene',
            }
        );
    }

    _addStoryFields(embed, state) {
        if (state.plotSummary) embed.fields.push({ name: 'Plot Summary', value: this._truncateText(state.plotSummary) });
        if (state.plotPoints) embed.fields.push({ name: 'Plot Points', value: this._truncateText(state.plotPoints.join('\n')) });
        if (state.objectives) embed.fields.push({ name: 'Objectives', value: this._truncateText(state.objectives.join('\n')) });
    }

    _addStateFields(embed, state) {
        if (state.currentScene) {
            embed.fields.push(
                {
                    name: 'Current Scene',
                    value: this._truncateText(state.currentScene.description),
                },
                {
                    name: 'Available Choices',
                    value: this._formatChoices(state.currentScene.choices),
                }
            );
        }
    }

    _addMemberFields(embed, party) {
        party.members.forEach(member => {
            embed.fields.push({
                name: `${this._getMemberIcon(member.status)} ${member.adventurerName}`,
                value: this._formatMemberDetails(member),
            });
        });
    }

    _addEventFields(embed, state) {
        if (state.eventHistory?.length) {
            embed.fields.push({
                name: 'Recent Events',
                value: this._truncateText(
                    state.eventHistory
                        .slice(0, 5)
                        .map(event => `• ${event.description}`)
                        .join('\n')
                ),
            });
        }
    }

    _getMemberIcon(status) {
        switch(status) {
            case 'ACTIVE': return '⚔️';
            case 'RECRUITING': return '📢';
            case 'COMPLETED': return '🏆';
            case 'DISBANDED': return '💔';
            default: return '❓';
        }
    }

    _formatPartyStatus(party) {
        const statusIcons = {
            'ACTIVE': '⚔️',
            'RECRUITING': '📢',
            'COMPLETED': '🏆',
            'DISBANDED': '💔'
        };

        return `${statusIcons[party.status] || '❓'} ${party.status}`;
    }

    _formatMemberDetails(member) {
        const details = [];
        if (member.role) details.push(`Role: ${member.role}`);
        if (member.status) details.push(`Status: ${member.status}`);
        if (member.health) details.push(`Health: ${member.health}/100`);
        if (member.inventory?.length) details.push(`Inventory: ${member.inventory.join(', ')}`);
        return this._truncateText(details.join('\n'));
    }
}

module.exports = new ResponseFormattingService(); 