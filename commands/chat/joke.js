const { SlashCommandBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const config = require('../../config.json');
const { getPrompt } = require('../../utils/memeMode');

const openai = new OpenAI({ apiKey: config.openaiKey });

module.exports = {
    data: new SlashCommandBuilder()
        .setName('joke')
        .setDescription('Get an AI-generated joke')
        .addStringOption(option =>
            option.setName('category')
                .setDescription('Type of joke')
                .setRequired(false)
                .addChoices(
                    { name: 'Dad Joke', value: 'dad' },
                    { name: 'Pun', value: 'pun' },
                    { name: 'Tech', value: 'tech' },
                    { name: 'Science', value: 'science' }
                )),

    async execute(interaction) {
        await interaction.deferReply();

        const category = interaction.options.getString('category') || 'general';
        const systemPrompt = getPrompt(interaction.user.id);
        
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
