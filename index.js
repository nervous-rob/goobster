const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Client, Collection, Events, GatewayIntentBits, Partials } = require('discord.js');
const { validateConfig } = require('./utils/configValidator');
const MusicService = require('./services/voice/musicService');
const { getConnection, closeConnection } = require('./azureDb');

// Add near the top, after the requires
const DEBUG_MODE = process.argv.includes('--debug');

// Create a custom logger
const logger = {
	debug: (...args) => {
		if (DEBUG_MODE) console.debug('[DEBUG]', ...args);
	},
	log: (...args) => {
		if (DEBUG_MODE || args[0]?.startsWith('[IMPORTANT]')) console.log(...args);
	},
	info: (...args) => console.info('[INFO]', ...args),
	warn: (...args) => console.warn('[WARN]', ...args),
	error: (...args) => console.error('[ERROR]', ...args)
};

// Log startup mode
logger.info(`Starting bot in ${DEBUG_MODE ? 'debug' : 'normal'} mode`);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Add health check endpoint
app.get('/health', (req, res) => {
	logger.debug('Health check requested');
	res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start Express server first
const server = app.listen(PORT, () => {
	logger.info(`Express server is running on port ${PORT}`);
});

// Check if config file exists
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
	logger.error('config.json not found! Please ensure the config file is present.');
	process.exit(1);
}

logger.info('Loading config...');
const config = require('./config.json');
if (!config.token) {
	logger.error('Discord token not found in config.json!');
	process.exit(1);
}

if (!config.azure?.speech?.key || !config.azure?.speech?.region) {
	console.error('Azure Speech credentials not found in config.json!');
	process.exit(1);
}

// Validate Perplexity API key
if (!config.perplexity?.apiKey) {
	console.error('Perplexity API key not found in config.json! Search functionality will not work.');
	process.exit(1);
}

const { handleReactionAdd, handleReactionRemove } = require('./utils/chatHandler');

logger.info('Starting bot initialization...');

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,  // Required for voice
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,     // If you need message content
		GatewayIntentBits.GuildMessageReactions,  // For handling reactions
		GatewayIntentBits.GuildMembers,            // For member-related operations
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.DirectMessageReactions,
		GatewayIntentBits.GuildPresences,  // For better user tracking
		GatewayIntentBits.GuildEmojisAndStickers  // For custom emoji support
	],
	ws: {
		properties: {
			$browser: "Discord iOS"  // Sometimes helps with voice connection
		}
	},
	// Enable partials for better event handling
	partials: [
		Partials.Message,
		Partials.Channel,
		Partials.Reaction,
		Partials.User,
		Partials.GuildMember,
		Partials.ThreadMember,  // Add support for thread member updates
		Partials.GuildScheduledEvent  // For future scheduled events support
	],
	// Add recommended client options
	failIfNotExists: false,    // Don't throw if entity doesn't exist
	allowedMentions: {        // Control which mentions are allowed
		parse: ['users', 'roles'],
		repliedUser: true
	},
	// Set initial presence
	presence: {
		status: 'online',
		activities: [{
			name: 'your voice',
			type: 2  // "Listening to"
		}]
	},
	// REST API configuration
	rest: {
		timeout: 15000,       // 15 seconds
		retries: 3,           // Retry failed requests 3 times
		userAgentAppendix: 'Goobster Voice Bot'  // Custom UA for tracking
	},
	// Configure cache sweeping
	sweepers: {
		messages: {
			interval: 3600,   // Every hour
			lifetime: 7200    // Remove messages older than 2 hours
		},
		users: {
			interval: 3600,   // Every hour
			filter: () => user => !user.bot && user.lastMessageId // Only sweep inactive users
		}
	}
});

logger.info('Loading event handlers...');

// Load event handlers
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
	try {
		const filePath = path.join(eventsPath, file);
		logger.info(`Loading event: ${file}`);
		const event = require(filePath);
		if (event.once) {
			client.once(event.name, (...args) => event.execute(...args));
		} else {
			client.on(event.name, (...args) => event.execute(...args));
		}
	} catch (error) {
		logger.error(`Error loading event ${file}:`, error);
	}
}

logger.info('Loading commands...');

client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	try {
		const commandsPath = path.join(foldersPath, folder);
		const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
		logger.info(`Loading commands from folder: ${folder}`);
		for (const file of commandFiles) {
			const filePath = path.join(commandsPath, file);
			const command = require(filePath);
			if ('data' in command && 'execute' in command) {
				client.commands.set(command.data.name, command);
				logger.info(`Loaded command: ${command.data.name}`);
			} else {
				logger.warn(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
			}
		}
	} catch (error) {
		logger.error(`Error loading commands from folder ${folder}:`, error);
	}
}

// Add error handling for the client
client.on('error', error => {
	logger.error('Discord client error:', error);
});

client.on('warn', warning => {
	logger.warn('Discord client warning:', warning);
});

client.on('debug', info => {
	if (info.includes('Heartbeat')) {
		logger.debug('Discord heartbeat:', info);
	} else {
		logger.debug('Discord client debug:', info);
	}
});

// Add invalidated handler for session issues
client.on('invalidated', () => {
	logger.error('Client session invalidated - attempting to reconnect...');
	client.destroy();
	client.login(config.token).catch(error => {
		logger.error('Failed to reconnect after invalidation:', error);
		process.exit(1);
	});
});

// Add rateLimit handler
client.on('rateLimit', (rateLimitData) => {
	logger.warn('Rate limit hit:', {
		timeout: rateLimitData.timeout,
		limit: rateLimitData.limit,
		method: rateLimitData.method,
		path: rateLimitData.path,
		route: rateLimitData.route,
		global: rateLimitData.global
	});
});

// Add cache ready handler
client.on('cacheSweep', (message) => {
	logger.debug('Cache sweep occurred:', message);
});

process.on('unhandledRejection', error => {
	logger.error('Unhandled promise rejection:', error);
});

logger.info('Setting up event handlers...');

client.once(Events.ClientReady, async readyClient => {
	logger.info(`Ready! Logged in as ${readyClient.user.tag}`);
	
	// Initialize database connection
	try {
		logger.info('Initializing database connection...');
		await getConnection();
		logger.info('Database connection initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize database connection:', error);
		// Continue startup even if database fails - some features will be disabled
	}
	
	// Initialize voice service
	try {
		logger.info('Initializing voice service...');
		const VoiceService = require('./services/voice');
		client.voiceService = new VoiceService(config);
		await client.voiceService.initialize();
		logger.info('Voice service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize voice service:', error);
		process.exit(1);
	}

	// Initialize automation service
	try {
		logger.info('Initializing automation service...');
		const AutomationService = require('./services/automationService');
		client.automationService = new AutomationService(client);
		client.automationService.start();
		logger.info('Automation service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize automation service:', error);
		// Don't exit since this is not a critical service
		logger.info('Bot will continue without automation service');
	}

	// Initialize music service
	try {
		logger.info('Initializing music service...');
		client.musicService = new MusicService(config);
		logger.info('Music service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize music service:', error);
		// Don't exit since this is not a critical service
		logger.info('Bot will continue without music service');
	}

	// Ensure proper cleanup on shutdown
	process.on('SIGINT', () => {
		logger.info('Received SIGINT signal, cleaning up resources...');
		if (client.musicService) {
			client.musicService.dispose();
		}
		process.exit(0);
	});

	process.on('SIGTERM', () => {
		logger.info('Received SIGTERM signal, cleaning up resources...');
		if (client.musicService) {
			client.musicService.dispose();
		}
		process.exit(0);
	});
});

client.on(Events.InteractionCreate, async interaction => {
	if (!interaction.isChatInputCommand()) return;

	const command = client.commands.get(interaction.commandName);

	if (!command) {
		logger.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		// Pass voice service to commands that need it
		if (['transcribe', 'voice', 'speak'].includes(interaction.commandName)) {
			if (!client.voiceService) {
				await interaction.reply({ content: 'Voice service is not initialized. Please try again later.', ephemeral: true });
				return;
			}
			await command.execute(interaction, client.voiceService);
		} 
		// Pass music service to music-related commands
		else if (['playmusic', 'stopmusic', 'generateallmusic', 'generatemusic'].includes(interaction.commandName)) {
			if (!client.musicService) {
				await interaction.reply({ content: 'Music service is not initialized. Please try again later.', ephemeral: true });
				return;
			}
			await command.execute(interaction, client.musicService);
		} else {
			await command.execute(interaction);
		}
	} catch (error) {
		logger.error(`Error in ${interaction.commandName} command:`, error);
		const errorMessage = 'There was an error while executing this command!';
		try {
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: errorMessage, ephemeral: true });
			} else {
				await interaction.reply({ content: errorMessage, ephemeral: true });
			}
		} catch (e) {
			logger.error('Error sending error message:', e);
		}
	}

	// Add button interaction handling with consistent error handling
	if (interaction.isButton()) {
		const [action, type, requestId] = interaction.customId.split('_');
		
		if (type === 'search') {
			const AISearchHandler = require('./utils/aiSearchHandler');
			const { getPromptWithGuildPersonality } = require('./utils/memeMode');
			const { OpenAI } = require('openai');
			const config = require('./config.json');
			const openai = new OpenAI({ apiKey: config.openaiKey });
			
			try {
				if (action === 'approve') {
					const request = AISearchHandler.getPendingRequest(requestId);
					
					if (!request) {
						await interaction.reply({
							content: '❌ This search request has expired or was already handled.',
							ephemeral: true,
							allowedMentions: { users: [], roles: [] }
						});
						return;
					}

					await interaction.deferUpdate();
					const result = await AISearchHandler.handleSearchApproval(requestId, interaction);
					
					if (result) {
						// Get system prompt with meme mode and guild personality context
						const guildId = interaction.guild?.id;
						const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
						
						// Generate response with meme mode and guild personality
						const completion = await openai.chat.completions.create({
							messages: [
								{ role: 'system', content: systemPrompt },
								{ role: 'user', content: request.query },
								{ role: 'system', content: `Here is relevant information: ${result.result}` }
							],
							model: "gpt-4o",
							temperature: 0.7,
							max_tokens: 500
						});

						const response = completion.choices[0].message.content;
						await interaction.followUp({
							content: response,
							allowedMentions: { users: [], roles: [] }
						});
					} else {
						await interaction.followUp({
							content: '❌ Failed to execute search. Please try again.',
							ephemeral: true,
							allowedMentions: { users: [], roles: [] }
						});
					}
				}

				if (action === 'deny') {
					await interaction.deferUpdate();
					await AISearchHandler.handleSearchDenial(requestId, interaction);
				}
			} catch (error) {
				logger.error('Search interaction error:', {
					action,
					requestId,
					error: error.message || 'Unknown error',
					stack: error.stack || 'No stack trace available'
				});

				try {
					const errorMessage = '❌ Error processing search request.';
					if (interaction.deferred) {
						await interaction.followUp({
							content: errorMessage,
							ephemeral: true,
							allowedMentions: { users: [], roles: [] }
						});
					} else {
						await interaction.reply({
							content: errorMessage,
							ephemeral: true,
							allowedMentions: { users: [], roles: [] }
						});
					}
				} catch (replyError) {
					logger.error('Failed to send search error message:', {
						error: replyError.message,
						stack: replyError.stack,
						originalError: error.message
					});
				}
			}
		}
	}
});

// Add reaction handlers
client.on('messageReactionAdd', async (reaction, user) => {
	logger.debug('Raw reaction event received:', {
		emoji: reaction.emoji.name,
		partial: reaction.partial,
		user: user.tag
	});
	
	try {
		// Partial reactions need to be fetched
		if (reaction.partial) {
			logger.debug('Fetching partial reaction');
			await reaction.fetch();
		}
		
		// Check permissions before handling
		const permissions = reaction.message.guild.members.me.permissions;
		logger.debug('Bot permissions:', {
			manageMessages: permissions.has('ManageMessages'),
			addReactions: permissions.has('AddReactions'),
			readMessageHistory: permissions.has('ReadMessageHistory')
		});
		
		await handleReactionAdd(reaction, user);
	} catch (error) {
		logger.error('Error handling reaction add:', error);
	}
});

client.on('messageReactionRemove', async (reaction, user) => {
	try {
		// Partial reactions need to be fetched
		if (reaction.partial) {
			await reaction.fetch();
		}
		await handleReactionRemove(reaction, user);
	} catch (error) {
		logger.error('Error handling reaction remove:', error);
	}
});

// Add voice state tracking
client.on('voiceStateUpdate', async (oldState, newState) => {
	try {
		if (!client.voiceService) return;

		// Handle bot disconnection
		if (oldState.member.id === client.user.id && !newState.channel) {
			if (client.voiceService.sessionManager && client.voiceService.sessionManager.sessions) {
				const userIds = Array.from(client.voiceService.sessionManager.sessions.keys());
				for (const userId of userIds) {
					await client.voiceService.stopListening(userId);
				}
			}
		}

		// Handle user leaving voice channel
		if (oldState.channel && !newState.channel) {
			if (client.voiceService.sessionManager) {
				const session = client.voiceService.sessionManager.getSession?.(oldState.member.id);
				if (session) {
					await client.voiceService.stopListening(oldState.member.id);
				}
			}
		}
	} catch (error) {
		logger.error('Error handling voice state update:', error);
	}
});

// Add connection debugging
client.on('debug', console.log);
client.on('warn', console.log);

// Add error handling for the WebSocket connection
client.on('shardError', error => {
	logger.error('WebSocket connection error:', error);
});

client.ws.on('close', (event) => {
	logger.log('WebSocket closed:', event);
});

// Graceful shutdown handling
const shutdown = async () => {
	logger.info('Shutting down...');
	try {
		if (client.voiceService) {
			logger.debug('Cleaning up voice service...');
			await client.voiceService.cleanup();
			logger.debug('Voice service cleanup complete');
		}
		if (client.automationService) {
			logger.debug('Stopping automation service...');
			client.automationService.stop();
			logger.debug('Automation service stopped');
		}
		if (client.musicService) {
			logger.debug('Cleaning up music service...');
			client.musicService.dispose();
			logger.debug('Music service cleanup complete');
		}
		
		// Close database connection
		logger.debug('Closing database connection...');
		try {
			await closeConnection();
			logger.debug('Database connection closed successfully');
		} catch (dbError) {
			logger.error('Error closing database connection:', dbError);
		}
		
	} catch (error) {
		logger.error('Error during shutdown:', error);
	} finally {
		process.exit();
	}
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logger.info('Attempting to log in...');

try {
	const configValidation = validateConfig(config);
	if (!configValidation.isValid) {
		logger.error('Configuration validation failed:', configValidation.errors);
		throw new Error('Invalid configuration: ' + configValidation.errors.join(', '));
	}

	client.login(config.token).catch(error => {
		logger.error('Failed to log in:', error);
		process.exit(1);
	});
} catch (error) {
	logger.error('Initialization failed:', error);
	process.exit(1);
}

// TODO: Add proper error handling for Azure Speech Service initialization failure
// TODO: Add graceful shutdown handling for voice connections
// TODO: Add retry mechanism for failed guild command deployments
// TODO: Add proper error handling for button interactions outside of search
// TODO: Add proper cleanup for voice sessions on bot restart
// TODO: Add health check endpoint for Docker container
// TODO: Add monitoring for WebSocket connection stability
// TODO: Add proper handling for Discord API rate limits
// TODO: Add proper handling for voice state updates
// TODO: Add proper handling for partial reactions in DMs
