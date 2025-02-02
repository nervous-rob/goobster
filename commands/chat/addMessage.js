const { SlashCommandBuilder } = require('@discordjs/builders');
const { OpenAI } = require('openai');
const { sql, getConnection } = require('../../azureDb');
const config = require('../../config.json');
const { EmbedBuilder } = require('discord.js');
const { chunkMessage } = require('../../utils');

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
		let transaction;
		try {
			await interaction.deferReply();
			const db = await getConnection();
			if (!db) {
				throw new Error('Failed to establish database connection');
			}

			const username = interaction.user.username;
			const text = interaction.options.getString('text');

			if (!text || text.trim().length === 0) {
				throw new Error('Please provide a message to add to the conversation.');
			}

			// Fetch the active conversation ID from the database
			const userResult = await db.query`SELECT activeConversationId FROM users WHERE username = ${username}`;
			if (!userResult.recordset.length || !userResult.recordset[0].activeConversationId) {
				throw new Error('No active conversation found. Please start a new conversation first.');
			}
			const activeConversationId = userResult.recordset[0].activeConversationId;

			// Split the message if it's longer than Discord's limit
			const chunks = chunkMessage(text);

			// Verify chunks are valid
			if (!chunks || chunks.length === 0) {
				throw new Error('Failed to process message. Please try again with a shorter message.');
			}

			// Start a transaction for database operations
			transaction = await db.transaction();
			await transaction.begin();

			try {
				// Insert each chunk into the database
				for (const chunk of chunks) {
					await db.query`INSERT INTO messages (conversationId, message) VALUES (${activeConversationId}, ${chunk})`;
				}

				// Fetch all the messages in the conversation
				const messagesResult = await db.query`SELECT message FROM messages WHERE conversationId = ${activeConversationId} ORDER BY createdAt ASC`;
				const messages = messagesResult.recordset.map(record => record.message);

				// Fetch the prompt text from the database
				const promptResult = await db.query`SELECT prompt FROM prompts WHERE id = (SELECT promptId FROM conversations WHERE id = ${activeConversationId})`;
				if (!promptResult.recordset.length) {
					throw new Error('Failed to retrieve conversation prompt.');
				}
				const promptText = promptResult.recordset[0].prompt;

				// Generate a response using the OpenAI API
				const prompt = messages.join('\n');
				const systemMessage = {
					role: "system",
					content: `Prompt: ${promptText}\n\nThe following conversation has taken place:\n${prompt}\n\nWhat would be an appropriate response?`
				};

				const completion = await openai.chat.completions.create({
					messages: [systemMessage],
					model: "gpt-4o",
					temperature: 0.7,
					max_tokens: 500
				});
				const response = completion.choices[0].message.content.trim();

				// Insert the generated response into the messages table
				await db.query`INSERT INTO messages (conversationId, message) VALUES (${activeConversationId}, ${response})`;

				await transaction.commit();

				// Split response into chunks if needed
				const responseChunks = chunkMessage(response);
				
				// Send each chunk
				for (const [index, chunk] of responseChunks.entries()) {
					const embed = new EmbedBuilder()
						.setDescription(chunk)
						.setColor(0x0099FF);
					
					if (index === 0) {
						await interaction.editReply({ embeds: [embed] });
					} else {
						await interaction.followUp({ embeds: [embed] });
					}
				}

			} catch (error) {
				if (transaction) {
					await transaction.rollback();
				}
				throw error;
			}

		} catch (error) {
			console.error('Error in addMessage command:', {
				error: error.message || 'Unknown error',
				stack: error.stack || 'No stack trace available',
				user: interaction.user.tag,
				channel: interaction.channel?.name || 'Unknown channel'
			});

			const errorMessage = error.message === 'No active conversation found. Please start a new conversation first.'
				? error.message
				: 'Failed to add message. Please try again.';

			try {
				if (interaction.deferred) {
					await interaction.editReply({ 
						content: `❌ ${errorMessage}`,
						allowedMentions: { users: [], roles: [] }
					});
				} else {
					await interaction.reply({ 
						content: `❌ ${errorMessage}`,
						ephemeral: true,
						allowedMentions: { users: [], roles: [] }
					});
				}
			} catch (replyError) {
				console.error('Failed to send error message:', {
					error: replyError.message,
					stack: replyError.stack,
					originalError: error.message
				});
			}
		}
	}
};