const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Client, Collection, Events, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const { validateConfig } = require('./utils/configValidator');
const { voiceService } = require('./services/serviceManager');
const MusicService = require('./services/voice/musicService');
const { getConnection, closeConnection } = require('./azureDb');
const { parseTrackName } = require('./utils/musicUtils');
const aiService = require('./services/aiService');

// Fun idle status messages when no music is playing
const idleStatusMessages = [
    'Pondering the orb',
    'Listening to the voices in my head',
    "Moderating a debate between the server's dust bunnies",
    'Staring into the void',
    'Dreaming of electric sheep',
    'Trying to remember a punchline'
];

// Interval to rotate idle status (10 minutes)
const IDLE_STATUS_INTERVAL_MS = 10 * 60 * 1000;
let idleStatusInterval = null;

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
                        type: ActivityType.Custom,
                        name: idleStatusMessages[0],
                        state: idleStatusMessages[0]
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

// --> ADDED: Global Music Presence Tracker <--
const activeMusicGuilds = new Map(); // Map<guildId, { track: object, startedAt: Date }>

async function updateGlobalPresence(client) {
	let latestGuild = null;
	let latestTime = null;

	// Find the guild that started music most recently
	for (const [guildId, data] of activeMusicGuilds.entries()) {
		if (!latestTime || data.startedAt > latestTime) {
			latestTime = data.startedAt;
			latestGuild = data;
		}
	}

        if (latestGuild && latestGuild.track) {
                const trackInfo = parseTrackName(latestGuild.track.name);
                // Stop rotating idle status while music is playing
                if (idleStatusInterval) {
                        clearInterval(idleStatusInterval);
                        idleStatusInterval = null;
                }
                await client.user.setPresence({
                        activities: [{
                                name: `${trackInfo.artist} - ${trackInfo.title}`,
                                type: 2 // LISTENING
                        }],
                        status: 'online'
                });
                logger.info(`Global presence updated: Listening to ${trackInfo.title}`);
        } else {
                // No guilds playing music, set a fun idle status
                const message = idleStatusMessages[Math.floor(Math.random() * idleStatusMessages.length)];
                await client.user.setPresence({
                        activities: [{
                                type: ActivityType.Custom,
                                name: message,
                                state: message
                        }],
                        status: 'online'
                });
                logger.info('Global presence reset to idle state.');

                // Start rotating idle status if not already running
                if (!idleStatusInterval) {
                        idleStatusInterval = setInterval(async () => {
                                try {
                                        if (activeMusicGuilds.size === 0) {
                                                const msg = idleStatusMessages[Math.floor(Math.random() * idleStatusMessages.length)];
                                                await client.user.setPresence({
                                                        activities: [{ type: ActivityType.Custom, name: msg, state: msg }],
                                                        status: 'online'
                                                });
                                                logger.info(`Idle presence rotated to: ${msg}`);
                                        }
                                } catch (err) {
                                        logger.error('Error rotating idle presence:', err);
                                }
                        }, IDLE_STATUS_INTERVAL_MS);
                }
        }
}

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
	
	// Initialize shared voice service
	try {
		logger.info('Initializing shared voice service...');
		if (!voiceService._isInitialized) {
			await voiceService.initialize();
		}
		logger.info('Shared voice service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize shared voice service:', error);
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

	// Initialize music service (using the shared voiceService)
	try {
		logger.info('Initializing shared music service...');
		client.musicService = voiceService.musicService;
		if (client.musicService) {
			client.musicService.setClient(readyClient);
			logger.info('Shared music service initialized and client set successfully');
		} else {
			logger.error('Failed to access music service from shared voice service.');
		}
	} catch (error) {
		logger.error('Failed to initialize music service:', error);
		logger.info('Bot will continue without music service features tied to client events.');
	}

	// --> ADDED: Event listeners for music presence <--
	readyClient.on('musicTrackStarted', (guildId, track) => {
		logger.info(`Music started in guild ${guildId}: ${track.name}`);
		activeMusicGuilds.set(guildId, { track, startedAt: new Date() });
		updateGlobalPresence(readyClient);
	});

	readyClient.on('musicTrackEnded', (guildId) => {
		logger.info(`Music ended in guild ${guildId}`);
		activeMusicGuilds.delete(guildId);
		updateGlobalPresence(readyClient);
	});

	// Initial presence update
	updateGlobalPresence(readyClient);

	// Ensure proper cleanup on shutdown
        process.on('SIGINT', () => {
                logger.info('Received SIGINT signal, cleaning up resources...');
                if (client.musicService) {
                        client.musicService.dispose();
                }
                if (idleStatusInterval) {
                        clearInterval(idleStatusInterval);
                }
                process.exit(0);
        });

        process.on('SIGTERM', () => {
                logger.info('Received SIGTERM signal, cleaning up resources...');
                if (client.musicService) {
                        client.musicService.dispose();
                }
                if (idleStatusInterval) {
                        clearInterval(idleStatusInterval);
                }
                process.exit(0);
        });
});

client.on(Events.InteractionCreate, async interaction => {
	// Handle context menu commands
	if (interaction.isContextMenuCommand()) {
		const command = client.commands.get(interaction.commandName);
		if (!command) {
			logger.error(`No command matching ${interaction.commandName} was found.`);
			return;
		}

		try {
			await command.execute(interaction);
		} catch (error) {
			logger.error(`Error executing context menu command ${interaction.commandName}:`, error);
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
		return;
	}

	if (!interaction.isChatInputCommand()) return;

	const command = client.commands.get(interaction.commandName);

	if (!command) {
		logger.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		// Pass voice service to commands that need it
		if (['transcribe', 'voice', 'speak'].includes(interaction.commandName)) {
			await command.execute(interaction);
		}
		// Pass music service to music-related commands
		else if (['playtrack', 'playmusic', 'stopmusic', 'generateallmusic', 'generatemusic'].includes(interaction.commandName)) {
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
						const response = await aiService.chat([
							{ role: 'system', content: systemPrompt },
							{ role: 'user', content: request.query },
							{ role: 'system', content: `Here is relevant information: ${result.result}` }
						], {
							preset: 'chat',
							max_tokens: 500
						});

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
		if (!client.musicService) return;

		// Handle bot disconnection
		if (oldState.member.id === client.user.id && !newState.channel) {
			if (client.musicService.sessionManager && client.musicService.sessionManager.sessions) {
				const userIds = Array.from(client.musicService.sessionManager.sessions.keys());
				for (const userId of userIds) {
					await client.musicService.stopListening(userId);
				}
			}
		}

		// Handle user leaving voice channel
		if (oldState.channel && !newState.channel) {
			if (client.musicService.sessionManager) {
				const session = client.musicService.sessionManager.getSession?.(oldState.member.id);
				if (session) {
					await client.musicService.stopListening(oldState.member.id);
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
                if (client.musicService) {
                        logger.debug('Cleaning up music service...');
                        client.musicService.dispose();
                        logger.debug('Music service cleanup complete');
                }
                if (client.automationService) {
                        logger.debug('Stopping automation service...');
                        client.automationService.stop();
                        logger.debug('Automation service stopped');
                }

                if (idleStatusInterval) {
                        clearInterval(idleStatusInterval);
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
