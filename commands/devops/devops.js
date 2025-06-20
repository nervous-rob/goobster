const { SlashCommandBuilder } = require('discord.js');
const azureDevOps = require('../../services/azureDevOpsService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('devops')
        .setDescription('Interact with Azure DevOps')
        .addSubcommand(sub =>
            sub.setName('connect')
                .setDescription('Connect to an Azure DevOps project')
                .addStringOption(o =>
                    o.setName('org')
                        .setDescription('Organization URL')
                        .setRequired(true))
                .addStringOption(o =>
                    o.setName('project')
                        .setDescription('Project name')
                        .setRequired(true))
                .addStringOption(o =>
                    o.setName('token')
                        .setDescription('Personal access token')
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('create')
                .setDescription('Create a work item')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Work item type')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Bug', value: 'Bug' },
                            { name: 'Task', value: 'Task' },
                            { name: 'User Story', value: 'User Story' },
                            { name: 'Feature', value: 'Feature' },
                            { name: 'Epic', value: 'Epic' }
                        ))
                .addStringOption(o =>
                    o.setName('title')
                        .setDescription('Title')
                        .setRequired(true))
                .addStringOption(o =>
                    o.setName('description')
                        .setDescription('Description')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('comment')
                .setDescription('Add a comment to a work item')
                .addIntegerOption(o =>
                    o.setName('id')
                        .setDescription('Work item ID')
                        .setRequired(true))
                .addStringOption(o =>
                    o.setName('text')
                        .setDescription('Comment text')
                        .setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'connect') {
                const org = interaction.options.getString('org');
                const project = interaction.options.getString('project');
                const token = interaction.options.getString('token');
                azureDevOps.connect(interaction.user.id, org, project, token);
                await interaction.reply({ content: '✅ Connected to Azure DevOps.', ephemeral: true });
            } else if (sub === 'create') {
                const type = interaction.options.getString('type');
                const title = interaction.options.getString('title');
                const description = interaction.options.getString('description');
                await interaction.deferReply({ ephemeral: true });
                const item = await azureDevOps.createWorkItem(interaction.user.id, type, title, description);
                await interaction.editReply(`Created ${type} #${item.id}: ${item.url}`);
            } else if (sub === 'comment') {
                const id = interaction.options.getInteger('id');
                const text = interaction.options.getString('text');
                await interaction.deferReply({ ephemeral: true });
                await azureDevOps.addComment(interaction.user.id, id, text);
                await interaction.editReply('Comment added.');
            }
        } catch (err) {
            console.error('DevOps command error:', err);
            const msg = interaction.deferred ? 'editReply' : 'reply';
            await interaction[msg]({ content: `❌ ${err.message}`, ephemeral: true });
        }
    }
};
