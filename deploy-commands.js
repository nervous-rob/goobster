const { REST, Routes, RateLimitError } = require('discord.js');
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

// Interaction contexts for DM-enabled commands (raw API values):
// 0 = GUILD, 1 = BOT_DM, 2 = PRIVATE_CHANNEL.
const ALL_CONTEXTS = [0, 1, 2];
// 0 = GUILD_INSTALL (the bot must share a server with the user)
const GUILD_INSTALL = [0];

// Commands flagged dmAllowed are registered ONCE globally (they show up in
// guilds AND in the bot's DMs); everything else stays guild-registered so it
// never appears in a DM. A command must never be in both sets or it would
// show up twice in guilds.
const guildCommands = [];
const globalCommands = [];
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
			if (command.dmAllowed) {
				globalCommands.push({
					...command.data.toJSON(),
					contexts: ALL_CONTEXTS,
					integration_types: GUILD_INSTALL
				});
			} else {
				guildCommands.push(command.data.toJSON());
			}
		} else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

console.log(`Total commands to deploy: ${guildCommands.length} guild-only, ${globalCommands.length} global (DM-enabled)`);
console.log('Guild command names:', guildCommands.map(cmd => cmd.name));
console.log('Global command names:', globalCommands.map(cmd => cmd.name));

/**
 * Compute a stable hash of the full command payload plus deployment targets.
 * @returns {string}
 */
function computeDeployHash() {
	const payload = JSON.stringify({ clientId, guildIds, guildCommands, globalCommands });
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

// Construct and prepare an instance of the REST module.
//
// Registration must never wedge startup (systemd kills a hung ExecStartPre
// and the bot never boots): requests get a bounded timeout, and instead of
// silently sleeping on a long Discord rate limit (the default behavior),
// the request rejects with RateLimitError so we can log it and move on.
const LONG_RATE_LIMIT_MS = 25 * 1000;
const rest = new REST({
	timeout: 15_000,
	retries: 1,
	rejectOnRateLimit: (rateLimitData) => rateLimitData.timeToReset > LONG_RATE_LIMIT_MS
}).setToken(token);

rest.on('rateLimited', (rateLimitData) => {
	console.warn('Discord rate limit hit during command registration:', {
		route: rateLimitData.route,
		global: rateLimitData.global,
		timeToResetMs: rateLimitData.timeToReset
	});
});

try {
	const configValidation = validateConfig(config);
	if (!configValidation.isValid) {
		console.error('Configuration validation failed:', configValidation.errors);
		process.exit(1);
	}

	(async () => {
		// Watchdog: if Discord is slow or rate limiting beyond all the
		// bounds above, start the bot anyway with the previously registered
		// commands. The deploy hash is not written, so registration is
		// retried on the next boot.
		setTimeout(() => {
			console.warn('Command registration did not finish within 60s - continuing startup with previously registered commands (will retry on next boot).');
			process.exit(0);
		}, 60_000);

		try {
			console.log(`Started refreshing application (/) commands.`);
			console.log(`Client ID: ${clientId}`);
			console.log(`Guild IDs: ${guildIds.join(', ')}`);

			// Deploy guild-only commands to each guild
			const deployPromises = guildIds.map(async guildId => {
				try {
					console.log(`Deploying commands to guild ${guildId}...`);
					const data = await rest.put(
						Routes.applicationGuildCommands(clientId, guildId),
						{ body: guildCommands }
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

			// DM-enabled commands are registered globally (may take up to an
			// hour to propagate everywhere on first deployment).
			deployPromises.push((async () => {
				try {
					console.log('Deploying global (DM-enabled) commands...');

					// Apps with an Activity have a PRIMARY_ENTRY_POINT command
					// (type 4, the Activity "Launch" command) that a bulk
					// update must not remove (API error 50240). Fetch the
					// existing global commands and carry it through unchanged.
					const existingGlobal = await rest.get(Routes.applicationCommands(clientId));
					const entryPointCommands = existingGlobal.filter(cmd => cmd.type === 4);
					if (entryPointCommands.length > 0) {
						console.log(`Preserving ${entryPointCommands.length} Entry Point command(s):`, entryPointCommands.map(cmd => cmd.name));
					}

					const data = await rest.put(
						Routes.applicationCommands(clientId),
						{ body: [...entryPointCommands, ...globalCommands] }
					);
					console.log(`Successfully reloaded ${data.length} global commands`);
					return data;
				} catch (error) {
					console.error('Failed to deploy global commands:', error);
					throw error;
				}
			})());

			await Promise.all(deployPromises);
			console.log('All command deployments completed');

			// Record the successful deployment so unchanged restarts can skip it.
			fs.mkdirSync(path.dirname(DEPLOY_CACHE_FILE), { recursive: true });
			fs.writeFileSync(DEPLOY_CACHE_FILE, deployHash, 'utf8');

			process.exit(0);
		} catch (error) {
			// A rate-limited or timed-out registration is not fatal: the
			// commands registered on the last successful boot keep working.
			// Exit 0 (without writing the deploy hash) so the bot starts
			// and registration is retried on the next boot.
			if (error instanceof RateLimitError || error.name === 'AbortError') {
				console.warn(
					'Discord rate limited (or timed out) command registration - ' +
					'continuing startup with previously registered commands (will retry on next boot).',
					error.message
				);
				process.exit(0);
			}
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
