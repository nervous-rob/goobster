/**
 * The observatory tool gate (utils/toolsRegistry.js + config/observatoryConfig.js).
 *
 * Same contract as the runCode gate: the tool must not appear in the
 * model's function list unless the Observatory is enabled (which itself
 * requires the sandbox), usable in the current context, and its execute()
 * must refuse the same way (defense in depth). Plus a happy path through
 * the registry: create a project, run in it, browse its files.
 */
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-obs-tool-test-${process.pid}.sqlite`);

// These wrapped commands boot heavy voice/music services at load time; the
// tool gate only needs the registry itself.
jest.mock('../commands/music/playtrack', () => ({ execute: jest.fn() }));
jest.mock('../commands/chat/speak', () => ({ execute: jest.fn() }));

const fs = require('node:fs');
const toolsRegistry = require('../utils/toolsRegistry');
const sandboxConfig = require('../config/sandboxConfig');
const observatoryConfig = require('../config/observatoryConfig');
const { PROJECTS_ROOT } = require('../services/observatoryService');

const names = (defs) => defs.map(d => d.name);
const original = {
    sandboxEnabled: sandboxConfig.enabled,
    sandboxScope: sandboxConfig.scope,
    obsEnabled: observatoryConfig.enabled,
    obsScope: observatoryConfig.scope
};
const TEST_USER = `obs-tool-user-${process.pid}`;

afterEach(() => {
    sandboxConfig.enabled = original.sandboxEnabled;
    sandboxConfig.scope = original.sandboxScope;
    observatoryConfig.enabled = original.obsEnabled;
    observatoryConfig.scope = original.obsScope;
});

afterAll(() => {
    try { fs.rmSync(path.join(PROJECTS_ROOT, TEST_USER), { recursive: true, force: true }); } catch { /* gone */ }
    try { fs.rmSync(process.env.GOOBSTER_DB_PATH, { force: true }); } catch { /* held open */ }
});

describe('getDefinitions gating', () => {
    test('observatory is absent when the feature is disabled', () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = false;
        expect(names(toolsRegistry.getDefinitions())).not.toContain('observatory');
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: true }))).not.toContain('observatory');
    });

    test('observatory is absent when the sandbox it rides on is disabled', () => {
        sandboxConfig.enabled = false;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'everywhere';
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: true }))).not.toContain('observatory');
    });

    test('scope "everywhere" offers observatory in any text-chat context', () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'everywhere';
        expect(names(toolsRegistry.getDefinitions())).toContain('observatory');
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: true }))).toContain('observatory');
    });

    test('scope "web" offers observatory only in the web app', () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'web';
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: false }))).not.toContain('observatory');
        expect(names(toolsRegistry.getDefinitions())).not.toContain('observatory');
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: true }))).toContain('observatory');
    });

    test('scope "web" also trusts unattended automation turns', () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'web';
        expect(names(toolsRegistry.getDefinitions(undefined, { isAutomation: true }))).toContain('observatory');
        expect(names(toolsRegistry.getDefinitions(undefined, { isWeb: false, isAutomation: false })))
            .not.toContain('observatory');
    });

    test('a name allowlist (e.g. the voice subset) never smuggles observatory in', () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'everywhere';
        const defs = toolsRegistry.getDefinitions(['performSearch', 'checkPoints']);
        expect(names(defs)).not.toContain('observatory');
    });

    test('the observatory definition is well-formed when offered', () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'everywhere';
        const def = toolsRegistry.getDefinitions().find(d => d.name === 'observatory');
        expect(def).toBeTruthy();
        expect(def.parameters.required).toEqual(['action']);
        expect(def.parameters.properties.action.enum).toEqual(expect.arrayContaining([
            'create-project', 'list', 'run', 'status', 'resume', 'cancel',
            'files', 'render', 'delete-project'
        ]));
        expect(def.description).toMatch(/GOOBSTER_PROJECT_DIR/);
        expect(def.description).toMatch(/checkpoint\.json/);
    });
});

describe('execute gating (defense in depth)', () => {
    test('refuses when disabled', async () => {
        observatoryConfig.enabled = false;
        const out = await toolsRegistry.execute('observatory', { action: 'list' });
        expect(out).toMatch(/disabled/i);
    });

    test('refuses when only the sandbox is disabled', async () => {
        sandboxConfig.enabled = false;
        observatoryConfig.enabled = true;
        const out = await toolsRegistry.execute('observatory', { action: 'list' });
        expect(out).toMatch(/disabled/i);
    });

    test('web-scoped tool refuses a non-web context', async () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'web';
        const out = await toolsRegistry.execute('observatory', {
            action: 'list',
            interactionContext: { channelId: '123456789', user: { id: TEST_USER } }
        });
        expect(out).toMatch(/web app/i);
    });

    test('refuses without a user context', async () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'everywhere';
        const out = await toolsRegistry.execute('observatory', { action: 'list' });
        expect(out).toMatch(/who you are/i);
    });

    test('web-scoped tool accepts an unattended automation context', async () => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'web';
        const out = await toolsRegistry.execute('observatory', {
            action: 'list',
            interactionContext: {
                channelId: '123456789',
                user: { id: `${TEST_USER}-automation` },
                isAutomation: true
            }
        });
        expect(out).not.toMatch(/web app/i);
        expect(out).toContain('🔭');
    });
});

describe('execute happy path (through the registry)', () => {
    const webContext = (overrides = {}) => ({
        channelId: `web:${TEST_USER}:abc`,
        user: { id: TEST_USER },
        ...overrides
    });

    beforeEach(() => {
        sandboxConfig.enabled = true;
        observatoryConfig.enabled = true;
        observatoryConfig.scope = 'web';
    });

    test('create-project, run (persisting state), files, and errors as observations', async () => {
        const created = await toolsRegistry.execute('observatory', {
            action: 'create-project', name: 'Tool Test Sim',
            interactionContext: webContext()
        });
        expect(created).toContain('tool-test-sim');
        expect(created).toContain('$GOOBSTER_PROJECT_DIR');

        const listed = await toolsRegistry.execute('observatory', {
            action: 'list', interactionContext: webContext()
        });
        expect(listed).toContain('tool-test-sim');

        const sent = [];
        const run = await toolsRegistry.execute('observatory', {
            action: 'run', project: 'tool-test-sim', language: 'bash',
            code: 'echo persisted > "$GOOBSTER_PROJECT_DIR/state.txt"; echo out.txt-content > out.txt; echo ran',
            interactionContext: webContext({
                channel: { send: async (payload) => { sent.push(payload); } }
            })
        });
        expect(run).toMatch(/✅ Ran bash/);
        expect(run).toContain('stdout');
        // The run-dir output file was attached to the chat
        expect(sent).toHaveLength(1);
        expect(sent[0].files.map(f => f.name)).toEqual(['out.txt']);

        const files = await toolsRegistry.execute('observatory', {
            action: 'files', project: 'tool-test-sim', interactionContext: webContext()
        });
        expect(files).toContain('state.txt');

        // The dashboard action regenerates and attaches the HTML artifact
        const dashSent = [];
        const dashboard = await toolsRegistry.execute('observatory', {
            action: 'dashboard', project: 'tool-test-sim',
            interactionContext: webContext({
                channel: { send: async (payload) => { dashSent.push(payload); } }
            })
        });
        expect(dashboard).toContain('📊');
        expect(dashSent).toHaveLength(1);
        expect(dashSent[0].files[0].name).toBe('tool-test-sim.html');

        // Service errors surface as recoverable observations, never throws
        const missing = await toolsRegistry.execute('observatory', {
            action: 'files', project: 'no-such-project', interactionContext: webContext()
        });
        expect(missing).toMatch(/^❌/);

        const deleted = await toolsRegistry.execute('observatory', {
            action: 'delete-project', project: 'tool-test-sim', interactionContext: webContext()
        });
        expect(deleted).toMatch(/Deleted project/);
    }, 30_000);
});
