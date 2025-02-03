// TODO: Add retry mechanism for failed guild command deployments
// TODO: Add proper error handling for deployment failures
// TODO: Add proper validation for command data before deployment
// TODO: Add proper cleanup for old/unused commands
// TODO: Add proper handling for rate limits during deployment
// TODO: Add proper logging for deployment process
// TODO: Add proper validation for guild permissions before deployment

const { REST, Routes } = require('discord.js');
const { clientId, guildIds, token } = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
const { validateConfig } = require('./utils/configValidator');
const config = require('./config.json');

const commands = [];
// Grab all the command folders from the commands directory you created earlier
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	// Grab all the command files from the commands directory you created earlier
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter(file => 
		file.endsWith('.js') && !file.startsWith('config')
	);
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

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(token);

// Add config validation to deployment
try {
	const configValidation = validateConfig(config);
	if (!configValidation.isValid) {
		console.error('Configuration validation failed:', configValidation.errors);
		process.exit(1);
	}

	// and deploy your commands!
	(async () => {
		try {
			console.log(`Started refreshing application (/) commands.`);

			// Deploy to each guild
			const deployPromises = guildIds.map(async guildId => {
				try {
					const data = await rest.put(
						Routes.applicationGuildCommands(clientId, guildId),
						{ body: commands }
					);
					console.log(`Successfully reloaded commands for guild ${guildId}`);
					return data;
				} catch (error) {
					console.error(`Failed to deploy commands to guild ${guildId}:`, error);
					throw error; // Re-throw to be caught by the outer try-catch
				}
			});

			// Wait for all deployments to complete
			await Promise.all(deployPromises);
			console.log('All command deployments completed');
			
			// Explicitly exit the process after completion
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

// Add error handlers for uncaught exceptions
process.on('unhandledRejection', error => {
	console.error('Unhandled promise rejection:', error);
	process.exit(1);
});

process.on('uncaughtException', error => {
	console.error('Uncaught exception:', error);
	process.exit(1);
});
