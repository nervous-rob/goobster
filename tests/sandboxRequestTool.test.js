/**
 * The tool surface for operator-approved sandbox requests:
 * requestPythonPackages (a first-class tool, offered only where the sandbox
 * is offered AND at least one approver is configured) and the observatory
 * fetch-data action. The service itself is faked here - its behavior has
 * its own spec (sandboxRequests) - so these tests pin the offer/refuse
 * gating and the argument wiring.
 */

const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-sbxreq-tool-test-${process.pid}.sqlite`);

// These wrapped commands boot heavy voice/music services at load time; the
// registry checks only need the registry itself.
jest.mock('@goobster/core/services/sandboxRequestService', () => ({
    requestPackages: jest.fn(async () => '🟡 Proposed package install #1'),
    requestFetch: jest.fn(async () => '✅ Fetched host → data/x.csv')
}));

const sandboxRequestService = require('@goobster/core/services/sandboxRequestService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const sandboxConfig = require('@goobster/core/config/sandboxConfig');
const observatoryConfig = require('@goobster/core/config/observatoryConfig');
const sandboxService = require('@goobster/core/services/sandboxService');
const observatoryService = require('@goobster/core/services/observatoryService');

const APPROVER = '222222222222222222';

const original = {
    sandboxEnabled: sandboxConfig.enabled,
    sandboxScope: sandboxConfig.scope,
    approvers: sandboxConfig.approverUserIds,
    obsEnabled: observatoryConfig.enabled,
    obsScope: observatoryConfig.scope,
    pythonModules: sandboxService._pythonModules
};

function configure({ sandbox = true, scope = 'everywhere', approvers = [APPROVER], observatory = true } = {}) {
    sandboxConfig.enabled = sandbox;
    sandboxConfig.scope = scope;
    sandboxConfig.approverUserIds = approvers;
    observatoryConfig.enabled = observatory;
    observatoryConfig.scope = scope;
    sandboxService._pythonModules = ['numpy'];
}

afterEach(() => {
    sandboxConfig.enabled = original.sandboxEnabled;
    sandboxConfig.scope = original.sandboxScope;
    sandboxConfig.approverUserIds = original.approvers;
    observatoryConfig.enabled = original.obsEnabled;
    observatoryConfig.scope = original.obsScope;
    sandboxService._pythonModules = original.pythonModules;
    jest.clearAllMocks();
});

describe('offer gating', () => {
    const names = (opts) => toolsRegistry.getDefinitions(null, opts).map(def => def.name);

    test('offered alongside runCode when the sandbox is on and approvers exist', () => {
        configure();
        expect(names({ isWeb: true })).toEqual(expect.arrayContaining(['runCode', 'requestPythonPackages']));
    });

    test('never offered without approvers - a request would be a dead end', () => {
        configure({ approvers: [] });
        const offered = names({ isWeb: true });
        expect(offered).toContain('runCode');
        expect(offered).not.toContain('requestPythonPackages');
    });

    test('never offered when the sandbox is off, and follows the web scope', () => {
        configure({ sandbox: false });
        expect(names({ isWeb: true })).not.toContain('requestPythonPackages');
        configure({ scope: 'web' });
        expect(names({ isWeb: false })).not.toContain('requestPythonPackages');
        expect(names({ isWeb: true })).toContain('requestPythonPackages');
    });
});

describe('requestPythonPackages execution', () => {
    test('wires user, packages, reason, and client through to the service', async () => {
        configure();
        const client = { fake: true };
        const out = await toolsRegistry.execute('requestPythonPackages', {
            packages: ['emcee'],
            reason: 'MCMC fits',
            interactionContext: { channelId: 'web:u:1', user: { id: 'u1' }, client }
        });
        expect(out).toContain('🟡');
        expect(sandboxRequestService.requestPackages).toHaveBeenCalledWith({
            userId: 'u1', packages: ['emcee'], reason: 'MCMC fits', client
        });
    });

    test('refuses outside the trusted surface when scope is web', async () => {
        configure({ scope: 'web' });
        const out = await toolsRegistry.execute('requestPythonPackages', {
            packages: ['emcee'],
            interactionContext: { channelId: '123456', user: { id: 'u1' } }
        });
        expect(out).toContain('❌');
        expect(sandboxRequestService.requestPackages).not.toHaveBeenCalled();
    });

    test('automation turns count as a trusted surface', async () => {
        configure({ scope: 'web' });
        const out = await toolsRegistry.execute('requestPythonPackages', {
            packages: ['emcee'],
            interactionContext: { channelId: '123456', isAutomation: true, user: { id: 'u1' } }
        });
        expect(out).toContain('🟡');
    });

    test('a service error surfaces as a recoverable observation, never a throw', async () => {
        configure();
        sandboxRequestService.requestPackages.mockRejectedValueOnce(
            Object.assign(new Error('Too many sandbox requests'), { code: 'RATE_LIMITED' }));
        const out = await toolsRegistry.execute('requestPythonPackages', {
            packages: ['emcee'],
            interactionContext: { channelId: 'web:u:1', user: { id: 'u1' } }
        });
        expect(out).toBe('❌ Too many sandbox requests');
    });
});

describe('observatory fetch-data action', () => {
    test('routes to the request service with the project and URL', async () => {
        configure();
        const enabled = jest.spyOn(observatoryService, 'enabled', 'get').mockReturnValue(true);
        const client = { fake: true };
        const out = await toolsRegistry.execute('observatory', {
            action: 'fetch-data',
            project: 'jwst-atlas',
            url: 'https://mast.stsci.edu/x.fits',
            saveAs: 'wasp39b.fits',
            reason: 'transmission spectrum',
            interactionContext: { channelId: 'web:u:1', user: { id: 'u1' }, client }
        });
        expect(out).toContain('✅ Fetched');
        expect(sandboxRequestService.requestFetch).toHaveBeenCalledWith({
            userId: 'u1', project: 'jwst-atlas', url: 'https://mast.stsci.edu/x.fits',
            saveAs: 'wasp39b.fits', reason: 'transmission spectrum', client
        });
        enabled.mockRestore();
    });

    test('the observatory description advertises fetch-data and the enum accepts it', () => {
        configure();
        const def = toolsRegistry.getDefinitions(['observatory'], { isWeb: true })[0];
        expect(def.description).toContain('fetch-data');
        expect(def.parameters.properties.action.enum).toContain('fetch-data');
        expect(def.parameters.properties.url).toBeDefined();
    });
});
