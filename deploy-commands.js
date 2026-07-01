const { REST, Routes } = require('discord.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateConfig } = require('./utils/configValidator');
const config = require('./config.json');

const { clientId, guildIds, token } = config;

// Cache file storing a hash of the last successful deployment. Skips the
// Discord API call entirely when nothing changed - important on devices that
// restart often (power loss on a Raspberry Pi), since command registration is
// aggressively rate limited by Discord.
const DEPLOY_CACHE_FILE = path.join(__dirname, 'data', '.command-deploy-hash');
const FORCE_DEPLOY = process.argv.includes('--force');

const commands = [];
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

console.log('Found command folders:', commandFolders);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter(file =>
		file.endsWith('.js') && !file.startsWith('config')
	);
	console.log(`Found ${commandFiles.length} commands in folder ${folder}:`, commandFiles);

	// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		if ('data' in command && 'execute' in command) {
			commands.push(command.data.toJSON());
		} else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

console.log(`Total commands to deploy: ${commands.length}`);
console.log('Command names:', commands.map(cmd => cmd.name));

/**
 * Compute a stable hash of the full command payload plus deployment targets.
 * @returns {string}
 */
function computeDeployHash() {
	const payload = JSON.stringify({ clientId, guildIds, commands });
	return crypto.createHash('sha256').update(payload).digest('hex');
}

const deployHash = computeDeployHash();

if (!FORCE_DEPLOY) {
	try {
		const previousHash = fs.readFileSync(DEPLOY_CACHE_FILE, 'utf8').trim();
		if (previousHash === deployHash) {
			console.log('Slash commands unchanged since last deployment - skipping (use --force to override).');
			process.exit(0);
		}
	} catch {
		// No cache file yet - proceed with deployment.
	}
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(token);

try {
	const configValidation = validateConfig(config);
	if (!configValidation.isValid) {
		console.error('Configuration validation failed:', configValidation.errors);
		process.exit(1);
	}

	(async () => {
		try {
			console.log(`Started refreshing application (/) commands.`);
			console.log(`Client ID: ${clientId}`);
			console.log(`Guild IDs: ${guildIds.join(', ')}`);

			// Deploy to each guild
			const deployPromises = guildIds.map(async guildId => {
				try {
					console.log(`Deploying commands to guild ${guildId}...`);
					const data = await rest.put(
						Routes.applicationGuildCommands(clientId, guildId),
						{ body: commands }
					);
					console.log(`Successfully reloaded ${data.length} commands for guild ${guildId}`);
					return data;
				} catch (error) {
					console.error(`Failed to deploy commands to guild ${guildId}:`, error);
					if (error.code === 50001) {
						console.error('Missing permissions in guild. Bot needs applications.commands scope.');
					} else if (error.code === 50013) {
						console.error('Missing permissions in guild. Bot needs Manage Server permission.');
					}
					throw error;
				}
			});

			await Promise.all(deployPromises);
			console.log('All command deployments completed');

			// Record the successful deployment so unchanged restarts can skip it.
			fs.mkdirSync(path.dirname(DEPLOY_CACHE_FILE), { recursive: true });
			fs.writeFileSync(DEPLOY_CACHE_FILE, deployHash, 'utf8');

			process.exit(0);
		} catch (error) {
			console.error('Failed to deploy commands:', error);
			process.exit(1);
		}
	})();
} catch (error) {
	console.error('Configuration validation failed:', error);
	process.exit(1);
}

process.on('unhandledRejection', error => {
	console.error('Unhandled promise rejection:', error);
	process.exit(1);
});

process.on('uncaughtException', error => {
	console.error('Uncaught exception:', error);
	process.exit(1);
});
