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
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const inventory = require('../features/inventory');
const { surfaceActive } = require('../features/gate');
const { features } = require('../features/featureState');

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
 * Inventory key of a command file: its path relative to apps/bot/commands/,
 * always with forward slashes ("economy/wheel.js").
 */
function commandKey(folder, file) {
    return `${folder}/${file}`;
}

/** 'contextMenu' for the files the inventory lists as context menus, else 'command'. */
function commandKind(key) {
    return inventory.ownerOf('contextMenu', key) ? 'contextMenu' : 'command';
}

/**
 * The one feature filter for Discord commands. `deploy-commands.js` and the
 * bot's command loader both pass this to the same file lister, so what is
 * deployed and what is loaded cannot disagree.
 *
 * A file the inventory does not claim (an operator's own command) follows the
 * enforcement rule of the rest of the gate: with no usable `data/features.json`
 * it is allowed, exactly as before the inventory existed; with a state file in
 * force it fails closed (GateError('UNCLAIMED_SURFACE') - the lister reports it
 * as left out with that accurate reason). The inventory spec still fails CI for
 * an unclaimed in-repo command file.
 * @param {'command'|'contextMenu'} kind
 * @param {string} key
 * @returns {boolean}
 */
function featureCommandFilter(kind, key) {
    try {
        return surfaceActive(kind, key);
    } catch (error) {
        if (error && error.code === 'UNCLAIMED_SURFACE' && features.status().source !== 'file') return true;
        throw error;
    }
}

/** True for a command file the inventory has no claim for. */
function isUnclaimedCommand(entry) {
    return inventory.ownerOf(entry.kind, entry.key) === null;
}

/** Warning for an unclaimed command file that is being loaded or deployed (no state file in force). */
function unclaimedCommandWarning(entry) {
    return `[WARNING] Command ${entry.key} is not claimed by the feature inventory; it is loaded and deployed because no feature state file is in force. Once data/features.json exists it will be left out until packages/core/features/inventory.js claims it.`;
}

/** Why a file was left out, for logs: the accurate reason for an unclaimed file, the feature wording otherwise. */
function skippedReason(entry) {
    if (entry.reason === 'UNCLAIMED_SURFACE') {
        return 'it is not claimed by the feature inventory and a feature state file is in force (add it to packages/core/features/inventory.js)';
    }
    return 'its feature is not available on this installation';
}

/** The command (or context menu) name a file declares: its first literal `.setName('...')`. Static, never requires the file. */
function declaredName(filePath) {
    try {
        const match = /\.setName\(\s*(['"])((?:(?!\1).)+)\1/.exec(fs.readFileSync(filePath, 'utf8'));
        return match ? match[2] : null;
    } catch {
        return null;
    }
}

/**
 * Walk apps/bot/commands and split the files into those whose owning feature
 * is active and those that are not. Nothing is required here, so a disabled
 * command's top-level imports (voice stack, SpotDL, ...) never run.
 * @param {string} foldersPath
 * @param {Object} [options]
 * @param {(kind: string, key: string) => boolean} [options.filter] omitted = everything is active
 * @param {Function} [options.log]
 * @returns {{ active: Object[], inactive: Object[] }} entries `{ folder, file, key, kind, filePath, name, reason? }`
 */
function listCommandFiles(foldersPath, { filter = null, log = () => {} } = {}) {
    const active = [];
    const inactive = [];
    const commandFolders = fs.readdirSync(foldersPath);
    log('Found command folders:', commandFolders);

    for (const folder of commandFolders) {
        const commandsPath = path.join(foldersPath, folder);
        const commandFiles = fs.readdirSync(commandsPath).filter(file =>
            file.endsWith('.js') && !file.startsWith('config')
        );
        log(`Found ${commandFiles.length} commands in folder ${folder}:`, commandFiles);

        for (const file of commandFiles) {
            const key = commandKey(folder, file);
            // resolve() so a relative foldersPath can't be mistaken for a
            // node_modules specifier by require()
            const filePath = path.resolve(commandsPath, file);
            const entry = { folder, file, key, kind: commandKind(key), filePath, name: declaredName(filePath) };
            let allowed = true;
            if (filter) {
                try {
                    allowed = Boolean(filter(entry.kind, key));
                } catch (error) {
                    allowed = false;
                    entry.reason = error && error.code ? error.code : 'FILTER_ERROR';
                }
            }
            if (allowed && filter && isUnclaimedCommand(entry)) {
                entry.unclaimed = true;
                log(unclaimedCommandWarning(entry));
            }
            (allowed ? active : inactive).push(entry);
        }
    }

    return { active, inactive };
}

/**
 * Map of every declared command name (active or not) to its file entry, so a
 * stale interaction for a command that was never loaded can still be
 * attributed to its owning feature. Static: reads source text only.
 * @returns {Map<string, Object>}
 */
function commandNameIndex(foldersPath) {
    const { active, inactive } = listCommandFiles(foldersPath);
    const index = new Map();
    for (const entry of [...active, ...inactive]) {
        if (entry.name) index.set(entry.name, entry);
    }
    return index;
}

/**
 * Load every command module and split the deployment payloads into the
 * guild-registered set and the global (DM-enabled) set.
 * @param {string} foldersPath - Absolute path to the commands/ directory
 * @param {Object} [options] - { log, filter } optional logger (console.log-style)
 *   and the feature filter (see featureCommandFilter); omitted = no filtering
 * @returns {{ guildCommands: Object[], globalCommands: Object[], skipped: Object[] }}
 */
function collectCommandPayloads(foldersPath, { log = () => {}, filter = null } = {}) {
    const guildCommands = [];
    const globalCommands = [];
    const { active, inactive } = listCommandFiles(foldersPath, { filter, log });

    for (const entry of inactive) {
        log(`Skipping ${entry.key}: ${skippedReason(entry)}.`);
    }

    for (const { filePath } of active) {
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

    return { guildCommands, globalCommands, skipped: inactive };
}

/**
 * Ids of every feature whose surfaces this installation serves, in catalog
 * order: the part of the feature state a deployment depends on. This is the
 * enforcement view (`features.enforcedOff`), the same rule the command filter
 * applies, so a legacy flag that only changes the *reported* value does not
 * re-sync Discord.
 */
function activeFeatureIds() {
    return inventory.FEATURE_IDS.filter(id => !features.enforcedOff(id));
}

/**
 * Stable hash of the full command payload, the deployment targets and the
 * active feature set, so a change in which features run re-syncs Discord even
 * when the payload happens to be unchanged.
 */
function computeDeployHash({ clientId, guildIds, guildCommands, globalCommands, activeFeatures = activeFeatureIds() }) {
    const payload = JSON.stringify({ clientId, guildIds, guildCommands, globalCommands, activeFeatures });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

const DEPLOY_STATE_VERSION = 1;
const DEPLOY_STATE_FILE = 'command-deploy.json';
const LEGACY_DEPLOY_HASH_FILE = '.command-deploy-hash';

/**
 * One bulk overwrite per target: each guild, then the global set. The key is
 * the actual scope (application id plus guild id, or global), so a guild
 * list change deploys the new guild and nothing else.
 */
function deployTargets({ clientId, guildIds = [], guildCommands, globalCommands, activeFeatures = activeFeatureIds() }) {
    const hash = (scope, commands) => crypto.createHash('sha256')
        .update(JSON.stringify({ scope, commands, activeFeatures }))
        .digest('hex');
    const targets = [...new Set((guildIds || []).map(String))].map(guildId => ({
        key: `guild:${clientId}:${guildId}`,
        scope: 'guild',
        guildId,
        commands: guildCommands,
        hash: hash(`guild:${clientId}:${guildId}`, guildCommands)
    }));
    targets.push({
        key: `global:${clientId}`,
        scope: 'global',
        guildId: null,
        commands: globalCommands,
        hash: hash(`global:${clientId}`, globalCommands)
    });
    return targets;
}

function readDeployState(file, fsImpl = fs) {
    try {
        const doc = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
        if (doc && doc.version === DEPLOY_STATE_VERSION && doc.targets && typeof doc.targets === 'object' && !Array.isArray(doc.targets)) {
            return { version: DEPLOY_STATE_VERSION, targets: { ...doc.targets } };
        }
    } catch { /* absent or unreadable: every target deploys */ }
    return null;
}

function writeDeployState(file, state, fsImpl = fs) {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fsImpl.renameSync(tmp, file);
}

/**
 * Deploy the slash commands whose target hash differs from the
 * acknowledged one in `<dataDir>/command-deploy.json`. A hash is stored only
 * after Discord accepted that target's overwrite, so a failed or
 * rate-limited target is retried on the next start while the others stay
 * skipped. The legacy single-hash file (`.command-deploy-hash`) counts as
 * an acknowledgement of every target when it matches `legacyHash`.
 * Commands that no longer exist are answered by refuseUnavailableCommand.
 * @param {Object} params
 * @param {{ get: Function, put: Function }} params.rest
 * @param {{ applicationGuildCommands: Function, applicationCommands: Function }} params.routes
 * @returns {Promise<{ deployed: string[], skipped: string[], failed: Array<{ key: string, error: Error }> }>}
 */
async function deployCommandsIfChanged({
    rest,
    routes,
    clientId,
    guildIds,
    guildCommands,
    globalCommands,
    activeFeatures = activeFeatureIds(),
    dataDir,
    legacyHash = null,
    force = false,
    fs: fsImpl = fs,
    log = () => {}
}) {
    const file = path.join(dataDir, DEPLOY_STATE_FILE);
    const legacyFile = path.join(dataDir, LEGACY_DEPLOY_HASH_FILE);
    const targets = deployTargets({ clientId, guildIds, guildCommands, globalCommands, activeFeatures });
    let state = readDeployState(file, fsImpl);
    if (!state) {
        state = { version: DEPLOY_STATE_VERSION, targets: {} };
        let legacy = null;
        try { legacy = fsImpl.readFileSync(legacyFile, 'utf8').trim(); } catch { }
        if (legacy && legacyHash && legacy === legacyHash) {
            for (const target of targets) state.targets[target.key] = { hash: target.hash };
            writeDeployState(file, state, fsImpl);
        }
    }
    const scoped = new Set(targets.map(target => target.key));
    for (const key of Object.keys(state.targets)) {
        if (!scoped.has(key) && key.split(':')[1] === String(clientId)) delete state.targets[key];
    }

    const result = { deployed: [], skipped: [], failed: [] };
    const record = (target) => {
        state.targets[target.key] = { hash: target.hash, at: new Date().toISOString() };
        writeDeployState(file, state, fsImpl);
    };
    await Promise.all(targets.map(async (target) => {
        if (!force && state.targets[target.key]?.hash === target.hash) {
            result.skipped.push(target.key);
            return;
        }
        try {
            if (target.scope === 'guild') {
                log(`Deploying commands to guild ${target.guildId}...`);
                const data = await rest.put(routes.applicationGuildCommands(clientId, target.guildId), { body: target.commands });
                log(`Successfully reloaded ${data?.length ?? 0} commands for guild ${target.guildId}`);
            } else {
                log('Deploying global (DM-enabled) commands...');
                const existing = await rest.get(routes.applicationCommands(clientId));
                const body = mergeEntryPointCommands(existing, target.commands);
                if (body.length > target.commands.length) {
                    log(`Preserving ${body.length - target.commands.length} Entry Point command(s)`);
                }
                const data = await rest.put(routes.applicationCommands(clientId), { body });
                log(`Successfully reloaded ${data?.length ?? 0} global commands`);
            }
            record(target);
            result.deployed.push(target.key);
        } catch (error) {
            result.failed.push({ key: target.key, error });
        }
    }));
    return result;
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
    commandKey,
    commandKind,
    featureCommandFilter,
    isUnclaimedCommand,
    unclaimedCommandWarning,
    skippedReason,
    listCommandFiles,
    commandNameIndex,
    activeFeatureIds,
    computeDeployHash,
    DEPLOY_STATE_FILE,
    LEGACY_DEPLOY_HASH_FILE,
    deployTargets,
    readDeployState,
    deployCommandsIfChanged,
    collectCommandPayloads,
    mergeEntryPointCommands,
    validateGlobalCommandPayload
};
