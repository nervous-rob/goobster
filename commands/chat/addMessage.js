const { SlashCommandBuilder } = require('@discordjs/builders');
const { OpenAI } = require('openai');
const { sql, getConnection } = require('../../azureDb');
const config = require('../../config.json');
const { MessageEmbed } = require('discord.js');

const openai = new OpenAI({ apiKey: config.openaiKey });

module.exports = {
	data: new SlashCommandBuilder()
		.setName('addmessage')
		.setDescription('Adds a message to a conversation and gets a response.')
		.addStringOption(option =>
			option.setName('text')
				.setDescription('The text of the message')
				.setRequired(true)
		),
	async execute(interaction) {
		try {
			const sql = await getConnection(); // Ensure connection to the database
			const username = interaction.user.username;
			const text = interaction.options.getString('text');

			// Fetch the active conversation ID from the database
			const userResult = await sql.query`SELECT activeConversationId FROM users WHERE username = ${username}`;
			const activeConversationId = userResult.recordset[0].activeConversationId;

			// Split the message if it's longer than 2000 characters
			const splitText = text.match(/.{1,2000}/g);

			// Insert the new message(s) into the messages table
			for (let i = 0; i < splitText.length; i++) {
				await sql.query`INSERT INTO messages (conversationId, message) VALUES (${activeConversationId}, ${splitText[i]})`;
			}

			// Fetch all the messages in the conversation
			const messagesResult = await sql.query`SELECT message FROM messages WHERE conversationId = ${activeConversationId} ORDER BY createdAt ASC`;
			const messages = messagesResult.recordset.map(record => record.message);

			// Fetch the prompt text from the database
			const promptResult = await sql.query`SELECT prompt FROM prompts WHERE id = (SELECT promptId FROM conversations WHERE id = ${activeConversationId})`;
			const promptText = promptResult.recordset[0].prompt;

			// Generate a response using the OpenAI API
			const prompt = messages.join('\n');
			const systemMessage = {
				role: "system",
				content: `Prompt: ${promptText}\n\nThe following conversation has taken place:\n${prompt}\n\nWhat would be an appropriate response?`
			};

			// Defer reply to prevent timeout while OpenAI is generating a response
			await interaction.deferReply();

			const completion = await openai.chat.completions.create({
				messages: [systemMessage],
				model: "gpt-4",
			});
			const response = completion.choices[0].message.content.trim();

			// Insert the generated response into the messages table
			await sql.query`INSERT INTO messages (conversationId, message) VALUES (${activeConversationId}, ${response})`;

			// Edit the deferred reply with the generated response
			const embed = new MessageEmbed()
				.setDescription(response);
			await interaction.editReply({ embeds: [embed] });
		} catch (error) {
			console.error('Error:', error);
			await interaction.followUp('Failed to add message.');
		}
	}
};