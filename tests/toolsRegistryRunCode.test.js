/**
 * The runCode tool gate (utils/toolsRegistry.js + config/sandboxConfig.js).
 *
 * The sandbox is opt-in and can be scoped to the web app only, so the tool
 * must not appear in the model's function list unless it is both enabled and
 * usable in the current context, and its execute() must refuse the same way
 * (defense in depth).
 */
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-runcode-test-${process.pid}.sqlite`);

// These wrapped commands boot heavy voice/music services at load time; the
// tool gate only needs the registry itself.
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));

const toolsRegistry = require('../utils/toolsRegistry');
const sandboxConfig = require('../config/sandboxConfig');

const names = (defs) => defs.map(d => d.name);
const original = { enabled: sandboxConfig.enabled, scope: sandboxConfig.scope };

afterEach(() => {
    sandboxConfig.enabled = original.enabled;
    sandboxConfig.scope = original.scope;
});

describe('getDefinitions gating', () => {
    test('runCode is absent when the sandbox is disabled', () => {
        sandboxConfig.enabled = false;
        expect(names(toolsRegistry.getDefinitions())).not.toContain('runCode');
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: true }))).not.toContain('runCode');
    });

    test('scope "everywhere" offers runCode in any text-chat context', () => {
        sandboxConfig.enabled = true;
        sandboxConfig.scope = 'everywhere';
        expect(names(toolsRegistry.getDefinitions())).toContain('runCode');
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: true }))).toContain('runCode');
    });

    test('scope "web" offers runCode only in the web app', () => {
        sandboxConfig.enabled = true;
        sandboxConfig.scope = 'web';
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: false }))).not.toContain('runCode');
        expect(names(toolsRegistry.getDefinitions())).not.toContain('runCode');
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: true }))).toContain('runCode');
    });

    test('a name allowlist (e.g. the voice subset) never smuggles runCode in', () => {
        sandboxConfig.enabled = true;
        sandboxConfig.scope = 'everywhere';
        const defs = toolsRegistry.getDefinitions(['performSearch', 'checkPoints']);
        expect(names(defs)).not.toContain('runCode');
    });

    test('the runCode definition is well-formed when offered', () => {
        sandboxConfig.enabled = true;
        sandboxConfig.scope = 'everywhere';
        const def = toolsRegistry.getDefinitions().find(d => d.name === 'runCode');
        expect(def).toBeTruthy();
        expect(def.parameters.required).toEqual(expect.arrayContaining(['language', 'code']));
        expect(def.parameters.properties.language.enum).toEqual(
            expect.arrayContaining(['python', 'javascript', 'bash']));
    });
});

describe('execute gating (defense in depth)', () => {
    test('refuses when disabled', async () => {
        sandboxConfig.enabled = false;
        const out = await toolsRegistry.execute('runCode', { language: 'python', code: 'print(1)' });
        expect(out).toMatch(/disabled/i);
    });

    test('web-scoped tool refuses a non-web context', async () => {
        sandboxConfig.enabled = true;
        sandboxConfig.scope = 'web';
        const out = await toolsRegistry.execute('runCode', {
            language: 'python',
            code: 'print(1)',
            interactionContext: { channelId: '123456789', user: { id: 'u1' } }
        });
        expect(out).toMatch(/web app/i);
    });
});
