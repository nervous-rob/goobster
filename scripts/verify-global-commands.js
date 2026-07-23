#!/usr/bin/env node
/**
 * Sanity-check the global (DM-enabled) command registration.
 *
 * Default mode is READ-ONLY: fetches the app's registered global commands
 * (a GET, not subject to the registration write limits), prints them with
 * their contexts/integration_types, validates the locally built payload
 * against Discord's documented rules, and diffs registered vs expected.
 *
 * With --put it additionally attempts the exact bulk overwrite that
 * deploy-commands.js performs, but rejecting on ANY rate limit, so the
 * outcome is a definitive verdict instead of a silent hang:
 *   - success        -> payload is valid and registration is current
 *   - 400 + body     -> a real payload problem (printed in full)
 *   - RateLimitError -> rate limited (prints route + exact reset time)
 *
 * Usage: node scripts/verify-global-commands.js [--put]
 */
const path = require('node:path');
const { REST, Routes, RateLimitError, DiscordAPIError } = require('discord.js');
const {
    collectCommandPayloads,
    mergeEntryPointCommands,
    validateGlobalCommandPayload,
    ENTRY_POINT_TYPE
} = require('../utils/commandDeployment');

const config = require('../config.json');
const { clientId, token } = config;
const DO_PUT = process.argv.includes('--put');

const CONTEXT_NAMES = { 0: 'GUILD', 1: 'BOT_DM', 2: 'PRIVATE_CHANNEL' };
const INSTALL_NAMES = { 0: 'GUILD_INSTALL', 1: 'USER_INSTALL' };

function describe(cmd) {
    const contexts = (cmd.contexts ?? []).map(c => CONTEXT_NAMES[c] ?? c).join(', ') || '(default: all)';
    const installs = (cmd.integration_types ?? []).map(t => INSTALL_NAMES[t] ?? t).join(', ') || '(app default)';
    const type = cmd.type === ENTRY_POINT_TYPE ? ' [ENTRY POINT]' : '';
    return `  - ${cmd.name}${type}  contexts: [${contexts}]  installs: [${installs}]`;
}

(async () => {
    const rest = new REST({
        timeout: 15_000,
        retries: 0,
        rejectOnRateLimit: () => true // never wait silently - report instead
    }).setToken(token);

    // 1. Validate the locally built payload offline
    const { globalCommands } = collectCommandPayloads(path.join(__dirname, '..', 'commands'));
    const issues = validateGlobalCommandPayload(globalCommands);
    console.log(`\nLocal global payload: ${globalCommands.length} command(s)`);
    if (issues.length > 0) {
        console.error('❌ Payload validation issues:');
        for (const issue of issues) console.error(`  - ${issue}`);
    } else {
        console.log('✅ Payload passes structural validation (names, descriptions, contexts, integration_types, option counts).');
    }

    // 2. Read back what Discord actually has registered
    let registered;
    try {
        registered = await rest.get(Routes.applicationCommands(clientId));
    } catch (error) {
        console.error('❌ Could not fetch registered global commands:', error.message);
        process.exit(1);
    }

    console.log(`\nRegistered global commands (${registered.length}):`);
    for (const cmd of registered) console.log(describe(cmd));

    // 3. Diff registered vs expected
    const expectedNames = new Set(globalCommands.map(cmd => cmd.name));
    const registeredNames = new Set(registered.filter(cmd => cmd.type !== ENTRY_POINT_TYPE).map(cmd => cmd.name));
    const missing = [...expectedNames].filter(name => !registeredNames.has(name));
    const extra = [...registeredNames].filter(name => !expectedNames.has(name));

    console.log('');
    if (missing.length === 0 && extra.length === 0) {
        console.log('✅ Registered global commands match the local DM-enabled set.');
    } else {
        if (missing.length > 0) console.warn('⚠️ Expected but NOT registered yet:', missing);
        if (extra.length > 0) console.warn('⚠️ Registered but not in the local set:', extra);
        console.log('(Run deploy-commands, or this script with --put, to reconcile.)');
    }

    // 4. Optional: attempt the real bulk overwrite with loud failure modes
    if (DO_PUT) {
        console.log('\nAttempting bulk overwrite (--put)...');
        try {
            const body = mergeEntryPointCommands(registered, globalCommands);
            const data = await rest.put(Routes.applicationCommands(clientId), { body });
            console.log(`✅ Bulk overwrite succeeded: ${data.length} global command(s) registered.`);
        } catch (error) {
            if (error instanceof RateLimitError) {
                console.warn('⏳ Rate limited (NOT a payload problem):', {
                    route: error.route,
                    global: error.global,
                    timeToResetMs: error.timeToReset,
                    resetsAt: new Date(Date.now() + error.timeToReset).toISOString()
                });
                process.exit(2);
            }
            if (error instanceof DiscordAPIError) {
                console.error(`❌ Discord rejected the payload (HTTP ${error.status}, code ${error.code}):`);
                console.error(JSON.stringify(error.rawError, null, 2));
                process.exit(1);
            }
            console.error('❌ Request failed:', error);
            process.exit(1);
        }
    }

    process.exit(issues.length > 0 ? 1 : 0);
})();
