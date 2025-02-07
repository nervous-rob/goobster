const { SlashCommandBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const config = require('../../config.json');
const { getPrompt } = require('../../utils/memeMode');

const openai = new OpenAI({ apiKey: config.openaiKey });

module.exports = {
    data: new SlashCommandBuilder()
        .setName('poem')
        .setDescription('Get an AI-generated poem')
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('Topic or theme for the poem')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('style')
                .setDescription('Style of poem')
                .setRequired(false)
                .addChoices(
                    { name: 'Haiku', value: 'haiku' },
                    { name: 'Limerick', value: 'limerick' },
                    { name: 'Sonnet', value: 'sonnet' },
                    { name: 'Free Verse', value: 'free' }
                )),

    async execute(interaction) {
        await interaction.deferReply();

        const topic = interaction.options.getString('topic') || 'random';
        const style = interaction.options.getString('style') || 'free';
        const systemPrompt = getPrompt(interaction.user.id);
        
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