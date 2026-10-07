/**
 * Command, context-menu, interaction and message-gate gating (#318, P1.3).
 *
 * One filter (`featureCommandFilter`) decides which command files are
 * deployed AND loaded; a stale slash command, button, modal or select for a
 * disabled feature is refused before any handler runs; the messageCreate gate
 * order is unchanged. Nothing here uses a Discord token, a key or the
 * network: the feature state is injected (plain config + in-memory fs) and
 * the database is the throwaway one the Jest setup provides.
 *
 * Expectations are derived from the inventory and the legacy switches, never
 * from a hand-kept list of command names.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GOOBSTER_DB_PATH = process.env.GOOBSTER_DB_PATH
    || path.join(os.tmpdir(), `goobster-gating-commands-${process.pid}.sqlite`);

// Loading every command module pulls the voice/music stack through
// serviceManager (load-time work); these tests assert on WHEN it loads.
jest.mock('@goobster/core/services/serviceManager', () => {
    globalThis.__gatingServiceManagerLoaded = true;
    return { voiceService: { musicService: null } };
});
jest.mock('@goobster/core/services/spotdl/spotdlService', () => class SpotDLServiceMock {});

const mockHandlers = {
    tavern: jest.fn(),
    parlor: jest.fn(),
    project: jest.fn(),
    sandbox: jest.fn(),
    access: jest.fn(async () => null),
    friend: jest.fn(async () => null),
    integration: jest.fn(async () => null),
    searchApproval: jest.fn(async () => null)
};
jest.mock('@goobster/core/services/tavern/interactionHandler', () => ({ handleButton: (...args) => mockHandlers.tavern(...args) }));
jest.mock('@goobster/core/services/parlorService', () => ({ handleInviteButton: (...args) => mockHandlers.parlor(...args) }));
jest.mock('@goobster/core/services/projectService', () => ({ handleInviteButton: (...args) => mockHandlers.project(...args) }));
jest.mock('@goobster/core/services/sandboxRequestService', () => ({ handleButton: (...args) => mockHandlers.sandbox(...args) }));
jest.mock('@goobster/core/services/accessRequestService', () => ({ handleButton: (...args) => mockHandlers.access(...args) }));
jest.mock('@goobster/core/services/friendService', () => ({ handleButton: (...args) => mockHandlers.friend(...args) }));
jest.mock('@goobster/core/services/integrationActionService', () => ({ handleButton: (...args) => mockHandlers.integration(...args) }));
jest.mock('@goobster/core/utils/aiSearchHandler', () => ({
    handleSearchApproval: (...args) => mockHandlers.searchApproval(...args),
    handleSearchDenial: jest.fn(async () => null),
    _deletePendingRequest: jest.fn()
}));

const db = require('@goobster/core/db');
const inventory = require('@goobster/core/features/inventory');
const { features } = require('@goobster/core/features/featureState');
const { createLegacyResolver } = require('@goobster/core/features/legacyResolver');
const {
    collectCommandPayloads,
    commandNameIndex,
    computeDeployHash,
    featureCommandFilter,
    listCommandFiles
} = require('@goobster/core/utils/commandDeployment');
const interactionCreate = require('../apps/bot/events/interactionCreate');

const { FEATURE_IDS, FEATURES } = inventory;
const COMMANDS_DIR = path.join(__dirname, '..', 'apps', 'bot', 'commands');
const MANAGEABLE = FEATURE_IDS.filter(id => id !== 'core');
const FILE = '/virtual/data/features.json';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function memoryFs(files = {}) {
    const store = new Map(Object.entries(files));
    const missing = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
    return {
        existsSync: p => store.has(p),
        readFileSync(p) { if (!store.has(p)) throw missing(p); return store.get(p); },
        writeFileSync: (p, data) => store.set(p, String(data)),
        renameSync(from, to) { store.set(to, store.get(from)); store.delete(from); },
        mkdirSync() {},
        unlinkSync: p => store.delete(p)
    };
}

/** A configuration with the Discord adapter on and every legacy flag at its shipped default. */
const DEFAULT_CONFIG = { token: 'jest-token', clientId: '0', guildIds: ['0'] };
/** Every legacy switch flipped on. */
const EVERYTHING_ON = {
    ...DEFAULT_CONFIG,
    sandbox: { enabled: true },
    observatory: { enabled: true },
    mcp: { enabled: true },
    gbaRun: { enabled: true },
    screenVision: { enabled: true },
    activity: { enabled: true }
};

function useState({ config = DEFAULT_CONFIG, env = {}, inactive = null } = {}) {
    let files = {};
    if (inactive) {
        const entries = {};
        for (const id of MANAGEABLE) entries[id] = { installed: true, active: !inactive.includes(id) };
        files = {
            [FILE]: JSON.stringify({
                version: 1, revision: 1, updatedAt: '2026-10-06 12:00:00', origin: 'operator', features: entries
            })
        };
    }
    features._resetForTests({ fs: memoryFs(files), filePath: FILE, env, config });
    return features;
}

/**
 * Expected active set, computed from the inventory graph and the legacy
 * switches only (the thing the resolver is meant to equal when no state file
 * exists). Independent of featureState.js.
 */
function deriveActive({ config = DEFAULT_CONFIG, env = {}, inactiveRequested = null } = {}) {
    const legacy = createLegacyResolver({ config, env });
    const requested = (id) => {
        if (id === 'core') return true;
        if (inactiveRequested) return !inactiveRequested.includes(id);
        try { return legacy.value(id); } catch { return true; }
    };
    const memo = {};
    const active = (id) => {
        if (memo[id] === undefined) memo[id] = requested(id) && FEATURES[id].dependsOn.every(active);
        return memo[id];
    };
    return new Set(FEATURE_IDS.filter(active));
}

/** inventory command/context-menu keys whose owner and every alsoRequires are in `activeSet`. */
function expectedKeys(activeSet) {
    const keys = [];
    for (const [kind, table] of [['command', inventory.commands], ['contextMenu', inventory.contextMenus]]) {
        for (const key of Object.keys(table)) {
            const { owner, alsoRequires } = inventory.ownerOf(kind, key);
            if ([owner, ...alsoRequires].every(id => activeSet.has(id))) keys.push(key);
        }
    }
    return keys.sort();
}

function payloadNames(payload) {
    return [...payload.guildCommands, ...payload.globalCommands].map(command => command.name).sort();
}

function namesFor(keys) {
    const index = commandNameIndex(COMMANDS_DIR);
    const byKey = new Map([...index.values()].map(entry => [entry.key, entry.name]));
    return keys.map(key => byKey.get(key)).sort();
}

beforeEach(() => {
    jest.clearAllMocks();
});

afterAll(() => {
    features._resetForTests({});
});

/* ------------------------------------------------------------------ */
/* One filter for deployment and loading                               */
/* ------------------------------------------------------------------ */

describe('command deployment and loading share one filter', () => {
    test('with no features.json the payload, the loader set and the context menus equal the inventory + legacy baseline', () => {
        useState();
        const active = deriveActive();
        const expected = expectedKeys(active);

        const listed = listCommandFiles(COMMANDS_DIR, { filter: featureCommandFilter });
        expect(listed.active.map(entry => entry.key).sort()).toEqual(expected);
        expect(listed.inactive.map(entry => entry.key).sort())
            .toEqual([...Object.keys(inventory.commands), ...Object.keys(inventory.contextMenus)].filter(key => !expected.includes(key)).sort());

        const payload = collectCommandPayloads(COMMANDS_DIR, { filter: featureCommandFilter });
        expect(payloadNames(payload)).toEqual(namesFor(expected));
        // The shipped defaults really do leave some features off (this is
        // what makes the baseline meaningful rather than "everything").
        expect(active.has('gba')).toBe(false);
        expect(active.has('music')).toBe(true);
    });

    test('with every legacy switch on, nothing is filtered: payload equals the unfiltered walk', () => {
        useState({ config: EVERYTHING_ON });
        const everything = collectCommandPayloads(COMMANDS_DIR);
        const gated = collectCommandPayloads(COMMANDS_DIR, { filter: featureCommandFilter });
        expect(gated.skipped).toEqual([]);
        expect(payloadNames(gated)).toEqual(payloadNames(everything));
        expect(gated.globalCommands).toEqual(everything.globalCommands);
    });

    test.each(MANAGEABLE)('with %s off its commands and context menus leave both the payload and the loader, together with its dependents', (id) => {
        useState({ config: EVERYTHING_ON, inactive: [id] });
        const active = deriveActive({ config: EVERYTHING_ON, inactiveRequested: [id] });
        const expected = expectedKeys(active);

        const listed = listCommandFiles(COMMANDS_DIR, { filter: featureCommandFilter });
        const payload = collectCommandPayloads(COMMANDS_DIR, { filter: featureCommandFilter });
        expect(listed.active.map(entry => entry.key).sort()).toEqual(expected);
        expect(payloadNames(payload)).toEqual(namesFor(expected));
        // every command file the feature owns is absent
        for (const [key] of Object.entries(inventory.commands)) {
            const { owner, alsoRequires } = inventory.ownerOf('command', key);
            if (owner === id || alsoRequires.includes(id)) {
                expect(expected).not.toContain(key);
            }
        }
        // payload and loader agree on the number of files too
        expect(payload.guildCommands.length + payload.globalCommands.length).toBe(listed.active.length);
    });

    test('core commands (privacy, erasure, operator, help) survive every optional feature being off', () => {
        useState({ config: EVERYTHING_ON, inactive: MANAGEABLE });
        const expected = expectedKeys(new Set(['core']));
        expect(expected.length).toBeGreaterThan(0);
        const names = namesFor(expected);
        for (const required of ['forget-me', 'what-do-you-know-about-me', 'privacy', 'memory', 'help', 'ping', 'systemstatus', 'chat', 'attention']) {
            expect(names).toContain(required);
        }
        const payload = collectCommandPayloads(COMMANDS_DIR, { filter: featureCommandFilter });
        expect(payloadNames(payload)).toEqual(names);
    });

    test('mixed folders are filtered per file: economy/ and music/ keep exactly what their owners allow', () => {
        useState({ config: EVERYTHING_ON, inactive: ['exchange'] });
        const keys = listCommandFiles(COMMANDS_DIR, { filter: featureCommandFilter }).active.map(entry => entry.key);
        expect(keys).toContain('economy/points.js');
        expect(keys).not.toContain('economy/exchange.js');
        expect(keys).not.toContain('economy/stocks.js');
        // wheel and predict also need the exchange
        expect(keys).not.toContain('economy/wheel.js');
        expect(keys).not.toContain('economy/predict.js');
        // gamble (table games) does not
        expect(keys).toContain('economy/gamble.js');

        useState({ config: EVERYTHING_ON, inactive: ['voice'] });
        const music = listCommandFiles(COMMANDS_DIR, { filter: featureCommandFilter }).active.map(entry => entry.key);
        expect(music).toContain('music/generatemusic.js');
        expect(music).not.toContain('music/play.js');
        expect(music).not.toContain('music/contextMenu.js');
    });

    test('the context menu is classified and filtered like a command', () => {
        useState({ config: EVERYTHING_ON });
        const entry = listCommandFiles(COMMANDS_DIR, { filter: featureCommandFilter })
            .active.find(item => item.key === 'music/contextMenu.js');
        expect(entry.kind).toBe('contextMenu');
        useState({ config: EVERYTHING_ON, inactive: ['music'] });
        const inactive = listCommandFiles(COMMANDS_DIR, { filter: featureCommandFilter }).inactive.map(item => item.key);
        expect(inactive).toContain('music/contextMenu.js');
    });

    test('a command file the inventory does not claim is left out (fail closed), never loaded', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gating-unclaimed-'));
        fs.mkdirSync(path.join(dir, 'chat'));
        fs.writeFileSync(path.join(dir, 'chat', 'chat.js'), "module.exports = { data: { name: 'chat', toJSON: () => ({ name: 'chat' }) }, execute() {} };\n");
        fs.writeFileSync(path.join(dir, 'chat', 'rogue.js'), "throw new Error('must never be required');\n");
        useState();
        const listed = listCommandFiles(dir, { filter: featureCommandFilter });
        expect(listed.active.map(entry => entry.key)).toEqual(['chat/chat.js']);
        expect(listed.inactive).toEqual([expect.objectContaining({ key: 'chat/rogue.js', reason: 'UNCLAIMED_SURFACE' })]);
        expect(() => collectCommandPayloads(dir, { filter: featureCommandFilter })).not.toThrow();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a disabled command module is never required, so its top-level imports start nothing', () => {
        globalThis.__gatingServiceManagerLoaded = false;
        jest.isolateModules(() => {
            const isolatedFeatures = require('@goobster/core/features/featureState').features;
            const entries = {};
            for (const id of MANAGEABLE) entries[id] = { installed: true, active: !['voice', 'music'].includes(id) };
            isolatedFeatures._resetForTests({
                fs: memoryFs({ [FILE]: JSON.stringify({ version: 1, revision: 1, updatedAt: null, origin: 'operator', features: entries }) }),
                filePath: FILE, env: {}, config: EVERYTHING_ON
            });
            const deployment = require('@goobster/core/utils/commandDeployment');
            const result = deployment.collectCommandPayloads(COMMANDS_DIR, { filter: deployment.featureCommandFilter });
            expect(result.skipped.length).toBeGreaterThan(0);
        });
        expect(globalThis.__gatingServiceManagerLoaded).toBe(false);
    });

    test('static command names match the names the modules really declare (stale-command attribution is exact)', () => {
        useState({ config: EVERYTHING_ON });
        const index = commandNameIndex(COMMANDS_DIR);
        const all = listCommandFiles(COMMANDS_DIR).active;
        expect(index.size).toBe(all.length);
        for (const entry of all) {
            const loaded = require(entry.filePath);
            expect(entry.name).toBe(loaded.data.name);
            expect(index.get(loaded.data.name).key).toBe(entry.key);
        }
    });
});

describe('deploy hash', () => {
    const base = { clientId: '1', guildIds: ['2'], guildCommands: [{ name: 'a' }], globalCommands: [{ name: 'b' }] };

    test('changes when the active feature set changes even if the payload does not', () => {
        const a = computeDeployHash({ ...base, activeFeatures: ['core', 'music'] });
        const b = computeDeployHash({ ...base, activeFeatures: ['core', 'music', 'mcp'] });
        expect(a).not.toBe(b);
        expect(computeDeployHash({ ...base, activeFeatures: ['core', 'music'] })).toBe(a);
    });

    test('defaults to the live active set and follows a feature flip', () => {
        useState({ config: EVERYTHING_ON });
        const before = computeDeployHash(base);
        useState({ config: EVERYTHING_ON, inactive: ['mcp'] });
        expect(computeDeployHash(base)).not.toBe(before);
    });

    test('deploy-commands.js and the bot loader use the shared filter and hash', () => {
        const deploy = fs.readFileSync(path.join(__dirname, '..', 'apps', 'bot', 'deploy-commands.js'), 'utf8');
        const bot = fs.readFileSync(path.join(__dirname, '..', 'apps', 'bot', 'index.js'), 'utf8');
        expect(deploy).toMatch(/filter: featureCommandFilter/);
        expect(deploy).toMatch(/computeDeployHash\(/);
        expect(bot).toMatch(/filter: featureCommandFilter/);
        expect(bot).toMatch(/listCommandFiles\(/);
    });
});

/* ------------------------------------------------------------------ */
/* Stale commands                                                       */
/* ------------------------------------------------------------------ */

describe('stale slash commands, autocomplete and context menus', () => {
    function fakeInteraction(commandName, { autocomplete = false } = {}) {
        return {
            commandName,
            isAutocomplete: () => autocomplete,
            reply: jest.fn(async () => {}),
            respond: jest.fn(async () => {}),
            followUp: jest.fn(async () => {}),
            deferred: false,
            replied: false
        };
    }

    test('a command whose file was left out is answered ephemerally with the standard text', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['tavern'] });
        const names = commandNameIndex(COMMANDS_DIR);
        const interaction = fakeInteraction('adventure');
        const refused = await interactionCreate.refuseUnavailableCommand(interaction, names);
        expect(refused).toBe(true);
        expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
            content: 'That feature is not available on this installation.',
            ephemeral: true
        }));
    });

    test('autocomplete for a disabled command responds with no choices and never replies', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['tavern'] });
        const interaction = fakeInteraction('tavern', { autocomplete: true });
        expect(await interactionCreate.refuseUnavailableCommand(interaction, commandNameIndex(COMMANDS_DIR))).toBe(true);
        expect(interaction.respond).toHaveBeenCalledWith([]);
        expect(interaction.reply).not.toHaveBeenCalled();
    });

    test('the music context menu is refused by name when playback is off', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['voice'] });
        const interaction = fakeInteraction('Goobster Controls');
        expect(await interactionCreate.refuseUnavailableCommand(interaction, commandNameIndex(COMMANDS_DIR))).toBe(true);
        expect(interaction.reply).toHaveBeenCalledTimes(1);
    });

    test('an active command and an unknown name are left to the normal path', async () => {
        useState({ config: EVERYTHING_ON });
        const names = commandNameIndex(COMMANDS_DIR);
        const active = fakeInteraction('adventure');
        expect(await interactionCreate.refuseUnavailableCommand(active, names)).toBe(false);
        const unknown = fakeInteraction('definitely-not-a-command');
        expect(await interactionCreate.refuseUnavailableCommand(unknown, names)).toBe(false);
        expect(active.reply).not.toHaveBeenCalled();
        expect(unknown.reply).not.toHaveBeenCalled();
    });

    test('core commands are never refused, whatever else is off', async () => {
        useState({ config: EVERYTHING_ON, inactive: MANAGEABLE });
        const names = commandNameIndex(COMMANDS_DIR);
        for (const name of ['forget-me', 'what-do-you-know-about-me', 'privacy', 'help']) {
            const interaction = fakeInteraction(name);
            expect(await interactionCreate.refuseUnavailableCommand(interaction, names)).toBe(false);
        }
    });
});

/* ------------------------------------------------------------------ */
/* Stale buttons                                                        */
/* ------------------------------------------------------------------ */

describe('stale buttons, modals and selects', () => {
    let runSpy;

    beforeEach(() => {
        runSpy = jest.spyOn(db, 'run');
    });

    afterEach(() => {
        runSpy.mockRestore();
    });

    function button(customId, extra = {}) {
        return {
            customId,
            isButton: () => true,
            isMessageComponent: () => true,
            isModalSubmit: () => false,
            deferUpdate: jest.fn(async () => {}),
            reply: jest.fn(async () => {}),
            followUp: jest.fn(async () => {}),
            deferred: false,
            replied: false,
            message: { edit: jest.fn(async () => {}), reference: null },
            channel: { messages: { fetch: jest.fn(async () => new Map()) }, send: jest.fn() },
            user: { id: '100000000000000001', tag: 'u#1' },
            guildId: '200000000000000001',
            ...extra
        };
    }

    const UNAVAILABLE = expect.objectContaining({
        content: 'That feature is not available on this installation.',
        ephemeral: true
    });

    // Router token -> the handler a disabled owner must never reach.
    const ROUTED = [
        ['tavern', 'join_tavern_1', 'tavern', 'tavern'],
        ['projects', 'accept_projectinvite_1', 'project', 'projectinvite'],
        ['sandbox', 'approve_sbxreq_1', 'sandbox', 'sbxreq']
    ];

    test.each(ROUTED)('with %s off, %s is refused ephemerally before any handler, ack or write', async (feature, customId, handlerKey) => {
        useState({ config: EVERYTHING_ON, inactive: [feature] });
        const interaction = button(customId);
        await interactionCreate.execute(interaction);
        expect(interaction.reply).toHaveBeenCalledWith(UNAVAILABLE);
        expect(mockHandlers[handlerKey]).not.toHaveBeenCalled();
        expect(interaction.deferUpdate).not.toHaveBeenCalled();
        expect(runSpy).not.toHaveBeenCalled();
    });

    test.each(ROUTED)('with everything on, %s passes through to its handler', async (feature, customId, handlerKey) => {
        useState({ config: EVERYTHING_ON });
        const interaction = button(customId);
        await interactionCreate.execute(interaction);
        expect(mockHandlers[handlerKey]).toHaveBeenCalledTimes(1);
        expect(interaction.reply).not.toHaveBeenCalled();
    });

    test('one feature being off leaves other features buttons alone', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['sandbox'] });
        const sandboxRequest = button('approve_sbxreq_9');
        await interactionCreate.execute(sandboxRequest);
        expect(sandboxRequest.reply).toHaveBeenCalledWith(UNAVAILABLE);
        // projects is independent of sandbox and keeps working
        const invite = button('accept_projectinvite_9');
        await interactionCreate.execute(invite);
        expect(mockHandlers.project).toHaveBeenCalledTimes(1);
    });

    test('core routed tokens are never refused, even with every optional feature off', async () => {
        useState({ config: EVERYTHING_ON, inactive: MANAGEABLE });
        for (const [customId, key] of [
            ['approve_accessreq_5', 'access'],
            ['accept_friendreq_5', 'friend'],
            ['accept_parlorinvite_5', 'parlor']
        ]) {
            const interaction = button(customId);
            await interactionCreate.execute(interaction);
            expect(mockHandlers[key]).toHaveBeenCalledTimes(1);
            expect(interaction.reply).not.toHaveBeenCalled();
        }
    });

    describe('confirmable integration actions resolve their owner from the pending row', () => {
        async function pending(type) {
            return db.insert(
                `INSERT INTO pending_integration_actions (type, guildId, channelId, requestedBy, payload)
                 VALUES (@type, @guildId, @channelId, @requestedBy, @payload)`,
                { type, guildId: '200000000000000001', channelId: '300000000000000001', requestedBy: '100000000000000001', payload: '{}' }
            );
        }

        test('a Cursor launch is refused when cursor is off, without touching the row', async () => {
            const id = await pending('agent-launch');
            useState({ config: EVERYTHING_ON, inactive: ['cursor'] });
            runSpy.mockClear();
            const interaction = button(`approve_intaction_${id}`);
            await interactionCreate.execute(interaction);
            expect(interaction.reply).toHaveBeenCalledWith(UNAVAILABLE);
            expect(mockHandlers.integration).not.toHaveBeenCalled();
            expect(interaction.deferUpdate).not.toHaveBeenCalled();
            expect(runSpy).not.toHaveBeenCalled();
            const row = await db.get('SELECT status FROM pending_integration_actions WHERE id = @id', { id });
            expect(row.status).toBe('PENDING');
        });

        test('a GitHub issue is refused when github is off, but a Cursor launch is not (cursor needs github, so both are off)', async () => {
            const issue = await pending('github-issue');
            useState({ config: EVERYTHING_ON, inactive: ['github'] });
            const refusedIssue = button(`approve_intaction_${issue}`);
            await interactionCreate.execute(refusedIssue);
            expect(refusedIssue.reply).toHaveBeenCalledWith(UNAVAILABLE);
            expect(mockHandlers.integration).not.toHaveBeenCalled();
        });

        test('with the owners active the service handles the press; a missing row is left to the service', async () => {
            const id = await pending('github-issue');
            useState({ config: EVERYTHING_ON });
            const interaction = button(`approve_intaction_${id}`);
            await interactionCreate.execute(interaction);
            expect(mockHandlers.integration).toHaveBeenCalledWith('approve', id, interaction);
            expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);

            useState({ config: EVERYTHING_ON, inactive: ['github', 'cursor'] });
            mockHandlers.integration.mockClear();
            const missing = button('approve_intaction_999999');
            await interactionCreate.execute(missing);
            expect(mockHandlers.integration).toHaveBeenCalledTimes(1);
            expect(missing.reply).not.toHaveBeenCalled();
        });
    });

    describe('collector-owned ids (the clear_search_button collision)', () => {
        test('clear_search_button is no longer parsed as the `search` router token: the router neither defers nor handles it', async () => {
            useState({ config: EVERYTHING_ON });
            const interaction = button('clear_search_button');
            await interactionCreate.execute(interaction);
            expect(interaction.deferUpdate).not.toHaveBeenCalled();
            expect(mockHandlers.searchApproval).not.toHaveBeenCalled();
            expect(interaction.reply).not.toHaveBeenCalled();
        });

        test('real search approvals still take the router path', async () => {
            useState({ config: EVERYTHING_ON });
            const interaction = button('approve_search_req1');
            await interactionCreate.execute(interaction);
            expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
            expect(mockHandlers.searchApproval).toHaveBeenCalledWith('req1', interaction);
        });

        test('every collector id the inventory claims is left to its collector when active and refused when its owner is off', async () => {
            const collectorIds = Object.keys(inventory.interactionTypes).filter(key => key.startsWith('collector:'));
            expect(collectorIds.length).toBeGreaterThan(0);
            for (const key of collectorIds) {
                const customId = key.slice('collector:'.length);
                const { owner, alsoRequires } = inventory.ownerOf('interactionType', key);

                useState({ config: EVERYTHING_ON });
                const live = button(customId);
                await interactionCreate.execute(live);
                expect(live.reply).not.toHaveBeenCalled();
                expect(live.deferUpdate).not.toHaveBeenCalled();

                const off = [owner, ...alsoRequires].filter(id => id !== 'core')[0];
                if (!off) continue;
                useState({ config: EVERYTHING_ON, inactive: [off] });
                const stale = button(customId);
                await interactionCreate.execute(stale);
                expect(stale.reply).toHaveBeenCalledWith(UNAVAILABLE);
            }
        });

        test('forget-me confirmation ids belong to core and are never refused', async () => {
            useState({ config: EVERYTHING_ON, inactive: MANAGEABLE });
            for (const customId of ['forgetme_confirm', 'forgetme_cancel']) {
                const interaction = button(customId);
                await interactionCreate.execute(interaction);
                expect(interaction.reply).not.toHaveBeenCalled();
            }
        });

        test('no setCustomId literal in the app, other than the claimed collector ids, can parse as a router token by accident', () => {
            const roots = [
                path.join(__dirname, '..', 'apps', 'bot', 'commands'),
                path.join(__dirname, '..', 'packages', 'core', 'utils'),
                path.join(__dirname, '..', 'packages', 'core', 'services')
            ];
            const files = [];
            const walk = (dir) => {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) walk(full);
                    else if (entry.name.endsWith('.js')) files.push(full);
                }
            };
            roots.forEach(walk);
            const offenders = [];
            for (const file of files) {
                const text = fs.readFileSync(file, 'utf8');
                for (const match of text.matchAll(/setCustomId\(\s*'([^'$`]+)'\s*\)/g)) {
                    const customId = match[1];
                    const surface = interactionCreate.resolveInteractionSurface(customId);
                    const token = customId.split('_')[1];
                    // A literal id whose second segment is a router token must be a claimed collector id.
                    if (token && Object.prototype.hasOwnProperty.call(inventory.interactionTypes, token)
                        && !(surface && surface.collector)) {
                        offenders.push(`${path.relative(path.join(__dirname, '..'), file)}: ${customId}`);
                    }
                }
            }
            expect(offenders).toEqual([]);
        });
    });

    test('modal submits and selects use the same gate', async () => {
        useState({ config: EVERYTHING_ON, inactive: ['tavern'] });
        const modal = {
            customId: 'submit_tavern_4',
            isButton: () => false,
            isMessageComponent: () => false,
            isModalSubmit: () => true,
            reply: jest.fn(async () => {}),
            followUp: jest.fn(async () => {}),
            deferred: false,
            replied: false
        };
        await interactionCreate.execute(modal);
        expect(modal.reply).toHaveBeenCalledWith(UNAVAILABLE);
        expect(mockHandlers.tavern).not.toHaveBeenCalled();
    });

    test('an id nothing claims keeps today\'s behaviour (no refusal)', async () => {
        useState({ config: EVERYTHING_ON, inactive: MANAGEABLE });
        const interaction = button('mystery_unclaimed_1');
        await interactionCreate.execute(interaction);
        expect(interaction.reply).not.toHaveBeenCalled();
    });
});

/* ------------------------------------------------------------------ */
/* messageCreate gate order and feature gates                           */
/* ------------------------------------------------------------------ */

describe('messageCreate gates', () => {
    const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'bot', 'events', 'messageCreate.js'), 'utf8');

    test('the gate order in the handler is the order of the inventory eventGates (same list as before this change)', () => {
        const markers = [...SOURCE.matchAll(/^\s*\/\/ (messageCreate#\d{2} .+)$/gm)].map(match => match[1]);
        const declared = Object.keys(inventory.eventGates).filter(name => /^messageCreate#\d{2} /.test(name));
        expect(markers).toEqual(declared);
        expect(markers.map(name => name.slice('messageCreate#'.length, 'messageCreate#'.length + 2)))
            .toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']);
        // Frozen reference of the pre-#318 execution order (names only), so a reorder fails loudly.
        expect(markers).toEqual([
            'messageCreate#01 reply-tail record',
            'messageCreate#02 ignore bots',
            'messageCreate#03 partial resolve',
            'messageCreate#04 DM direct chat',
            'messageCreate#05 activity counters',
            'messageCreate#06 agent mission-control threads',
            'messageCreate#07 address detection',
            'messageCreate#08 reply-to-edit',
            'messageCreate#09 explicit address',
            'messageCreate#10 GBA advice inbox',
            'messageCreate#11 reply detection',
            'messageCreate#12 dynamic response'
        ]);
    });

    test('only gates #06 (cursor) and #10 (gba) are feature gates; the core gates carry no feature check', () => {
        const featureGated = Object.entries(inventory.eventGates)
            .filter(([name]) => /^messageCreate#\d{2} /.test(name))
            .filter(([name]) => inventory.ownerOf('eventGate', name).owner !== 'core')
            .map(([name]) => name.slice(0, 'messageCreate#06'.length));
        expect(featureGated).toEqual(['messageCreate#06', 'messageCreate#10']);
        expect(inventory.ownerOf('eventGate', 'messageCreate#06 agent mission-control threads').owner).toBe('cursor');
        expect(inventory.ownerOf('eventGate', 'messageCreate#10 GBA advice inbox').owner).toBe('gba');
        const checks = [...SOURCE.matchAll(/surfaceActive\('eventGate', ([A-Z_]+)\)/g)].map(match => match[1]);
        expect(checks.sort()).toEqual(['GATE_GBA_ADVICE', 'GATE_MISSION_CONTROL']);
    });

    describe('behaviour (gates fire in order, feature gates skip cleanly)', () => {
        const calls = [];
        let messageCreate;

        beforeAll(() => {
            jest.doMock('@goobster/core/utils/chatHandler', () => ({
                handleChatInteraction: jest.fn(async () => { calls.push('chat'); })
            }));
            jest.doMock('@goobster/core/services/activityService', () => ({
                recordMessage: jest.fn(async () => { calls.push('activity'); })
            }));
            jest.doMock('@goobster/core/utils/guildSettings', () => ({
                getDynamicResponse: jest.fn(async () => 'disabled'),
                getReplyDetection: jest.fn(async () => 'disabled'),
                DYNAMIC_RESPONSE: { ENABLED: 'enabled' },
                REPLY_DETECTION: { ENABLED: 'enabled' }
            }));
            jest.doMock('@goobster/core/utils/guildContext', () => ({
                getBotPreferredName: jest.fn(async () => 'Goobster')
            }));
            jest.doMock('@goobster/core/utils/replyDetection', () => ({
                recordMessage: jest.fn(() => { calls.push('tail'); }),
                shouldRespond: jest.fn(async () => ({ respond: false }))
            }));
            jest.doMock('@goobster/core/utils/intentDetectionHandler', () => ({
                shouldRespond: jest.fn(() => ({ shouldRespond: false, confidence: 0 })),
                updateContext: jest.fn()
            }));
            jest.doMock('@goobster/core/services/gbaRunService', () => ({
                maybeCaptureAdvice: jest.fn(async () => { calls.push('gba'); return true; })
            }));
            messageCreate = require('../apps/bot/events/messageCreate');
        });

        afterAll(() => {
            jest.dontMock('@goobster/core/utils/chatHandler');
            jest.dontMock('@goobster/core/services/activityService');
            jest.dontMock('@goobster/core/utils/guildSettings');
            jest.dontMock('@goobster/core/utils/guildContext');
            jest.dontMock('@goobster/core/utils/replyDetection');
            jest.dontMock('@goobster/core/utils/intentDetectionHandler');
            jest.dontMock('@goobster/core/services/gbaRunService');
        });

        beforeEach(() => {
            calls.length = 0;
        });

        function guildMessage({ content = 'hello there', mention = false, tracker = null } = {}) {
            const botId = '900000000000000001';
            return {
                author: { bot: false, id: '100000000000000001' },
                partial: false,
                guild: { id: '200000000000000001', members: { me: {}, cache: { get: () => ({ roles: { cache: { has: () => false } } }) } } },
                channel: { id: '300000000000000001', sendTyping: jest.fn(async () => {}), messages: { fetch: jest.fn() } },
                content: mention ? `<@${botId}> ${content}` : content,
                mentions: { users: { has: id => mention && id === botId }, roles: { some: () => false } },
                attachments: new Map(),
                reference: null,
                client: { user: { id: botId, username: 'Goobster' }, agentTrackerService: tracker },
                reply: jest.fn(async () => {})
            };
        }

        test('with cursor and gba active the thread gate runs before explicit address, and the advice gate after it', async () => {
            useState({ config: EVERYTHING_ON });
            expect(features.isActive('cursor')).toBe(true);

            const tracker = { handleThreadMessage: jest.fn(async () => { calls.push('thread'); return false; }) };
            await messageCreate.execute(guildMessage({ mention: true, tracker }));
            // explicit address wins after the thread gate; the advice gate never sees it
            expect(calls).toEqual(['tail', 'activity', 'thread', 'chat']);

            calls.length = 0;
            await messageCreate.execute(guildMessage({ tracker }));
            expect(calls).toEqual(['tail', 'activity', 'thread', 'gba']);

            // a handled thread message stops everything after gate #06
            calls.length = 0;
            const claiming = { handleThreadMessage: jest.fn(async () => { calls.push('thread'); return true; }) };
            await messageCreate.execute(guildMessage({ mention: true, tracker: claiming }));
            expect(calls).toEqual(['tail', 'activity', 'thread']);
        });

        test('with cursor off the mission-control gate is skipped entirely and the message continues to chat', async () => {
            useState({ config: EVERYTHING_ON, inactive: ['cursor'] });
            const tracker = { handleThreadMessage: jest.fn(async () => true) };
            await messageCreate.execute(guildMessage({ mention: true, tracker }));
            expect(tracker.handleThreadMessage).not.toHaveBeenCalled();
            expect(calls).toEqual(['tail', 'activity', 'chat']);
        });

        test('with gba off the advice inbox is never consulted (and its service is not even required)', async () => {
            useState({ config: EVERYTHING_ON, inactive: ['gba'] });
            await messageCreate.execute(guildMessage());
            expect(calls).toEqual(['tail', 'activity']);
            expect(calls).not.toContain('gba');
        });

        test('core gates are untouched with every optional feature off: DMs and explicit address still chat', async () => {
            useState({ config: EVERYTHING_ON, inactive: MANAGEABLE });
            await messageCreate.execute(guildMessage({ mention: true }));
            expect(calls).toEqual(['tail', 'activity', 'chat']);

            calls.length = 0;
            const dm = guildMessage({ content: 'hi in a dm' });
            dm.guild = null;
            await messageCreate.execute(dm);
            expect(calls).toEqual(['chat']);
        });

        test('with no features.json (legacy defaults) the message path is the same as everything on for cursor, and gba follows its legacy switch', async () => {
            useState();
            const tracker = { handleThreadMessage: jest.fn(async () => { calls.push('thread'); return false; }) };
            await messageCreate.execute(guildMessage({ tracker }));
            // cursor is active by default (presence switch); gba defaults off
            expect(calls).toEqual(['tail', 'activity', 'thread']);
        });
    });
});
