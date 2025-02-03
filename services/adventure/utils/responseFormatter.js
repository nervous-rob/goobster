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
        };
    }

    /**
     * Format adventure start response
     * @param {Object} options Format options
     * @returns {Object} Formatted response
     */
    formatAdventureStart({ adventure, party, images, initialScene }) {
        try {
            const mainEmbed = {
                color: this.defaultSettings.defaultColor,
                title: '🎮 Adventure Begins!',
                description: this._truncateText(adventure.theme),
                fields: [
                    {
                        name: 'Setting',
                        value: this._truncateText(adventure.setting.geography),
                    },
                    {
                        name: 'Plot',
                        value: this._truncateText(adventure.plotSummary),
                    },
                    {
                        name: 'Initial State',
                        value: this._formatInitialState(initialScene),
                    },
                    {
                        name: 'Objectives',
                        value: this._truncateText(adventure.winCondition.primary),
                    },
                    {
                        name: '\u200B',
                        value: '\u200B',
                    },
                    {
                        name: `${party.members[0].adventurerName}'s Turn`,
                        value: this._truncateText(initialScene.description),
                    },
                    {
                        name: 'Available Choices',
                        value: this._formatChoices(initialScene.choices),
                    },
                ],
                image: images.location ? { url: `attachment://${path.basename(images.location)}` } : null,
                thumbnail: images.scenes[0] ? { url: `attachment://${path.basename(images.scenes[0])}` } : null,
                footer: {
                    text: 'Use /makedecision to choose your action',
                },
            };

            // Create character portrait embeds
            const characterEmbeds = images.characters.map(char => ({
                color: this.defaultSettings.defaultColor,
                title: `${char.name}'s Portrait`,
                description: party.members.find(m => m.adventurerName === char.name)?.backstory || '',
                image: { url: `attachment://${path.basename(char.url)}` },
            }));

            return {
                embeds: [mainEmbed, ...characterEmbeds],
                files: this._formatImageFiles(images),
            };
        } catch (error) {
            logger.error('Failed to format adventure start response', { error });
            throw error;
        }
    }

    /**
     * Format decision response
     * @param {Object} options Format options
     * @returns {Object} Formatted response
     */
    formatDecisionResponse({ decision, consequences, nextScene, adventurerName }) {
        try {
            return {
                color: this.defaultSettings.defaultColor,
                title: `Decision for ${adventurerName}`,
                description: `Chose: ${decision.text}`,
                fields: [
                    {
                        name: 'What Happened',
                        value: this._truncateText(consequences.narration),
                    },
                    {
                        name: 'Additional Details',
                        value: this._truncateText(consequences.details || 'No additional details.'),
                    },
                    {
                        name: 'Objective Progress',
                        value: this._formatObjectiveProgress(consequences.objectiveProgress),
                    },
                    {
                        name: 'Resources Used',
                        value: this._truncateText(
                            consequences.objectiveProgress.resourcesUsed.join(', ') || 'No resources used'
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
            throw error;
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
     * Format error response
     * @param {Error} error Error object
     * @param {boolean} isDevelopment Whether in development mode
     * @returns {Object} Formatted response
     */
    formatError(error, isDevelopment = false) {
        const embed = {
            color: 0xFF0000,
            title: 'Error',
            description: error.message || 'An error occurred',
            fields: [],
        };

        if (isDevelopment) {
            embed.fields.push({
                name: 'Debug Info',
                value: `Error: ${error.message}\nStack: ${error.stack}`,
            });
        }

        return { embeds: [embed] };
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
    _truncateText(text, maxLength = this.defaultSettings.maxFieldLength) {
        if (!text) return 'No information available.';
        if (text.length <= maxLength) return text;
        return text.slice(0, maxLength - 3) + '...';
    }

    _formatChoices(choices) {
        return choices.map((choice, index) => 
            `${index + 1}. ${choice}`
        ).join('\n');
    }

    _formatInitialState(scene) {
        return `Location: ${scene.location}\nTime: ${scene.timeOfDay}\nWeather: ${scene.weather}\nVisibility: ${scene.visibility}`;
    }

    _formatObjectiveProgress(progress) {
        return this._truncateText(
            `Completed: ${progress.completedObjectives.join(', ') || 'None'}\n` +
            `Failed: ${progress.failedObjectives.join(', ') || 'None'}\n` +
            `Remaining: ${progress.remainingObjectives.join(', ') || 'None'}\n` +
            `New Obstacles: ${progress.newObstacles.join(', ') || 'None'}\n` +
            `Progress: ${progress.distanceFromWinCondition}`
        );
    }

    _formatGameState(gameState) {
        return this._truncateText(
            `Party Status: ${gameState.partyViability}\n` +
            `Objective Status: ${gameState.objectiveViability}\n` +
            (gameState.isEnding ? `Ending: ${gameState.endType}\n${gameState.endReason}` : 'Adventure Continues')
        );
    }

    _formatImageFiles(images) {
        return [
            ...(images.location ? [{ attachment: images.location, name: path.basename(images.location) }] : []),
            ...(images.scenes[0] ? [{ attachment: images.scenes[0], name: path.basename(images.scenes[0]) }] : []),
            ...images.characters.map(char => ({
                attachment: char.url,
                name: path.basename(char.url),
            })),
        ];
    }

    _addOverviewFields(embed, party, state) {
        embed.fields.push(
            {
                name: 'Party Status',
                value: `Status: ${party.status}\nMembers: ${party.members.length}/${party.settings.maxSize}`,
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
            case 'active': return '⚔️';
            case 'injured': return '🤕';
            case 'incapacitated': return '💫';
            case 'dead': return '☠️';
            default: return '❓';
        }
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