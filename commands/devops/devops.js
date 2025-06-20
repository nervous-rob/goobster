const { SlashCommandBuilder } = require('discord.js');
const azureDevOps = require('../../services/azureDevOpsService');

function formatWorkItem(item) {
    if (!item || !item.fields) return `${item.id}`;
    const title = item.fields['System.Title'] || '';
    const state = item.fields['System.State'] || '';
    const type = item.fields['System.WorkItemType'] || '';
    return `#${item.id} [${type}] ${title} (${state})`;
}

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
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('query')
                .setDescription('Query work items by WIQL or ID')
                .addStringOption(o =>
                    o.setName('wiql')
                        .setDescription('WIQL query string'))
                .addIntegerOption(o =>
                    o.setName('id')
                        .setDescription('Work item ID')))
        .addSubcommand(sub =>
            sub.setName('update')
                .setDescription('Update a field on a work item')
                .addIntegerOption(o =>
                    o.setName('id')
                        .setDescription('Work item ID')
                        .setRequired(true))
                .addStringOption(o =>
                    o.setName('field')
                        .setDescription('Field reference name, e.g. System.Title')
                        .setRequired(true))
                .addStringOption(o =>
                    o.setName('value')
                        .setDescription('New value')
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
            } else if (sub === 'query') {
                const wiql = interaction.options.getString('wiql');
                const id = interaction.options.getInteger('id');
                await interaction.deferReply({ ephemeral: true });
                const conn = azureDevOps.getConnection(interaction.user.id);
                let result;
                if (wiql) {
                    result = await azureDevOps.queryWIQL(interaction.user.id, wiql);
                    const ids = result.workItems?.map(w => w.id) || [];
                    if (!ids.length) return await interaction.editReply('No work items found.');
                    const fields = result.columns?.map(c => c.referenceName) || [];
                    if (!fields.includes('System.TeamProject')) fields.push('System.TeamProject');
                    const items = await azureDevOps.getWorkItems(interaction.user.id, ids, fields);
                    const filtered = items.filter(it => it.fields['System.TeamProject'] === conn.project);
                    if (!filtered.length) return await interaction.editReply('No work items found.');
                    const lines = filtered.map(formatWorkItem);
                    const output = lines.join('\n').slice(0, 1900);
                    await interaction.editReply(output);
                } else if (id) {
                    const item = await azureDevOps.getWorkItem(interaction.user.id, id);
                    if (item.fields['System.TeamProject'] !== conn.project) {
                        return await interaction.editReply('No work item found.');
                    }
                    await interaction.editReply(formatWorkItem(item));
                } else {
                    throw new Error('Provide wiql or id');
                }
            } else if (sub === 'update') {
                const id = interaction.options.getInteger('id');
                const field = interaction.options.getString('field');
                const value = interaction.options.getString('value');
                await interaction.deferReply({ ephemeral: true });
                const item = await azureDevOps.updateWorkItem(interaction.user.id, id, { [field]: value });
                await interaction.editReply(`Updated work item #${item.id}`);
            }
        } catch (err) {
            console.error('DevOps command error:', err);
            const msg = interaction.deferred ? 'editReply' : 'reply';
            await interaction[msg]({ content: `❌ ${err.message}`, ephemeral: true });
        }
    }
};
