const { SlashCommandBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const { getPromptWithGuildPersonality } = require('../../utils/memeMode');
const config = require('../../config.json');
const { chunkMessage } = require('../../utils/index');

const openai = new OpenAI({ apiKey: config.openaiKey });

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poem')
        .setDescription('Generate a poem about a topic')
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('Topic for the poem')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('style')
                .setDescription('Style of the poem')
                .setRequired(false)
                .addChoices(
                    { name: 'Free Verse', value: 'free' },
                    { name: 'Haiku', value: 'haiku' },
                    { name: 'Sonnet', value: 'sonnet' },
                    { name: 'Limerick', value: 'limerick' },
                    { name: 'Epic', value: 'epic' }
                )),

    async execute(interaction) {
        await interaction.deferReply();

        const topic = interaction.options.getString('topic') || 'random';
        const style = interaction.options.getString('style') || 'free';
        const guildId = interaction.guild?.id;
        const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
        
        try {
            const completion = await openai.chat.completions.create({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Write a ${style} poem about ${topic}. Be creative and expressive!` }
                ],
                model: "gpt-4o",
                temperature: 0.8,
                max_tokens: 250
            });

            await interaction.editReply(completion.choices[0].message.content);
        } catch (error) {
            console.error('Error generating poem:', error);
            await interaction.editReply('Sorry, my poetic muse seems to be taking a break! Try again later. 📝');
        }
    },
};