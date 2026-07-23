/**
 * Validates the EXACT global (DM-enabled) command payload that
 * deploy-commands.js sends to Discord, against the documented rules for
 * the application-commands API. A clean run here means a bulk overwrite
 * cannot fail with a 400 for structural reasons - any deploy failure is
 * environmental (rate limiting, auth, network).
 */
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-payload-test-${process.pid}.sqlite`);

// Loading every command module pulls the voice/music stack through
// serviceManager, which has load-time side effects - mock it out.
jest.mock('../services/serviceManager', () => ({
    voiceService: { musicService: null }
}));
jest.mock('../services/spotdl/spotdlService', () => class SpotDLServiceMock {});

const {
    ALL_CONTEXTS,
    GUILD_INSTALL,
    ENTRY_POINT_TYPE,
    collectCommandPayloads,
    mergeEntryPointCommands,
    validateGlobalCommandPayload
} = require('../utils/commandDeployment');

const EXPECTED_GLOBAL_NAMES = [
    'chat', 'joke', 'poem', 'generate', 'help', 'ping', 'mememode',
    'forget-me', 'what-do-you-know-about-me',
    'personalitydirective', 'aisettings', 'thoughtfulmode', 'nickname'
];

let guildCommands;
let globalCommands;

beforeAll(() => {
    ({ guildCommands, globalCommands } = collectCommandPayloads(path.join(__dirname, '..', 'commands')));
});

describe('global command payload', () => {
    test('contains exactly the DM-enabled command set', () => {
        expect(globalCommands.map(cmd => cmd.name).sort()).toEqual([...EXPECTED_GLOBAL_NAMES].sort());
    });

    test('every global command carries the documented contexts and integration_types', () => {
        for (const cmd of globalCommands) {
            expect(cmd.contexts).toEqual(ALL_CONTEXTS);
            expect(cmd.integration_types).toEqual(GUILD_INSTALL);
            // dm_permission is deprecated and must never ride along with contexts
            expect(cmd).not.toHaveProperty('dm_permission');
        }
    });

    test('passes structural validation against Discord\'s documented rules', () => {
        expect(validateGlobalCommandPayload(globalCommands)).toEqual([]);
    });

    test('is JSON-serializable and round-trips cleanly', () => {
        const roundTripped = JSON.parse(JSON.stringify(globalCommands));
        expect(roundTripped).toEqual(globalCommands);
    });

    test('never overlaps with the guild-registered set (no duplicate commands in guilds)', () => {
        const guildNames = new Set(guildCommands.map(cmd => cmd.name));
        for (const cmd of globalCommands) {
            expect(guildNames.has(cmd.name)).toBe(false);
        }
    });

    test('guild commands are left untouched (no injected contexts)', () => {
        // Builders emit `contexts: undefined` keys; JSON serialization drops
        // them, so only a defined value would actually reach the API.
        for (const cmd of guildCommands) {
            expect(cmd.contexts).toBeUndefined();
            expect(cmd.integration_types).toBeUndefined();
        }
    });
});

describe('mergeEntryPointCommands', () => {
    test('carries Entry Point commands through a bulk overwrite unchanged', () => {
        const entryPoint = { id: '1', name: 'launch', type: ENTRY_POINT_TYPE, handler: 2 };
        const existing = [entryPoint, { id: '2', name: 'chat', type: 1 }];

        const body = mergeEntryPointCommands(existing, globalCommands);
        expect(body[0]).toBe(entryPoint);
        expect(body).toHaveLength(globalCommands.length + 1);
    });

    test('is a no-op without an Entry Point command', () => {
        const existing = [{ id: '2', name: 'chat', type: 1 }];
        expect(mergeEntryPointCommands(existing, globalCommands)).toEqual(globalCommands);
        expect(mergeEntryPointCommands(undefined, globalCommands)).toEqual(globalCommands);
    });
});

describe('validateGlobalCommandPayload', () => {
    const valid = () => ({
        name: 'valid-name',
        description: 'A perfectly fine description.',
        contexts: [0, 1, 2],
        integration_types: [0]
    });

    test('accepts a valid command', () => {
        expect(validateGlobalCommandPayload([valid()])).toEqual([]);
    });

    test('rejects bad names, descriptions, contexts, and deprecated fields', () => {
        expect(validateGlobalCommandPayload([{ ...valid(), name: 'Has Spaces!' }])).not.toEqual([]);
        expect(validateGlobalCommandPayload([{ ...valid(), name: 'UPPER' }])).not.toEqual([]);
        expect(validateGlobalCommandPayload([{ ...valid(), description: '' }])).not.toEqual([]);
        expect(validateGlobalCommandPayload([{ ...valid(), contexts: [7] }])).not.toEqual([]);
        expect(validateGlobalCommandPayload([{ ...valid(), contexts: undefined }])).not.toEqual([]);
        expect(validateGlobalCommandPayload([{ ...valid(), integration_types: [] }])).not.toEqual([]);
        expect(validateGlobalCommandPayload([{ ...valid(), dm_permission: false }])).not.toEqual([]);
        expect(validateGlobalCommandPayload([valid(), valid()])).not.toEqual([]); // duplicate names
    });
});
