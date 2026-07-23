/**
 * Command deployment payload assembly, shared by deploy-commands.js, the
 * verification script (scripts/verify-global-commands.js), and the payload
 * spec (tests/globalCommandPayload.test.js).
 *
 * Commands flagged dmAllowed are registered ONCE globally (they show up in
 * guilds AND in the bot's DMs); everything else stays guild-registered so it
 * never appears in a DM. A command must never be in both sets or it would
 * show up twice in guilds.
 */
const fs = require('node:fs');
const path = require('node:path');

// Interaction contexts (raw API values): 0 = GUILD, 1 = BOT_DM,
// 2 = PRIVATE_CHANNEL. [0, 1, 2] is Discord's documented default for
// global commands; PRIVATE_CHANNEL is inert until the app supports
// user-installs.
const ALL_CONTEXTS = [0, 1, 2];
// Installation contexts: 0 = GUILD_INSTALL (the bot must share a server
// with the user).
const GUILD_INSTALL = [0];
// Application command type 4 = PRIMARY_ENTRY_POINT (the Activity "Launch"
// command, present on apps with an Activity enabled).
const ENTRY_POINT_TYPE = 4;

/**
 * Load every command module and split the deployment payloads into the
 * guild-registered set and the global (DM-enabled) set.
 * @param {string} foldersPath - Absolute path to the commands/ directory
 * @param {Object} [options] - { log } optional logger (console.log-style)
 * @returns {{ guildCommands: Object[], globalCommands: Object[] }}
 */
function collectCommandPayloads(foldersPath, { log = () => {} } = {}) {
    const guildCommands = [];
    const globalCommands = [];
    const commandFolders = fs.readdirSync(foldersPath);
    log('Found command folders:', commandFolders);

    for (const folder of commandFolders) {
        const commandsPath = path.join(foldersPath, folder);
        const commandFiles = fs.readdirSync(commandsPath).filter(file =>
            file.endsWith('.js') && !file.startsWith('config')
        );
        log(`Found ${commandFiles.length} commands in folder ${folder}:`, commandFiles);

        for (const file of commandFiles) {
            // resolve() so a relative foldersPath can't be mistaken for a
            // node_modules specifier by require()
            const filePath = path.resolve(commandsPath, file);
            const command = require(filePath);
            if ('data' in command && 'execute' in command) {
                if (command.dmAllowed) {
                    const json = {
                        ...command.data.toJSON(),
                        contexts: ALL_CONTEXTS,
                        integration_types: GUILD_INSTALL
                    };
                    // dm_permission is deprecated and superseded by
                    // contexts - never send both on the same command.
                    delete json.dm_permission;
                    globalCommands.push(json);
                } else {
                    guildCommands.push(command.data.toJSON());
                }
            } else {
                log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
            }
        }
    }

    return { guildCommands, globalCommands };
}

/**
 * Bulk-overwriting global commands may not remove the app's Entry Point
 * command (API error 50240): carry any existing Entry Point commands
 * through the update unchanged.
 * @param {Object[]} existingGlobalCommands - GET /applications/:id/commands result
 * @param {Object[]} globalCommands - the new global command payloads
 * @returns {Object[]} bulk-overwrite body
 */
function mergeEntryPointCommands(existingGlobalCommands, globalCommands) {
    const entryPointCommands = (existingGlobalCommands || [])
        .filter(cmd => cmd.type === ENTRY_POINT_TYPE);
    return [...entryPointCommands, ...globalCommands];
}

/**
 * Validate global command payloads against Discord's documented rules
 * (https://docs.discord.com/developers/interactions/application-commands).
 * Purely structural - a clean result means a bulk overwrite cannot fail
 * with a 400 for these commands.
 * @param {Object[]} globalCommands
 * @returns {string[]} human-readable issues; empty when the payload is valid
 */
function validateGlobalCommandPayload(globalCommands) {
    const issues = [];
    const seenNames = new Set();

    for (const cmd of globalCommands) {
        const label = `"${cmd.name}"`;
        const type = cmd.type ?? 1; // CHAT_INPUT default

        if (typeof cmd.name !== 'string' || !/^[-_'\p{L}\p{N}]{1,32}$/u.test(cmd.name)) {
            issues.push(`${label}: name must be 1-32 valid characters`);
        }
        if (type === 1 && cmd.name !== cmd.name.toLowerCase()) {
            issues.push(`${label}: CHAT_INPUT names must be lowercase`);
        }
        if (seenNames.has(`${type}:${cmd.name}`)) {
            issues.push(`${label}: duplicate command name for type ${type}`);
        }
        seenNames.add(`${type}:${cmd.name}`);

        if (type === 1 && (typeof cmd.description !== 'string' || cmd.description.length < 1 || cmd.description.length > 100)) {
            issues.push(`${label}: CHAT_INPUT description must be 1-100 characters`);
        }
        if (!Array.isArray(cmd.contexts) || cmd.contexts.length === 0 || !cmd.contexts.every(c => [0, 1, 2].includes(c))) {
            issues.push(`${label}: contexts must be a non-empty subset of [0, 1, 2]`);
        }
        if (!Array.isArray(cmd.integration_types) || cmd.integration_types.length === 0 || !cmd.integration_types.every(t => [0, 1].includes(t))) {
            issues.push(`${label}: integration_types must be a non-empty subset of [0, 1]`);
        }
        if ('dm_permission' in cmd) {
            issues.push(`${label}: dm_permission is deprecated and must not be sent alongside contexts`);
        }
        if ((cmd.options?.length ?? 0) > 25) {
            issues.push(`${label}: at most 25 options allowed`);
        }

        try {
            JSON.stringify(cmd);
        } catch (error) {
            issues.push(`${label}: payload is not JSON-serializable (${error.message})`);
        }
    }

    if (globalCommands.filter(cmd => (cmd.type ?? 1) === 1).length > 100) {
        issues.push('an app may have at most 100 global CHAT_INPUT commands');
    }

    return issues;
}

module.exports = {
    ALL_CONTEXTS,
    GUILD_INSTALL,
    ENTRY_POINT_TYPE,
    collectCommandPayloads,
    mergeEntryPointCommands,
    validateGlobalCommandPayload
};
