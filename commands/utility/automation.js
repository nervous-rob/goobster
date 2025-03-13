const { SlashCommandBuilder } = require('discord.js');
const { sql } = require('../../azureDb');
const { CronExpressionParser } = require('cron-parser');
const { OpenAI } = require('openai');
const config = require('../../config.json');

const openai = new OpenAI({ apiKey: config.openaiKey });

// Helper function to convert natural language to cron expression
async function convertToCron(schedule) {
    try {
        const completion = await openai.chat.completions.create({
            messages: [
                {
                    role: 'system',
                    content: `You are a cron expression converter. Convert any natural language scheduling description into a cron expression.
                    Only respond with the cron expression, nothing else.
                    Format: minute hour day-of-month month day-of-week
                    
                    Always use the standard 5-part cron format with EXACTLY one space between each part (no extra spaces).
                    The format must be strictly: "m h dom mon dow" where each part is separated by exactly one space.
                    
                    Examples:
                    - "every day at 9am" -> "0 9 * * *"
                    - "every Monday at 3:30pm" -> "30 15 * * 1"
                    - "every hour" -> "0 * * * *"
                    - "every 30 minutes" -> "*/30 * * * *"
                    - "at 2:45pm on weekdays" -> "45 14 * * 1-5"
                    - "Every 30 minutes" -> "*/30 * * * *"
                    - "every thirty minutes" -> "*/30 * * * *"
                    - "each half hour" -> "*/30 * * * *"
                    - "twice per hour" -> "0,30 * * * *"
                    - "every other hour" -> "0 */2 * * *"
                    - "thrice daily" -> "0 */8 * * *"
                    - "weekday mornings" -> "0 9 * * 1-5"
                    - "weekend afternoons" -> "0 14 * * 0,6"
                    
                    Be flexible and creative in interpreting the input. If the input is ambiguous, make a reasonable assumption.
                    If you're unsure about the exact interpretation, choose a reasonable default that matches the spirit of the request.
                    
                    IMPORTANT: Your response must ONLY be a 5-part cron expression with one space between each part, matching this pattern: "m h dom mon dow"
                    If the input is completely invalid or impossible to interpret, respond with "INVALID"`
                },
                {
                    role: 'user',
                    content: schedule
                }
            ],
            model: "gpt-4o",
            temperature: 0.3,
            max_tokens: 20
        });

        const cronExpression = completion.choices[0].message.content.trim();
        if (cronExpression === 'INVALID') {
            throw new Error('Could not understand the schedule description. Please try rephrasing it.');
        }

        // Format validation - ensure we have the standard 5-part cron format
        // m h dom mon dow
        const cronParts = cronExpression.split(' ');
        if (cronParts.length !== 5) {
            console.error('Invalid cron format (wrong number of parts):', cronExpression);
            throw new Error('Failed to create a valid schedule format. Please try rephrasing your request.');
        }

        // Validate the generated cron expression using the CronExpressionParser
        try {
            CronExpressionParser.parse(cronExpression);
            
            // Reformat the cron expression to strictly match database constraint pattern
            // This ensures the spacing is exactly as the SQL constraint requires
            const formattedCron = cronParts.join(' ');
            console.log(`Formatted cron expression: "${formattedCron}"`);
            
            return formattedCron;
        } catch (cronError) {
            console.error('Invalid cron expression generated:', cronError);
            throw new Error('Failed to create a valid schedule. Please try rephrasing your request.');
        }
    } catch (error) {
        if (error.message.includes('Could not understand')) {
            throw error;
        }
        throw new Error('Failed to convert schedule. Please try again with a clearer description.');
    }
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
    data: new SlashCommandBuilder()
        .setName('automation')
        .setDescription('Manage automated message triggers')
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Create a new automated message trigger')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('Name for this automation')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('prompt')
                        .setDescription('The prompt text to use for generating messages')
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
        const existingResult = await sql.query`
            SELECT id FROM automations 
            WHERE userId = ${interaction.user.id} 
            AND guildId = ${interaction.guildId}
            AND name = ${name}
        `;

        if (existingResult.recordset.length > 0) {
            await interaction.editReply({
                content: '❌ An automation with this name already exists. Please choose a different name.'
            });
            return;
        }

        // Calculate next run time
        const interval = CronExpressionParser.parse(schedule);
        const nextRun = interval.next().toDate();

        console.log(`Final cron expression: "${schedule}" for schedule: "${scheduleText}"`);

        // Create the automation
        await sql.query`
            INSERT INTO automations (
                userId, guildId, channelId, name, promptText, 
                schedule, nextRun, metadata
            ) VALUES (
                ${interaction.user.id},
                ${interaction.guildId},
                ${interaction.channelId},
                ${name},
                ${promptText},
                ${schedule},
                ${nextRun},
                ${JSON.stringify({
                    createdInChannel: interaction.channelId,
                    createdByUsername: interaction.user.username,
                    originalSchedule: scheduleText
                })}
            )
        `;

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

        const result = await sql.query`
            SELECT name, promptText, schedule, isEnabled, lastRun, nextRun, metadata
            FROM automations
            WHERE userId = ${interaction.user.id}
            AND guildId = ${interaction.guildId}
            ORDER BY name ASC
        `;

        if (result.recordset.length === 0) {
            await interaction.editReply({
                content: 'You have no automations set up yet.'
            });
            return;
        }

        const automationList = result.recordset.map(row => {
            const status = row.isEnabled ? '🟢' : '🔴';
            const lastRun = row.lastRun ? row.lastRun.toLocaleString() : 'Never';
            const nextRun = row.nextRun ? row.nextRun.toLocaleString() : 'Not scheduled';
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
        const result = await sql.query`
            SELECT id, schedule, isEnabled 
            FROM automations 
            WHERE userId = ${interaction.user.id}
            AND guildId = ${interaction.guildId}
            AND name = ${name}
        `;

        if (result.recordset.length === 0) {
            await interaction.reply({
                content: `❌ Automation "${name}" not found.`,
                ephemeral: true
            });
            return;
        }

        // Update enabled status and recalculate next run if enabling
        if (enabled) {
            const interval = CronExpressionParser.parse(result.recordset[0].schedule);
            const nextRun = interval.next().toDate();

            await sql.query`
                UPDATE automations 
                SET isEnabled = ${enabled}, 
                    nextRun = ${nextRun},
                    updatedAt = GETDATE()
                WHERE id = ${result.recordset[0].id}
            `;
        } else {
            await sql.query`
                UPDATE automations 
                SET isEnabled = ${enabled}, 
                    nextRun = NULL,
                    updatedAt = GETDATE()
                WHERE id = ${result.recordset[0].id}
            `;
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
        const result = await sql.query`
            DELETE FROM automations 
            WHERE userId = ${interaction.user.id}
            AND guildId = ${interaction.guildId}
            AND name = ${name}
        `;

        if (result.rowsAffected[0] === 0) {
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