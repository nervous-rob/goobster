const db = require('../db');
const { CronExpressionParser } = require('cron-parser');
const { handleChatInteraction } = require('../utils/chatHandler');
const { isDmScopeId } = require('../utils/dmScope');

class AutomationService {
    constructor(client) {
        this.client = client;
        this.checkInterval = 60000; // Check every minute
        // How long the poll loop waits on one run before moving on. The
        // claim already advanced nextRun, so a straggler finishing in the
        // background can never be double-run - this only protects every
        // OTHER automation from starving behind a wedged turn.
        this.executionWaitMs = 15 * 60 * 1000;
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

    /**
     * All enabled automations whose nextRun has arrived. Durable by
     * construction: the schedule lives in SQLite, so a fresh process picks
     * up exactly where the previous one left off.
     */
    async getDueAutomations() {
        // Timestamps are stored as UTC text, compared against CURRENT_TIMESTAMP
        return await db.all(`
            SELECT
                a.id, a.userId, a.guildId, a.channelId,
                a.name, a.promptText, a.schedule, a.metadata
            FROM automations a
            WHERE a.isEnabled = 1
            AND a.nextRun <= CURRENT_TIMESTAMP
        `);
    }

    async checkAutomations() {
        while (this.isRunning) {
            try {
                for (const automation of await this.getDueAutomations()) {
                    await this.executeWithTimeout(automation);
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

    /**
     * Run one automation, but never let the poll loop wait on it longer
     * than executionWaitMs. Timing out the WAIT is safe: the fire was
     * already claimed (nextRun advanced), so the still-running turn cannot
     * be picked up again - the loop just stops being hostage to it.
     */
    async executeWithTimeout(automation) {
        let timer = null;
        const timedWait = new Promise(resolve => {
            timer = setTimeout(() => {
                console.warn(
                    `Automation "${automation.name}" is still running after `
                    + `${Math.round(this.executionWaitMs / 60000)} minute(s) - `
                    + 'the scheduler moves on; the run continues in the background.'
                );
                resolve();
            }, this.executionWaitMs);
            timer.unref?.();
        });
        try {
            await Promise.race([this.executeAutomation(automation), timedWait]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Atomically claim a due automation by advancing nextRun BEFORE the run.
     * The UPDATE only matches while the row is still enabled and due, so
     * each scheduled fire is claimed at most once: a restart (or a replayed
     * due list) mid-execution never double-runs it, and a failed run waits
     * for its next scheduled fire instead of retrying every poll.
     *
     * Crons are evaluated in UTC - the contract every creation surface
     * documents - never the server's local timezone. A schedule that fails
     * to parse can never fire: the row is disabled (instead of being
     * rescanned every minute forever) and the owner is told.
     * @param {Object} automation - row with id + schedule
     * @returns {boolean} true when this caller won the claim
     */
    async claimDueRun(automation) {
        let nextRun;
        try {
            nextRun = CronExpressionParser.parse(automation.schedule, { tz: 'UTC' }).next().toDate();
        } catch (error) {
            console.error(`Automation "${automation.name}" has an unparseable schedule ("${automation.schedule}") - disabling it:`, error);
            await db.run(
                `UPDATE automations
                 SET isEnabled = 0, nextRun = NULL, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { id: automation.id }
            );
            this._notifyChannel(
                automation,
                `⚠️ Automation "${automation.name}" has been paused: its schedule (\`${automation.schedule}\`) `
                + 'is not a valid cron expression, so it can never fire. Recreate it (or resume it with a fixed schedule).'
            );
            return false;
        }
        try {
            const result = await db.run(
                `UPDATE automations
                 SET nextRun = @nextRun,
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id AND isEnabled = 1 AND nextRun <= CURRENT_TIMESTAMP`,
                { nextRun, id: automation.id }
            );
            return result.changes > 0;
        } catch (error) {
            console.error(`Error claiming automation ${automation.name}:`, error);
            return false;
        }
    }

    /**
     * Record a completed run (nextRun was already advanced by the claim).
     * A success also ends any failure streak, re-arming the one-per-streak
     * failure notification.
     */
    async markRan(automationId) {
        await db.run(
            `UPDATE automations SET lastRun = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = @id`,
            { id: automationId }
        );
        // Best-effort bookkeeping: clearing the failure-streak flag must never
        // turn a SUCCESSFUL run into a reported failure.
        try {
            const row = await db.get('SELECT metadata FROM automations WHERE id = @id', { id: automationId });
            const meta = this._parseMetadata(row?.metadata);
            if (meta.failureNotified) {
                delete meta.failureNotified;
                await db.run(
                    'UPDATE automations SET metadata = @metadata WHERE id = @id',
                    { id: automationId, metadata: JSON.stringify(meta) }
                );
            }
        } catch (error) {
            console.error(`Could not clear the failure flag for automation ${automationId}:`, error.message);
        }
    }

    /** Metadata is owner-written JSON; a corrupt blob must never break a run. */
    _parseMetadata(metadata) {
        try {
            const parsed = JSON.parse(metadata || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    /** Best-effort message to the automation's delivery channel. */
    _notifyChannel(automation, content) {
        Promise.resolve()
            .then(() => this.client.channels.fetch(automation.channelId))
            .then(channel => channel?.send?.({ content, allowedMentions: { users: [], roles: [] } }))
            .catch(error => console.error(`Could not notify channel for automation ${automation.name}:`, error.message));
    }

    /**
     * Tell the owner a run failed - once per failure streak, so an
     * automation broken for a week doesn't post the same warning every
     * fire, but a fresh breakage is never silent. markRan (success)
     * clears the flag and re-arms the notification.
     */
    async _notifyRunFailure(automation, error) {
        const meta = this._parseMetadata(automation.metadata);
        if (meta.failureNotified) return;
        meta.failureNotified = true;
        await db.run(
            'UPDATE automations SET metadata = @metadata WHERE id = @id',
            { id: automation.id, metadata: JSON.stringify(meta) }
        );
        this._notifyChannel(
            automation,
            `⚠️ Automation "${automation.name}" failed this run: ${String(error?.message || error).slice(0, 300)}\n`
            + 'It stays scheduled and will try again at its next fire. '
            + 'I\'ll stay quiet about further failures until it succeeds again.'
        );
    }

    async executeAutomation(automation) {
        // Claim first: nextRun advances before anything runs, so a crash or
        // restart mid-execution can never fire the same scheduled run twice.
        if (!await this.claimDueRun(automation)) return;

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
                await this.markRan(automation.id);
                return;
            }

            // Monthly Server Wrapped, likewise handled directly
            if (automation.promptText === '__SERVER_WRAPPED__') {
                await this.executeWrapped(automation, channel);
                await this.markRan(automation.id);
                return;
            }

            // The Daily Ballistic Goblin Wheel Dedication (also direct - the
            // Wheel bows to no user-online check)
            if (automation.promptText === '__GOBLIN_WHEEL__') {
                await this.executeWheel(automation, channel);
                await this.markRan(automation.id);
                return;
            }

            // DM-scope automations (created from the web portal's Tasks
            // pane) deliver to the user's DM channel and run through the
            // same chat pipeline with a DM-shaped pseudo-interaction.
            if (isDmScopeId(automation.guildId)) {
                await this.executeDmAutomation(automation, channel);
                await this.markRan(automation.id);
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

            await this.markRan(automation.id);

        } catch (error) {
            console.error(`Error executing automation ${automation.name}:`, error);
            // nextRun was already advanced by the claim, so a failing
            // automation simply waits for its next scheduled fire - but the
            // owner hears about the first failure of a streak instead of
            // getting silence all night.
            await this._notifyRunFailure(automation, error);
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
            sendFullResponse: async (text) => await deliver(text),
            options: {
                getString: () => automation.promptText
            }
        };

        await handleChatInteraction(pseudoInteraction);
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
    }

    async executeWheel(automation, channel) {
        const wheelService = require('./exchange/wheelService');
        const economyService = require('./economyService');
        const { buildWheelEmbed, resolveNames } = require('./exchange/wheelPresenter');

        try {
            const result = await wheelService.spin({ guildId: automation.guildId });
            const { currencyName } = await economyService.getSettings(automation.guildId);
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
    }
}

module.exports = AutomationService;
