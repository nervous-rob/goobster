const { SlashCommandBuilder } = require('discord.js');
const db = require('@goobster/core/db');
const { CronExpressionParser } = require('cron-parser');
const { cronFromNaturalLanguage } = require('@goobster/core/utils/cronFromNaturalLanguage');
const { getConversationScopeId } = require('@goobster/core/utils/dmScope');

/**
 * Format a stored UTC timestamp ('YYYY-MM-DD HH:MM:SS') for display.
 * @param {string|null} value
 * @returns {string}
 */
function formatTimestamp(value) {
    if (!value) return 'Never';
    const date = new Date(`${value.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

async function convertToCron(schedule) {
    return cronFromNaturalLanguage(schedule);
}

// Let's manually handle some common schedule patterns to ensure they work
function getManualCron(scheduleText) {
    const lowerSchedule = scheduleText.toLowerCase().trim();
    
    // Common patterns that might need special handling
    if (lowerSchedule === 'every 30 minutes' || lowerSchedule === 'every thirty minutes' || lowerSchedule === 'each half hour') {
        return '*/30 * * * *';
    }
    if (lowerSchedule === 'hourly' || lowerSchedule === 'every hour') {
        return '0 * * * *';
    }
    if (lowerSchedule === 'daily' || lowerSchedule === 'every day') {
        return '0 0 * * *';
    }
    if (lowerSchedule === 'weekly' || lowerSchedule === 'every week') {
        return '0 0 * * 0';
    }
    if (lowerSchedule === 'monthly' || lowerSchedule === 'every month') {
        return '0 0 1 * *';
    }
    
    // No match found, return null to proceed with AI-based conversion
    return null;
}

module.exports = {
    // DM parity with the web portal's Tasks pane: in a DM the rows live in
    // the user's dm:<userId> scope and deliver to the DM channel - the same
    // rows the portal lists, creates, and cancels.
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('automation')
        .setDescription('Manage scheduled AI tasks and messages')
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Create a scheduled AI task')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('Name for this automation')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('prompt')
                        .setDescription('Task to run; actionable requests can use registered tools')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('schedule')
                        .setDescription('When to trigger (e.g., "every day at 9am" or "every Monday at 3:30pm")')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List your automated message triggers'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('toggle')
                .setDescription('Enable or disable an automation')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('Name of the automation to toggle')
                        .setRequired(true))
                .addBooleanOption(option =>
                    option.setName('enabled')
                        .setDescription('Whether to enable or disable the automation')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete an automation')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('Name of the automation to delete')
                        .setRequired(true))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'create':
                await handleCreate(interaction);
                break;
            case 'list':
                await handleList(interaction);
                break;
            case 'toggle':
                await handleToggle(interaction);
                break;
            case 'delete':
                await handleDelete(interaction);
                break;
        }
    }
};

async function handleCreate(interaction) {
    const name = interaction.options.getString('name');
    const promptText = interaction.options.getString('prompt');
    const scheduleText = interaction.options.getString('schedule');

    try {
        await interaction.deferReply({ ephemeral: true });

        // Try manual handling first
        let schedule = getManualCron(scheduleText);
        
        // If no manual match, use AI conversion
        if (!schedule) {
            try {
                schedule = await convertToCron(scheduleText);
            } catch (error) {
                await interaction.editReply({
                    content: '❌ Invalid schedule format. Please provide a clear description like "every day at 9am" or "every Monday at 3:30pm".'
                });
                return;
            }
        }

        // Check if name already exists for this user
        const existing = await db.get(
            `SELECT id FROM automations
             WHERE userId = @userId AND guildId = @guildId AND name = @name`,
            { userId: interaction.user.id, guildId: getConversationScopeId(interaction), name }
        );

        if (existing) {
            await interaction.editReply({
                content: '❌ An automation with this name already exists. Please choose a different name.'
            });
            return;
        }

        // Calculate next run time (crons are evaluated in UTC everywhere)
        const interval = CronExpressionParser.parse(schedule, { tz: 'UTC' });
        const nextRun = interval.next().toDate();

        console.log(`Final cron expression: "${schedule}" for schedule: "${scheduleText}"`);

        // Create the automation
        await db.run(
            `INSERT INTO automations (
                userId, guildId, channelId, name, promptText,
                schedule, nextRun, metadata
            ) VALUES (
                @userId, @guildId, @channelId, @name, @promptText,
                @schedule, @nextRun, @metadata
            )`,
            {
                userId: interaction.user.id,
                guildId: getConversationScopeId(interaction),
                channelId: interaction.channelId,
                name,
                promptText,
                schedule,
                nextRun,
                metadata: JSON.stringify({
                    createdInChannel: interaction.channelId,
                    createdByUsername: interaction.user.username,
                    originalSchedule: scheduleText
                })
            }
        );

        await interaction.editReply({
            content: `✅ Created automation "${name}"\n• Schedule: ${scheduleText}\n• Cron expression: \`${schedule}\`\n• Next run: ${nextRun.toLocaleString()}`
        });

    } catch (error) {
        console.error('Error creating automation:', error);
        if (error.message && error.message.includes('CHK_automation_schedule')) {
            console.error('This appears to be a constraint violation. Generated cron expression format is not accepted by the database.');
            const message = interaction.deferred ? 'editReply' : 'reply';
            await interaction[message]({
                content: '❌ Failed to create automation due to schedule format constraints. Please try a simpler schedule like "every hour" or "daily".',
                ephemeral: true
            });
        } else {
            const message = interaction.deferred ? 'editReply' : 'reply';
            await interaction[message]({
                content: '❌ Failed to create automation. Please try again.',
                ephemeral: true
            });
        }
    }
}

async function handleList(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });

        const rows = await db.all(
            `SELECT name, promptText, schedule, isEnabled, lastRun, nextRun, metadata
             FROM automations
             WHERE userId = @userId AND guildId = @guildId
             ORDER BY name ASC`,
            { userId: interaction.user.id, guildId: getConversationScopeId(interaction) }
        );

        if (rows.length === 0) {
            await interaction.editReply({
                content: 'You have no automations set up yet.'
            });
            return;
        }

        const automationList = rows.map(row => {
            const status = row.isEnabled ? '🟢' : '🔴';
            const lastRun = formatTimestamp(row.lastRun);
            const nextRun = row.nextRun ? formatTimestamp(row.nextRun) : 'Not scheduled';
            const metadata = JSON.parse(row.metadata || '{}');
            const scheduleText = metadata.originalSchedule || row.schedule;
            
            return `${status} **${row.name}**
• Schedule: ${scheduleText}
• Last run: ${lastRun}
• Next run: ${nextRun}
• Prompt: ${row.promptText.substring(0, 100)}${row.promptText.length > 100 ? '...' : ''}`;
        }).join('\n\n');

        await interaction.editReply({
            content: `**Your Automations**\n\n${automationList}`
        });

    } catch (error) {
        console.error('Error listing automations:', error);
        const message = interaction.deferred ? 'editReply' : 'reply';
        await interaction[message]({
            content: '❌ Failed to list automations. Please try again.',
            ephemeral: true
        });
    }
}

async function handleToggle(interaction) {
    const name = interaction.options.getString('name');
    const enabled = interaction.options.getBoolean('enabled');

    try {
        // Check if automation exists and belongs to user
        const automation = await db.get(
            `SELECT id, schedule, isEnabled
             FROM automations
             WHERE userId = @userId AND guildId = @guildId AND name = @name`,
            { userId: interaction.user.id, guildId: getConversationScopeId(interaction), name }
        );

        if (!automation) {
            await interaction.reply({
                content: `❌ Automation "${name}" not found.`,
                ephemeral: true
            });
            return;
        }

        // Update enabled status and recalculate next run if enabling
        if (enabled) {
            const interval = CronExpressionParser.parse(automation.schedule, { tz: 'UTC' });
            const nextRun = interval.next().toDate();

            await db.run(
                `UPDATE automations
                 SET isEnabled = @enabled, nextRun = @nextRun, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { enabled, nextRun, id: automation.id }
            );
        } else {
            await db.run(
                `UPDATE automations
                 SET isEnabled = @enabled, nextRun = NULL, updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                { enabled, id: automation.id }
            );
        }

        await interaction.reply({
            content: `✅ Automation "${name}" has been ${enabled ? 'enabled' : 'disabled'}.`,
            ephemeral: true
        });

    } catch (error) {
        console.error('Error toggling automation:', error);
        await interaction.reply({
            content: '❌ Failed to toggle automation. Please try again.',
            ephemeral: true
        });
    }
}

async function handleDelete(interaction) {
    const name = interaction.options.getString('name');

    try {
        const result = await db.run(
            `DELETE FROM automations
             WHERE userId = @userId AND guildId = @guildId AND name = @name`,
            { userId: interaction.user.id, guildId: getConversationScopeId(interaction), name }
        );

        if (result.changes === 0) {
            await interaction.reply({
                content: `❌ Automation "${name}" not found.`,
                ephemeral: true
            });
            return;
        }

        await interaction.reply({
            content: `✅ Automation "${name}" has been deleted.`,
            ephemeral: true
        });

    } catch (error) {
        console.error('Error deleting automation:', error);
        await interaction.reply({
            content: '❌ Failed to delete automation. Please try again.',
            ephemeral: true
        });
    }
} 