const { SlashCommandBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const { getPromptWithGuildPersonality } = require('../../utils/memeMode');
const config = require('../../config.json');
const { chunkMessage } = require('../../utils/index');

const openai = new OpenAI({ apiKey: config.openaiKey });

module.exports = {
    data: new SlashCommandBuilder()
        .setName('joke')
        .setDescription('Tells a joke about the specified topic')
        .addStringOption(option =>
            option.setName('category')
                .setDescription('The category of joke')
                .setRequired(false)
                .addChoices(
                    { name: 'General', value: 'general' },
                    { name: 'Programming', value: 'programming' },
                    { name: 'Dad Joke', value: 'dad' },
                    { name: 'Pun', value: 'pun' },
                    { name: 'Science', value: 'science' }
                )),

    async execute(interaction) {
        await interaction.deferReply();

        const category = interaction.options.getString('category') || 'general';
        const guildId = interaction.guild?.id;
        const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
        
        try {
            const completion = await openai.chat.completions.create({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Tell me a ${category} joke. Make it original and clever!` }
                ],
                model: "gpt-4o",
                temperature: 0.8,
                max_tokens: 150
            });

            await interaction.editReply(completion.choices[0].message.content);
        } catch (error) {
            console.error('Error generating joke:', error);
            await interaction.editReply('Sorry, I had trouble thinking of a joke. Maybe my funny bone needs recalibrating! 🤔');
        }
    },
};
