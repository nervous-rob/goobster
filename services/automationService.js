const { sql } = require('../azureDb');
const { CronExpressionParser } = require('cron-parser');
const { OpenAI } = require('openai');
const config = require('../config.json');
const { handleChatInteraction } = require('../utils/chatHandler');

const openai = new OpenAI({ apiKey: config.openaiKey });

class AutomationService {
    constructor(client) {
        this.client = client;
        this.checkInterval = 60000; // Check every minute
        this.isRunning = false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.checkAutomations();
        console.log('Automation service started');
    }

    stop() {
        this.isRunning = false;
        console.log('Automation service stopped');
    }

    async checkAutomations() {
        while (this.isRunning) {
            try {
                // Get all enabled automations that are due to run
                const result = await sql.query`
                    SELECT 
                        a.id, a.userId, a.guildId, a.channelId, 
                        a.name, a.promptText, a.schedule, a.metadata
                    FROM automations a
                    WHERE a.isEnabled = 1
                    AND a.nextRun <= GETDATE()
                `;

                for (const automation of result.recordset) {
                    await this.executeAutomation(automation);
                }

                // Wait for next check interval
                await new Promise(resolve => setTimeout(resolve, this.checkInterval));
            } catch (error) {
                console.error('Error in automation check:', error);
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, this.checkInterval));
            }
        }
    }

    async executeAutomation(automation) {
        try {
            // Get the channel
            const channel = await this.client.channels.fetch(automation.channelId);
            if (!channel) {
                console.error(`Channel ${automation.channelId} not found for automation ${automation.name}`);
                return;
            }

            // Get the guild member to check if they're online
            const guild = await this.client.guilds.fetch(automation.guildId);
            const member = await guild.members.fetch(automation.userId);
            
            // Only proceed if the user is online
            if (member.presence?.status === 'offline') {
                console.log(`Skipping automation ${automation.name} as user is offline`);
                await this.updateNextRun(automation);
                return;
            }

            // Create pseudo-interaction for chat handling
            const pseudoInteraction = {
                user: member.user,
                guildId: automation.guildId,
                channel: channel,
                client: this.client,
                deferReply: async () => channel.sendTyping(),
                editReply: async (response) => {
                    if (typeof response === 'string') {
                        return channel.send({
                            content: `🤖 **Automated Message** - "${automation.name}"\n\n${response}`
                        });
                    }
                    return channel.send({
                        content: `🤖 **Automated Message** - "${automation.name}"\n\n${response.content}`,
                        embeds: response.embeds
                    });
                },
                reply: async (response) => {
                    if (typeof response === 'string') {
                        return channel.send({
                            content: `🤖 **Automated Message** - "${automation.name}"\n\n${response}`
                        });
                    }
                    return channel.send({
                        content: `🤖 **Automated Message** - "${automation.name}"\n\n${response.content}`,
                        embeds: response.embeds
                    });
                },
                options: {
                    getString: () => automation.promptText
                }
            };

            // Use the standard chat handler
            await handleChatInteraction(pseudoInteraction);

            // Update last run and next run times
            const now = new Date();
            const interval = CronExpressionParser.parse(automation.schedule);
            const nextRun = interval.next().toDate();

            await sql.query`
                UPDATE automations 
                SET lastRun = ${now}, 
                    nextRun = ${nextRun},
                    updatedAt = GETDATE()
                WHERE id = ${automation.id}
            `;

        } catch (error) {
            console.error(`Error executing automation ${automation.name}:`, error);
            
            // Update next run time even if there was an error
            await this.updateNextRun(automation);
        }
    }

    async updateNextRun(automation) {
        try {
            const interval = CronExpressionParser.parse(automation.schedule);
            const nextRun = interval.next().toDate();

            await sql.query`
                UPDATE automations 
                SET nextRun = ${nextRun},
                    updatedAt = GETDATE()
                WHERE id = ${automation.id}
            `;
        } catch (error) {
            console.error(`Error updating next run for automation ${automation.name}:`, error);
        }
    }
}

module.exports = AutomationService; 