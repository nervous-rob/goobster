// A staged revision the manager runs this with deploys the staged feature set.
require('@goobster/core/runtime/lifecycle').boot({ worker: 'bot' });

const { REST, Routes, RateLimitError } = require('discord.js');
const path = require('node:path');
const { validateConfig } = require('@goobster/core/utils/configValidator');
const config = require('@goobster/core/config/configJson').load();

const { clientId, guildIds, token } = config;

// Per-target hashes of the last acknowledged deployment live in
// <dataDir>/command-deploy.json. An unchanged target skips the Discord API
// call entirely - important on devices that restart often (power loss on a
// Raspberry Pi), since command registration is aggressively rate limited.
const DATA_DIR = require('@goobster/core/runtimePaths').dataDir;
const FORCE_DEPLOY = process.argv.includes('--force');

// Payload assembly is shared with scripts/verify-global-commands.js and
// tests/globalCommandPayload.test.js so what we validate is what we ship.
const {
	collectCommandPayloads,
	computeDeployHash,
	deployCommandsIfChanged,
	featureCommandFilter,
	validateGlobalCommandPayload
} = require('@goobster/core/utils/commandDeployment');

// The same filter the bot's command loader uses: a command whose feature is
// not active is left out of the payload, and the bulk overwrite below removes
// it from Discord.
const { guildCommands, globalCommands, skipped } = collectCommandPayloads(
	path.join(__dirname, 'commands'),
	{ log: console.log, filter: featureCommandFilter }
);
if (skipped.length > 0) {
	console.log(`Commands left out because their feature is not active: ${skipped.map(entry => entry.key).join(', ')}`);
}

console.log(`Total commands to deploy: ${guildCommands.length} guild-only, ${globalCommands.length} global (DM-enabled)`);
console.log('Guild command names:', guildCommands.map(cmd => cmd.name));
console.log('Global command names:', globalCommands.map(cmd => cmd.name));

// Catch structural payload problems before touching the API
const payloadIssues = validateGlobalCommandPayload(globalCommands);
if (payloadIssues.length > 0) {
	console.error('Global command payload is invalid:', payloadIssues);
	process.exit(1);
}

// Each target hash covers its payload, its scope and the active feature set,
// so enabling or disabling a feature always re-syncs Discord. The combined
// hash is what the legacy .command-deploy-hash file recorded.
const legacyHash = computeDeployHash({ clientId, guildIds, guildCommands, globalCommands });

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

			// Guild-only commands go to each guild; DM-enabled ones are
			// registered globally (up to an hour to propagate the first
			// time), carrying the Activity Entry Point command through
			// unchanged (API error 50240).
			const outcome = await deployCommandsIfChanged({
				rest,
				routes: Routes,
				clientId,
				guildIds,
				guildCommands,
				globalCommands,
				dataDir: DATA_DIR,
				legacyHash,
				force: FORCE_DEPLOY,
				log: console.log
			});
			if (outcome.skipped.length > 0) {
				console.log(`Unchanged since the last acknowledged deployment, skipped: ${outcome.skipped.join(', ')} (use --force to override).`);
			}
			for (const { key, error } of outcome.failed) {
				console.error(`Failed to deploy commands to ${key}:`, error);
				if (error.code === 50001) {
					console.error('Missing permissions in guild. Bot needs applications.commands scope.');
				} else if (error.code === 50013) {
					console.error('Missing permissions in guild. Bot needs Manage Server permission.');
				}
			}
			if (outcome.failed.length > 0) throw outcome.failed[0].error;
			console.log('All command deployments completed');

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
