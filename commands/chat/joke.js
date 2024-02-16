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
    .setName('joke')
    .setDescription('Get a one-sentence joke')
    .addStringOption(option =>
      option.setName('category')
        .setDescription('The category of the joke')
        .setRequired(false)
    ),
  async execute(interaction) {
    const category = interaction.options.getString('category');
    let prompt = 'Tell me a joke.';
    if (category) {
      prompt += ` Category: ${category}`;
    }

    try {
      const completion = await openai.chat.completions.create({
        messages: [{ role: "system", content: prompt }],
        model: "gpt-4",
      });

      const joke = completion.choices[0].message.content.trim();
      await interaction.reply(joke);
    } catch (error) {
      console.error(error);
      await interaction.reply('Failed to fetch a joke.');
    }
  },
};
