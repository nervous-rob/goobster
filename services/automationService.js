const db = require('../db');
const { CronExpressionParser } = require('cron-parser');
const { handleChatInteraction } = require('../utils/chatHandler');
const { isDmScopeId } = require('../utils/dmScope');

class AutomationService {
    constructor(client) {
        this.client = client;
        this.checkInterval = 60000; // Check every minute
        this.isRunning = false;
        this.timer = null;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.checkAutomations().catch(err => {
            console.error('Error starting automation service:', err);
            this.isRunning = false;
        });
        console.log('Automation service started');
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        console.log('Automation service stopped');
    }

    async checkAutomations() {
        while (this.isRunning) {
            try {
                // Get all enabled automations that are due to run
                // (timestamps are stored as UTC text, compared against CURRENT_TIMESTAMP)
                const dueAutomations = db.all(`
                    SELECT
                        a.id, a.userId, a.guildId, a.channelId,
                        a.name, a.promptText, a.schedule, a.metadata
                    FROM automations a
                    WHERE a.isEnabled = 1
                    AND a.nextRun <= CURRENT_TIMESTAMP
                `);

                for (const automation of dueAutomations) {
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

            // Channel digests are handled directly (no chat pipeline, no
            // online check - a digest is useful regardless of user presence)
            if (automation.promptText === '__CHANNEL_DIGEST__') {
                await this.executeDigest(automation, channel);
                return;
            }

            // Monthly Server Wrapped, likewise handled directly
            if (automation.promptText === '__SERVER_WRAPPED__') {
                await this.executeWrapped(automation, channel);
                return;
            }

            // The Daily Ballistic Goblin Wheel Dedication (also direct - the
            // Wheel bows to no user-online check)
            if (automation.promptText === '__GOBLIN_WHEEL__') {
                await this.executeWheel(automation, channel);
                return;
            }

            // DM-scope automations (created from the web portal's Tasks
            // pane) deliver to the user's DM channel and run through the
            // same chat pipeline with a DM-shaped pseudo-interaction.
            if (isDmScopeId(automation.guildId)) {
                await this.executeDmAutomation(automation, channel);
                return;
            }

            // Resolve the owner so tools run with the same guild, member, and
            // account context as a normal chat turn. Automations are
            // unattended tasks, so presence does not gate execution.
            const guild = await this.client.guilds.fetch(automation.guildId);
            const member = await guild.members.fetch(automation.userId);

            // Enter the standard chat pipeline. It offers every registered
            // tool to the model and runs multi-step actions through the same
            // bounded agent loop used by ordinary text chat.
            const pseudoInteraction = {
                user: member.user,
                member,
                guild,
                guildId: automation.guildId,
                channel,
                channelId: channel.id,
                client: this.client,
                content: automation.promptText,
                isAutomation: true,
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

            db.run(
                `UPDATE automations
                 SET lastRun = @now,
                     nextRun = @nextRun,
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { now, nextRun, id: automation.id }
            );

        } catch (error) {
            console.error(`Error executing automation ${automation.name}:`, error);

            // Update next run time even if there was an error
            await this.updateNextRun(automation);
        }
    }

    /**
     * Run a DM-scope automation: an unattended agent turn in the owner's
     * DM conversation (guild null, so the pipeline resolves the user's
     * "dm:<userId>" scope - shared memory/facts/settings with their DMs
     * and web chats), delivered to their Discord DM channel.
     */
    async executeDmAutomation(automation, channel) {
        const user = await this.client.users.fetch(automation.userId);
        const { chunkMessage } = require('../utils');

        const deliver = async (response) => {
            const content = typeof response === 'string' ? response : response?.content;
            if (!content) return;
            // The banner rides the first chunk; DMs keep Discord's 2000-char cap
            const chunks = chunkMessage(`🤖 **Scheduled Task** - "${automation.name}"\n\n${content}`);
            let sent;
            for (const [index, chunk] of chunks.entries()) {
                sent = await channel.send({
                    content: chunk,
                    embeds: index === chunks.length - 1 && typeof response === 'object' ? response.embeds : undefined
                });
            }
            return sent;
        };

        const pseudoInteraction = {
            user,
            member: null,
            guild: null,
            guildId: null,
            channel,
            channelId: channel.id,
            client: this.client,
            content: automation.promptText,
            isAutomation: true,
            sourceDescription:
                `You are executing "${automation.name}", a scheduled task ${user.username} set up in advance. ` +
                `This is a private one-on-one conversation delivered to their Discord DMs - address them directly ` +
                `and carry out the task now.`,
            deferReply: async () => channel.sendTyping(),
            editReply: deliver,
            reply: deliver,
            // The responder prefers this capability over raw channel sends,
            // so the whole reply arrives banner-first (and chunked).
            sendFullResponse: (text) => deliver(text),
            options: {
                getString: () => automation.promptText
            }
        };

        await handleChatInteraction(pseudoInteraction);

        await this.updateNextRun(automation);
        db.run(
            `UPDATE automations SET lastRun = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
            { id: automation.id }
        );
    }

    async executeDigest(automation, channel) {
        const { generateDigest } = require('../utils/channelDigest');
        const { EmbedBuilder } = require('discord.js');

        let hours = 24;
        try {
            hours = JSON.parse(automation.metadata || '{}').digest?.hours || 24;
        } catch { /* default window */ }

        const digest = await generateDigest(channel, hours, {
            usageContext: { guildId: automation.guildId }
        });

        if (digest) {
            const embed = new EmbedBuilder()
                .setColor('#43B581')
                .setTitle(`📰 #${channel.name} - last ${hours}h`)
                .setDescription(digest.slice(0, 4000))
                .setTimestamp();
            await channel.send({ embeds: [embed] });
        } else {
            console.log(`Digest automation "${automation.name}" skipped: not enough activity`);
        }

        await this.updateNextRun(automation);
        db.run(
            `UPDATE automations SET lastRun = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
            { id: automation.id }
        );
    }

    async executeWrapped(automation, channel) {
        const wrappedService = require('./wrappedService');
        const { buildWrappedMessage } = require('../utils/serverWrapped');

        // Runs on the 1st, wrapping the month that just ended
        const period = wrappedService.resolvePeriod('last-month');
        const message = await buildWrappedMessage({
            guild: channel.guild,
            period,
            usageContext: { guildId: automation.guildId }
        });

        await channel.send(message);

        await this.updateNextRun(automation);
        db.run(
            `UPDATE automations SET lastRun = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
            { id: automation.id }
        );
    }

    async executeWheel(automation, channel) {
        const wheelService = require('./exchange/wheelService');
        const economyService = require('./economyService');
        const { buildWheelEmbed, resolveNames } = require('../commands/economy/wheel');

        try {
            const result = await wheelService.spin({ guildId: automation.guildId });
            const { currencyName } = economyService.getSettings(automation.guildId);
            const names = await resolveNames(channel.guild, result.deployments.map(d => d.userId));
            await channel.send({
                content: '🎡 **ALL HAIL THE WHEEL!** The daily dedication, at the open:',
                embeds: [buildWheelEmbed(result, currencyName, names)]
            });
        } catch (error) {
            // The ritual failing (options off, feed down) is announced, not
            // swallowed - the congregation deserves to know
            await channel.send(`🎡 The Wheel could not spin today: ${error.message}`);
        }

        await this.updateNextRun(automation);
        db.run(
            `UPDATE automations SET lastRun = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
            { id: automation.id }
        );
    }

    async updateNextRun(automation) {
        try {
            const interval = CronExpressionParser.parse(automation.schedule);
            const nextRun = interval.next().toDate();

            db.run(
                `UPDATE automations
                 SET nextRun = @nextRun,
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { nextRun, id: automation.id }
            );
        } catch (error) {
            console.error(`Error updating next run for automation ${automation.name}:`, error);
        }
    }
}

module.exports = AutomationService;
