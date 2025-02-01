const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const { validateConfig } = require('./utils/configValidator');

// Check if config file exists
const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
	console.error('config.json not found! Please ensure the config file is present.');
	process.exit(1);
}

console.log('Loading config...');
const config = require('./config.json');
if (!config.token) {
	console.error('Discord token not found in config.json!');
	process.exit(1);
}

if (!config.azure?.speech?.key || !config.azure?.speech?.region) {
	console.error('Azure Speech credentials not found in config.json!');
	process.exit(1);
}

const { handleReactionAdd, handleReactionRemove } = require('./utils/chatHandler');

console.log('Starting bot initialization...');

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,  // Required for voice
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent     // If you need message content
	],
	ws: {
		properties: {
			$browser: "Discord iOS"  // Sometimes helps with voice connection
		}
	},
	// Enable partials for better event handling
	partials: [
		'MESSAGE',
		'CHANNEL',
		'REACTION',
		'USER',
		'GUILD_MEMBER',
		'VOICE_STATE'
	] 
});

console.log('Loading event handlers...');

// Load event handlers
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
	try {
		const filePath = path.join(eventsPath, file);
		console.log(`Loading event: ${file}`);
		const event = require(filePath);
		if (event.once) {
			client.once(event.name, (...args) => event.execute(...args));
		} else {
			client.on(event.name, (...args) => event.execute(...args));
		}
	} catch (error) {
		console.error(`Error loading event ${file}:`, error);
	}
}

console.log('Loading commands...');

client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	try {
		const commandsPath = path.join(foldersPath, folder);
		const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
		console.log(`Loading commands from folder: ${folder}`);
		for (const file of commandFiles) {
			const filePath = path.join(commandsPath, file);
			const command = require(filePath);
			if ('data' in command && 'execute' in command) {
				client.commands.set(command.data.name, command);
				console.log(`Loaded command: ${command.data.name}`);
			} else {
				console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
			}
		}
	} catch (error) {
		console.error(`Error loading commands from folder ${folder}:`, error);
	}
}

// Add error handling for the client
client.on('error', error => {
	console.error('Discord client error:', error);
});

client.on('warn', warning => {
	console.warn('Discord client warning:', warning);
});

client.on('debug', info => {
	if (!info.includes('Heartbeat')) {
		console.debug('Discord client debug:', info);
	}
});

process.on('unhandledRejection', error => {
	console.error('Unhandled promise rejection:', error);
});

console.log('Setting up event handlers...');

client.once(Events.ClientReady, readyClient => {
	console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
	if (!interaction.isChatInputCommand()) return;
	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(`Error executing command ${interaction.commandName}:`, error);
		const errorMessage = 'There was an error while executing this command!';
		try {
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: errorMessage, ephemeral: true });
			} else {
				await interaction.reply({ content: errorMessage, ephemeral: true });
			}
		} catch (replyError) {
			console.error('Error sending error message:', replyError);
		}
	}
});

// Add reaction handlers
client.on('messageReactionAdd', async (reaction, user) => {
	try {
		// Partial reactions need to be fetched
		if (reaction.partial) {
			await reaction.fetch();
		}
		await handleReactionAdd(reaction, user);
	} catch (error) {
		console.error('Error handling reaction add:', error);
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
		console.error('Error handling reaction remove:', error);
	}
});

// Add voice state tracking
client.on('voiceStateUpdate', async (oldState, newState) => {
	try {
		const voiceCommand = client.commands.get('transcribe');
		if (!voiceCommand?.voiceService) return;

		// Handle bot disconnection
		if (oldState.member.id === client.user.id && !newState.channel) {
			const userId = Array.from(voiceCommand.voiceService.sessionManager.sessions.keys())[0];
			if (userId) {
				await voiceCommand.voiceService.stopListening(userId);
			}
		}

		// Handle user leaving voice channel
		if (oldState.channel && !newState.channel) {
			const session = voiceCommand.voiceService.sessionManager.getSession(oldState.member.id);
			if (session) {
				await voiceCommand.voiceService.stopListening(oldState.member.id);
			}
		}
	} catch (error) {
		console.error('Error handling voice state update:', error);
	}
});

// Add connection debugging
client.on('debug', console.log);
client.on('warn', console.log);

// Add error handling for the WebSocket connection
client.on('shardError', error => {
	console.error('WebSocket connection error:', error);
});

client.ws.on('close', (event) => {
	console.log('WebSocket closed:', event);
});

// Graceful shutdown handling
async function shutdown() {
	console.log('Shutting down...');
	try {
		// Cleanup voice services
		const voiceCommand = client.commands.get('transcribe');
		if (voiceCommand?.voiceService) {
			console.log('Cleaning up voice service...');
			await voiceCommand.voiceService.cleanup();
		}

		// Destroy the client
		console.log('Destroying Discord client...');
		client.destroy();
		
		console.log('Shutdown complete');
		process.exit(0);
	} catch (error) {
		console.error('Error during shutdown:', error);
		process.exit(1);
	}
}

// Handle shutdown signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('Attempting to log in...');

try {
	const configValidation = validateConfig(config);
	if (!configValidation.isValid) {
		console.error('Configuration validation failed:', configValidation.errors);
		throw new Error('Invalid configuration: ' + configValidation.errors.join(', '));
	}

	client.login(config.token).catch(error => {
		console.error('Failed to log in:', error);
		process.exit(1);
	});
} catch (error) {
	console.error('Initialization failed:', error);
	process.exit(1);
}
