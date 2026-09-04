const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const { startWebServers, closeWebServers } = require('./web/server');
const { validateConfig } = require('@goobster/core/utils/configValidator');
const { voiceService } = require('@goobster/core/services/serviceManager');
const { getConnection, closeConnection } = require('@goobster/core/db');
const { parseTrackName } = require('@goobster/core/utils/musicUtils');

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

// Shared winston logger (console + rotating files under logs/)
const logger = require('@goobster/core/utils/logger');

// Log startup mode
logger.info(`Starting bot in ${DEBUG_MODE ? 'debug' : 'normal'} mode`);

// Check if config file exists
const configPath = require('@goobster/core/runtimePaths').configJsonPath;
if (!fs.existsSync(configPath)) {
	logger.error('config.json not found! Please ensure the config file is present.');
	process.exit(1);
}

logger.info('Loading config...');
const config = require('../../config.json');
if (!config.token) {
	logger.error('Discord token not found in config.json!');
	process.exit(1);
}

// Optional integrations: one inventory at process start so Jest suites
// that require() providers do not each emit the same missing-key warning.
require('@goobster/core/config/reportIntegrations').reportIntegrations({ logger });

const { handleReactionAdd, handleReactionRemove } = require('@goobster/core/utils/chatHandler');

// Command-backed tools (playTrack, setNickname, speakMessage): core never
// imports app code, so hand the registry the command modules it drives.
require('@goobster/core/utils/toolsRegistry').registerCommandAdapters({
	playTrack: require('./commands/music/playtrack'),
	nickname: require('./commands/settings/nickname'),
	speak: require('./commands/chat/speak')
});

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

// Start the HTTP layer: /health for monitoring plus the localhost-only
// management panel. Panel routes check client.isReady() per request.
// startWebServers is async; keep the Promise so shutdown can await it.
const webServers = startWebServers({ client, voiceService, config, logger });
webServers.catch((error) => {
        logger.error('Failed to start HTTP servers:', error);
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
	
	// Initialize shared voice service (optional - bot continues without voice)
	try {
		logger.info('Initializing shared voice service...');
		if (!voiceService._isInitialized) {
			await voiceService.initialize();
		}
		logger.info('Shared voice service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize shared voice service:', error);
		logger.info('Bot will continue without voice features');
	}

	// Initialize automation service
	try {
		logger.info('Initializing automation service...');
		const AutomationService = require('@goobster/core/services/automationService');
		client.automationService = new AutomationService(client);
		client.automationService.start();
		logger.info('Automation service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize automation service:', error);
		// Don't exit since this is not a critical service
		logger.info('Bot will continue without automation service');
	}

	// Initialize heartbeat (proactive mode + follow-up delivery)
	try {
		logger.info('Initializing heartbeat service...');
		const HeartbeatService = require('@goobster/core/services/heartbeatService');
		client.heartbeatService = new HeartbeatService(client);
		client.heartbeatService.start();
		logger.info('Heartbeat service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize heartbeat service:', error);
		logger.info('Bot will continue without proactive features');
	}

	// Initialize the personal heartbeat (the attention system: open loops,
	// initiative policy, and condition-triggered watches). Idle until
	// somebody enables it with /attention.
	try {
		logger.info('Initializing personal heartbeat (attention)...');
		const PersonalHeartbeatService = require('@goobster/core/services/personalHeartbeatService');
		client.personalHeartbeatService = new PersonalHeartbeatService(client);
		client.personalHeartbeatService.start();
		logger.info('Personal heartbeat initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize personal heartbeat:', error);
		logger.info('Bot will continue without the attention system');
	}

	// Workshop pins → versioned project assets (Phase 2). Idempotent;
	// pins stay in web_applets with a migratedAssetId marker.
	try {
		const workshopPinMigration = require('@goobster/core/services/workshopPinMigration');
		const migrated = await workshopPinMigration.runOnStartup();
		if (migrated.acquired && (migrated.migrated > 0 || migrated.linked > 0)) {
			logger.info(`Workshop: migrated ${migrated.migrated} pin(s) `
				+ `(${migrated.linked} already-linked) across ${migrated.users} user(s)`);
		}
	} catch (error) {
		logger.error('Failed to migrate Workshop pins:', error);
		logger.info('Pins stay in the Workshop; migration retries on the next start');
	}

	// Resume Observatory jobs interrupted by the restart (checkpointed
	// background simulations pick back up instead of freezing forever)
	try {
		const observatoryService = require('@goobster/core/services/observatoryService');
		const resumedJobs = await observatoryService.autoResumeInterrupted({ client });
		if (resumedJobs.length > 0) {
			logger.info(`Observatory: auto-resumed ${resumedJobs.length} interrupted job(s): ${resumedJobs.join(', ')}`);
		}
	} catch (error) {
		logger.error('Failed to auto-resume Observatory jobs:', error);
		logger.info('Interrupted jobs stay resumable from the portal');
	}

	try {
		const projectMissionService = require('@goobster/core/services/projectMissionService');
		const repaired = await projectMissionService.reconcileStartingSteps({ olderThanMs: 0 });
		if (repaired > 0) {
			logger.info(`Missions: reconciled ${repaired} STARTING step(s) left by a previous process`);
		}
	} catch (error) {
		logger.error('Failed to reconcile Mission STARTING steps:', error);
	}

	// Project event triggers: jobs that settled while we were down (the
	// domain bus is not durable). Compare finishedAt against lastRun.
	try {
		const projectTriggerService = require('@goobster/core/services/projectTriggerService');
		const caughtUp = await projectTriggerService.catchUpEventTriggers({ client });
		if (caughtUp > 0) {
			logger.info(`Observatory: caught up ${caughtUp} project trigger fire(s) missed during downtime`);
		}
	} catch (error) {
		logger.error('Failed to catch up project triggers:', error);
	}

	// Spitball Expeditions: park runs interrupted by the restart (PAUSED,
	// owner can continue) and pick queued ones back up.
	try {
		const spitballExpeditionRunner = require('@goobster/core/services/spitballExpeditionRunner');
		const kicked = await spitballExpeditionRunner.start();
		if (kicked.length > 0) {
			logger.info(`Spitball: picked up ${kicked.length} queued expedition(s): ${kicked.join(', ')}`);
		}
	} catch (error) {
		logger.error('Failed to start the Spitball expedition runner:', error);
		logger.info('Bot will continue without expedition pickup');
	}

	// Initialize the Cursor agent run tracker (no-op when unconfigured)
	try {
		const AgentTrackerService = require('@goobster/core/services/agentTrackerService');
		client.agentTrackerService = new AgentTrackerService(client);
		client.agentTrackerService.start();
	} catch (error) {
		logger.error('Failed to initialize agent tracker service:', error);
		logger.info('Bot will continue without Cursor agent tracking');
	}

	// Initialize internal monologue (per-guild private thought process)
	try {
		logger.info('Initializing monologue service...');
		const MonologueService = require('@goobster/core/services/monologueService');
		client.monologueService = new MonologueService(client);
		client.monologueService.start();
		logger.info('Monologue service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize monologue service:', error);
		logger.info('Bot will continue without the internal monologue');
	}

	// Initialize the exchange risk engine (interest, expiries, resting orders,
	// margin calls, forced liquidation). Idle until a guild uses the exchange.
	try {
		logger.info('Initializing exchange risk engine...');
		const RiskEngine = require('@goobster/core/services/exchange/riskEngine');
		client.exchangeRiskEngine = new RiskEngine(client);
		client.exchangeRiskEngine.start();
		logger.info('Exchange risk engine initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize exchange risk engine:', error);
		logger.info('Bot will continue without automatic settlement and liquidation');
	}

	// Initialize nightly memory consolidation
	try {
		logger.info('Initializing memory consolidation service...');
		const memoryConsolidationService = require('@goobster/core/services/memoryConsolidationService');
		memoryConsolidationService.start();
		logger.info('Memory consolidation service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize memory consolidation service:', error);
		logger.info('Bot will continue without memory consolidation');
	}

	// Initialize knowledge reflection (scheduled graph enrichment; also
	// serves the web app's on-demand Reflect button)
	try {
		logger.info('Initializing knowledge reflection service...');
		const knowledgeReflectionService = require('@goobster/core/services/knowledgeReflectionService');
		knowledgeReflectionService.start();
		logger.info('Knowledge reflection service initialized successfully');
	} catch (error) {
		logger.error('Failed to initialize knowledge reflection service:', error);
		logger.info('Bot will continue without scheduled knowledge reflection');
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
	readyClient.on('musicTrackStarted', async (guildId, track) => {
		logger.info(`Music started in guild ${guildId}: ${track.name}`);
		activeMusicGuilds.set(guildId, { track, startedAt: new Date() });
		await updateGlobalPresence(readyClient);
	});

	readyClient.on('musicTrackEnded', async (guildId) => {
		logger.info(`Music ended in guild ${guildId}`);
		activeMusicGuilds.delete(guildId);
		await updateGlobalPresence(readyClient);
	});

	// Initial presence update
	await updateGlobalPresence(readyClient);
	// Shutdown cleanup is handled by the single SIGINT/SIGTERM handler below.
});

/**
 * Guard: guild-only commands invoked from a DM get a friendly refusal.
 * Defense-in-depth - guild-only commands aren't registered in DMs, but a
 * stale command cache or future registration change shouldn't crash them.
 * @returns {Promise<boolean>} whether the interaction was rejected
 */
async function rejectGuildOnlyCommandInDm(interaction, command) {
	if (interaction.guildId || command.dmAllowed) return false;

	try {
		await interaction.reply({
			content: 'This command only works inside a server. You can still chat with me right here - just send a message or use `/chat`!',
			ephemeral: true
		});
	} catch (error) {
		logger.error('Error rejecting guild-only command in DM:', error);
	}
	return true;
}

client.on(Events.InteractionCreate, async interaction => {
    // Handle autocomplete interactions first
    if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (command && typeof command.autocomplete === 'function') {
            try {
                await command.autocomplete(interaction);
            } catch (autoErr) {
                logger.error(`Autocomplete error in ${interaction.commandName}:`, autoErr);
            }
        }
        return; // Autocomplete interactions do not proceed to command execution
    }
	// Handle context menu commands
	if (interaction.isContextMenuCommand()) {
		const command = client.commands.get(interaction.commandName);
		if (!command) {
			logger.error(`No command matching ${interaction.commandName} was found.`);
			return;
		}

		if (await rejectGuildOnlyCommandInDm(interaction, command)) return;

		try {
			await command.execute(interaction);
		} catch (error) {
			logger.error(`Error executing context menu command ${interaction.commandName}:`, error);
			// 10062/40060: transient Discord interaction races - the token is
			// dead or the ack already landed, so no error message can be sent.
			if (error.code === 10062 || error.code === 40060) return;
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

	if (await rejectGuildOnlyCommandInDm(interaction, command)) return;

	try {
		// The shared music service is passed as a second argument; commands
		// that don't need it simply ignore it.
		await command.execute(interaction, client.musicService);
	} catch (error) {
		logger.error(`Error in ${interaction.commandName} command:`, error);
		// 10062/40060: transient Discord interaction races - the token is
		// dead or the ack already landed, so no error message can be sent.
		if (error.code === 10062 || error.code === 40060) return;
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
	// Note: button interactions (e.g. search approval) are handled by
	// events/interactionCreate.js, which is loaded by the events loader above.
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
		
		// Permission introspection only applies in guilds; DM reactions have no member object
		if (reaction.message.guild) {
			const permissions = reaction.message.guild.members.me.permissions;
			logger.debug('Bot permissions:', {
				manageMessages: permissions.has('ManageMessages'),
				addReactions: permissions.has('AddReactions'),
				readMessageHistory: permissions.has('ReadMessageHistory')
			});
		}
		
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

// Add error handling for the WebSocket connection
client.on('shardError', error => {
	logger.error('WebSocket connection error:', error);
});

client.ws.on('close', (event) => {
	logger.info(`WebSocket closed: ${typeof event === 'object' ? JSON.stringify(event) : event}`);
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
                if (client.heartbeatService) {
                        logger.debug('Stopping heartbeat service...');
                        client.heartbeatService.stop();
                        logger.debug('Heartbeat service stopped');
                }
                if (client.personalHeartbeatService) {
                        logger.debug('Stopping personal heartbeat...');
                        client.personalHeartbeatService.stop();
                        logger.debug('Personal heartbeat stopped');
                }
                if (client.agentTrackerService) {
                        logger.debug('Stopping agent tracker service...');
                        client.agentTrackerService.stop();
                        logger.debug('Agent tracker service stopped');
                }
                if (client.monologueService) {
                        logger.debug('Stopping monologue service...');
                        client.monologueService.stop();
                        logger.debug('Monologue service stopped');
                }
                if (client.exchangeRiskEngine) {
                        logger.debug('Stopping exchange risk engine...');
                        client.exchangeRiskEngine.stop();
                        logger.debug('Exchange risk engine stopped');
                }
                try {
                        require('@goobster/core/services/memoryConsolidationService').stop();
                } catch { /* not started */ }
                try {
                        require('@goobster/core/services/knowledgeReflectionService').stop();
                } catch { /* not started */ }

                if (idleStatusInterval) {
                        clearInterval(idleStatusInterval);
                }

                try {
                        logger.debug('Closing HTTP servers...');
                        await closeWebServers(webServers);
                        logger.debug('HTTP servers closed');
                } catch (webError) {
                        logger.error('Error closing HTTP servers:', webError);
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
	for (const warning of configValidation.warnings || []) {
		logger.warn(`Config: ${warning}`);
	}
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

// TODO: Add graceful shutdown handling for voice connections
// TODO: Add retry mechanism for failed guild command deployments
// TODO: Add proper error handling for button interactions outside of search
// TODO: Add proper cleanup for voice sessions on bot restart
// TODO: Add health check endpoint for Docker container
// TODO: Add monitoring for WebSocket connection stability
// TODO: Add proper handling for Discord API rate limits
// TODO: Add proper handling for voice state updates
// TODO: Add proper handling for partial reactions in DMs
