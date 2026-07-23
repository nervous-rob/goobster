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

// Payload assembly is shared with scripts/verify-global-commands.js and
// tests/globalCommandPayload.test.js so what we validate is what we ship.
const {
	collectCommandPayloads,
	mergeEntryPointCommands,
	validateGlobalCommandPayload
} = require('./utils/commandDeployment');

const { guildCommands, globalCommands } = collectCommandPayloads(
	path.join(__dirname, 'commands'),
	{ log: console.log }
);

console.log(`Total commands to deploy: ${guildCommands.length} guild-only, ${globalCommands.length} global (DM-enabled)`);
console.log('Guild command names:', guildCommands.map(cmd => cmd.name));
console.log('Global command names:', globalCommands.map(cmd => cmd.name));

// Catch structural payload problems before touching the API
const payloadIssues = validateGlobalCommandPayload(globalCommands);
if (payloadIssues.length > 0) {
	console.error('Global command payload is invalid:', payloadIssues);
	process.exit(1);
}

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
					const body = mergeEntryPointCommands(existingGlobal, globalCommands);
					const preservedCount = body.length - globalCommands.length;
					if (preservedCount > 0) {
						console.log(`Preserving ${preservedCount} Entry Point command(s):`, body.slice(0, preservedCount).map(cmd => cmd.name));
					}

					const data = await rest.put(
						Routes.applicationCommands(clientId),
						{ body }
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
