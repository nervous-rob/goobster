const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildAI, setGuildAI } = require('../../utils/guildSettings');
const { getConversationScopeId } = require('../../utils/dmScope');
const aiService = require('../../services/aiService');
const aiConfig = require('../../config/aiConfig');

module.exports = {
    // In a DM the overrides are per-user (keyed on the DM scope) -
    // registered globally with DM contexts, see deploy-commands.js.
    // ManageGuild still gates the command inside servers.
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('aisettings')
        .setDescription('Configure which AI provider and model Goobster uses in this server or DM.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('set')
                .setDescription('Override the AI provider/model for this server')
                .addStringOption(option =>
                    option.setName('provider')
                        .setDescription('AI provider')
                        .addChoices(
                            { name: 'OpenAI', value: 'openai' },
                            { name: 'Anthropic Claude', value: 'anthropic' },
                            { name: 'Google Gemini', value: 'gemini' },
                            { name: 'Ollama (local)', value: 'ollama' }
                        ))
                .addStringOption(option =>
                    option.setName('model')
                        .setDescription(`Model ID, e.g. ${aiConfig.openai.chatModel} or ${aiConfig.gemini.chatModel}`))
                .addStringOption(option =>
                    option.setName('reasoning')
                        .setDescription('Reasoning effort (OpenAI, Anthropic, and Gemini)')
                        .addChoices(
                            { name: 'Minimal', value: 'minimal' },
                            { name: 'Low', value: 'low' },
                            { name: 'Medium', value: 'medium' },
                            { name: 'High', value: 'high' }
                        )))
        .addSubcommand(subcommand =>
            subcommand
                .setName('reset')
                .setDescription('Clear overrides and use the global defaults'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show the AI configuration for this server')),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        // Guild id in servers, the user's DM scope in direct messages
        const scopeId = getConversationScopeId(interaction);
        const scopeLabel = interaction.guildId ? 'this server' : 'our DMs';

        if (subcommand === 'set') {
            const provider = interaction.options.getString('provider');
            const model = interaction.options.getString('model');
            const reasoning = interaction.options.getString('reasoning');

            if (!provider && !model && !reasoning) {
                await interaction.reply({ content: 'Provide at least one of provider, model, or reasoning.', ephemeral: true });
                return;
            }

            const updates = {};
            if (provider) updates.provider = provider;
            if (model) updates.model = model;
            if (reasoning) updates.reasoningEffort = reasoning;

            const settings = await setGuildAI(scopeId, updates);
            await interaction.reply({
                content: `⚙️ **AI settings updated for ${scopeLabel}:**\n` +
                    `- Provider: ${settings.provider || `(default: ${aiService.getProvider()})`}\n` +
                    `- Model: ${settings.model || '(provider default)'}\n` +
                    `- Reasoning effort: ${settings.reasoningEffort || '(default)'}`,
                ephemeral: true
            });
        } else if (subcommand === 'reset') {
            await setGuildAI(scopeId, { provider: null, model: null, reasoningEffort: null });
            await interaction.reply({
                content: `⚙️ AI settings reset. ${interaction.guildId ? 'This server' : 'Our DM'} now uses the global defaults (${aiService.getProvider()} / ${aiService.getDefaultModel()}).`,
                ephemeral: true
            });
        } else if (subcommand === 'status') {
            const settings = await getGuildAI(scopeId);
            const hasOverrides = settings.provider || settings.model || settings.reasoningEffort;
            await interaction.reply({
                content: `⚙️ **AI configuration for ${scopeLabel}:**\n` +
                    `- Provider: ${settings.provider || `${aiService.getProvider()} (global default)`}\n` +
                    `- Model: ${settings.model || `${aiService.getDefaultModel()} (global default)`}\n` +
                    `- Reasoning effort: ${settings.reasoningEffort || '(default)'}\n` +
                    (hasOverrides ? '\nUse `/aisettings reset` to return to defaults.' : '\nNo overrides set - following global defaults.'),
                ephemeral: true
            });
        }
    }
};
