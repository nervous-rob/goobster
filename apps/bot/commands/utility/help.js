/**
 * /help - the command reference, built from the commands this process has
 * actually loaded.
 *
 * Categories are the folders under apps/bot/commands; each command's line is
 * the description Discord shows for it. Nothing here is written by hand, so
 * the list cannot name a command that no longer exists or miss one that
 * does, and a command whose feature is off on this installation is simply
 * absent. In a DM only the commands that work in DMs are listed.
 *
 * The full reference with every option is documentation/commands.md
 * (`npm run docs:commands` regenerates it from the same source).
 */

const path = require('node:path');
const { SlashCommandBuilder, EmbedBuilder, ApplicationCommandType } = require('discord.js');
const { listCommandFiles } = require('@goobster/core/utils/commandDeployment');
const identityConfig = require('@goobster/core/config/identityConfig');

const COMMANDS_DIR = path.join(__dirname, '..');
const DOCS_URL = 'https://github.com/nervous-rob/goobster/blob/main/documentation/commands.md';
const FIELDS_PER_EMBED = 25;

/** Visible names for the command folders; a folder without one is shown capitalised. */
const CATEGORY_LABELS = {
    chat: 'Chat',
    economy: 'Economy',
    image: 'Images',
    music: 'Music & audio',
    settings: 'Settings',
    tavern: 'Tavern & adventures',
    utility: 'Utility',
    voice: 'Voice'
};

function categoryLabel(folder) {
    return CATEGORY_LABELS[folder] || folder.charAt(0).toUpperCase() + folder.slice(1);
}

/**
 * Folder of every declared command name. A static read of the source tree:
 * no command is required here, and disabled features are not a concern
 * because the list is intersected with what the client loaded.
 */
function folderByName() {
    const { active, inactive } = listCommandFiles(COMMANDS_DIR);
    const map = new Map();
    for (const entry of [...active, ...inactive]) {
        if (entry.name) map.set(entry.name, entry.folder);
    }
    return map;
}

const FOLDERS = [...new Set(folderByName().values())].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));

/**
 * The loaded commands, grouped by category, filtered to what the person can
 * use where they are asking from.
 * @param {import('discord.js').Interaction} interaction
 */
function catalogue(interaction) {
    const folders = folderByName();
    const inDm = !interaction.guildId;
    const groups = new Map();
    const menus = [];
    for (const command of interaction.client.commands?.values() || []) {
        const data = command.data;
        if (!data) continue;
        if (inDm && !command.dmAllowed) continue;
        const json = typeof data.toJSON === 'function' ? data.toJSON() : data;
        if (!json?.name) continue;
        if (json.type && json.type !== ApplicationCommandType.ChatInput) {
            menus.push(json.name);
            continue;
        }
        const folder = folders.get(json.name) || 'utility';
        if (!groups.has(folder)) groups.set(folder, []);
        groups.get(folder).push({ name: json.name, description: json.description || '' });
    }
    for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return { groups, menus: menus.sort(), inDm };
}

function overviewEmbed({ groups, menus, inDm }) {
    const total = [...groups.values()].reduce((n, list) => n + list.length, 0);
    const embed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle(`${identityConfig.assistantName} commands`)
        .setDescription(
            `${total} ${total === 1 ? 'command' : 'commands'}${inDm ? ' work in DMs' : ''}. `
            + 'Pick a category with `/help category:` for each command\'s description.\n'
            + `[Full reference with every option](${DOCS_URL})`
        );
    for (const folder of FOLDERS) {
        const list = groups.get(folder);
        if (!list?.length) continue;
        embed.addFields({
            name: `${categoryLabel(folder)} · ${list.length}`,
            value: list.map((c) => `\`/${c.name}\``).join(' ')
        });
    }
    if (menus.length) {
        embed.addFields({ name: 'Right-click menus', value: menus.map((m) => `“${m}”`).join(', ') });
    }
    return embed;
}

function categoryEmbeds(folder, list) {
    const embeds = [];
    for (let i = 0; i < list.length; i += FIELDS_PER_EMBED) {
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle(i === 0 ? `${categoryLabel(folder)} commands` : `${categoryLabel(folder)} commands (continued)`)
            .addFields(list.slice(i, i + FIELDS_PER_EMBED).map((c) => ({ name: `/${c.name}`, value: c.description || '—' })));
        if (i === 0) embed.setFooter({ text: 'Options and subcommands: see the full reference via /help' });
        embeds.push(embed);
    }
    return embeds;
}

module.exports = {
    // Registered globally with DM contexts (see deploy-commands.js)
    dmAllowed: true,
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('List the available commands, by category')
        .addStringOption(option =>
            option.setName('category')
                .setDescription('One category of commands')
                .setRequired(false)
                .addChoices(...FOLDERS.map((folder) => ({ name: categoryLabel(folder), value: folder })))),

    async execute(interaction) {
        const category = interaction.options.getString('category');
        const index = catalogue(interaction);
        if (category) {
            const list = index.groups.get(category);
            if (!list?.length) {
                return interaction.reply({
                    content: index.inDm
                        ? `No ${categoryLabel(category).toLowerCase()} commands work in DMs. Try \`/help\` for the ones that do.`
                        : `No ${categoryLabel(category).toLowerCase()} commands are available on this installation.`,
                    ephemeral: true
                });
            }
            return interaction.reply({ embeds: categoryEmbeds(category, list), ephemeral: true });
        }
        return interaction.reply({ embeds: [overviewEmbed(index)], ephemeral: true });
    }
};
