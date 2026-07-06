const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const memoryService = require('../../services/memoryService');
const factsService = require('../../services/factsService');
const aiService = require('../../services/aiService');
const usageTracker = require('../../services/usageTracker');

// Pull more candidates than the chat-context default: answering a direct
// question benefits from a wider net than prompt enrichment does.
const RECALL_LIMIT = 8;
const MAX_SOURCES_SHOWN = 4;

/**
 * Drop memories the asking user could not have seen themselves: anything from
 * a channel that still exists but is not visible to them. Memories without a
 * channel (or from since-deleted channels) are kept.
 */
function filterByChannelVisibility(memories, interaction) {
    if (!interaction.guild || !interaction.member) return memories;

    return memories.filter(memory => {
        if (!memory.channelId) return true;
        const channel = interaction.guild.channels.cache.get(memory.channelId);
        if (!channel) return true;
        return channel.permissionsFor(interaction.member)?.has(PermissionFlagsBits.ViewChannel) ?? false;
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('recall')
        .setDescription('Ask the server\'s long-term memory anything.')
        .addStringOption(option =>
            option.setName('question')
                .setDescription('What do you want to know? e.g. "what did we decide about the minecraft server?"')
                .setRequired(true)
                .setMaxLength(400)),

    async execute(interaction) {
        if (!interaction.guildId) {
            await interaction.reply({ content: 'Server memory only exists inside servers.', ephemeral: true });
            return;
        }

        await interaction.deferReply();
        const question = interaction.options.getString('question');

        usageTracker.logCommand({
            command: 'recall',
            guildId: interaction.guildId,
            userId: interaction.user.id
        });

        try {
            const recalled = await memoryService.recall({
                guildId: interaction.guildId,
                query: question,
                limit: RECALL_LIMIT
            });
            const memories = filterByChannelVisibility(recalled, interaction);

            if (memories.length === 0) {
                await interaction.editReply(
                    `I dug through my memory but found nothing about that. ` +
                    `I only remember conversations that happened while I was around!`
                );
                return;
            }

            const memoryLines = memories.map(m => {
                const when = m.createdAt ? m.createdAt.split(' ')[0] : 'unknown date';
                return `- [${when}] ${m.authorName || 'someone'}: ${m.content}`;
            });
            const guildFacts = factsService.getGuildFacts(interaction.guildId);

            const answer = await aiService.chatText([
                {
                    role: 'system',
                    content: `You are Goobster, a Discord bot answering a question from the server's long-term memory. Answer ONLY from the memory excerpts (and server facts) below - never invent details. If they don't fully answer the question, say what you do remember and be upfront about the gaps. Mention who said things and roughly when, when that helps. Keep it under 150 words, with your usual light personality.

MEMORY EXCERPTS (retrieved by similarity, newest context wins on conflicts):
${memoryLines.join('\n')}
${guildFacts.length > 0 ? `\nKNOWN SERVER FACTS:\n${guildFacts.map(f => `- ${f.content}`).join('\n')}` : ''}`
                },
                { role: 'user', content: question }
            ], {
                preset: 'chat',
                max_tokens: 400,
                usageContext: { guildId: interaction.guildId, userId: interaction.user.id }
            });

            const sources = memories.slice(0, MAX_SOURCES_SHOWN).map(m => {
                const when = m.createdAt ? m.createdAt.split(' ')[0] : '?';
                const snippet = m.content.length > 90 ? `${m.content.slice(0, 90)}…` : m.content;
                return `- \`${when}\` **${m.authorName || 'someone'}** (${(m.similarity * 100).toFixed(0)}%): ${snippet}`;
            });

            const embed = new EmbedBuilder()
                .setColor('#9B59B6')
                .setTitle(`🧠 ${question.length > 240 ? question.slice(0, 240) + '…' : question}`)
                .setDescription(answer.slice(0, 4000))
                .addFields({
                    name: `From ${memories.length} ${memories.length === 1 ? 'memory' : 'memories'}`,
                    value: sources.join('\n').slice(0, 1024),
                    inline: false
                })
                .setFooter({ text: 'Long-term memory is stored locally on this server\'s own database.' })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Recall command failed:', error);
            await interaction.editReply(`❌ My memory glitched out: ${error.message}`);
        }
    }
};
