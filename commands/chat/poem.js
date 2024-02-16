const { SlashCommandBuilder } = require('@discordjs/builders');
const { OpenAI } = require('openai');
const axios = require('axios');
const path = require('path');

// Get the absolute path to the config file
const configPath = path.resolve(__dirname, '../../config.json');

// Load the config file
const config = require(configPath);

const openai = new OpenAI({ apiKey: config.openaiKey });


module.exports = {
  data: new SlashCommandBuilder()
    .setName('poem')
    .setDescription('Generate a poem')
    .addStringOption(option =>
      option.setName('topic')
        .setDescription('The topic of the poem')
        .setRequired(false)
    ),
  async execute(interaction) {
    // Defer the reply
    await interaction.deferReply();

    const topic = interaction.options.getString('topic');
    let prompt = 'Write me a poem.';
    if (topic) {
      prompt += ` Topic: ${topic}`;
    }

    try {
      const completion = await openai.chat.completions.create({
        messages: [{ role: "system", content: prompt }],
        model: "gpt-4"
      });

      let poem = completion.choices[0].message.content.trim();
      // Limit the poem to a hard maximum of 2000 characters
      poem = poem.slice(0, 2000);

      // Edit the deferred reply
      await interaction.editReply(poem);
    } catch (error) {
      console.error('Error generating poem:', error);
      // Edit the deferred reply
      await interaction.editReply('Failed to generate a poem.');
    }
  },
};