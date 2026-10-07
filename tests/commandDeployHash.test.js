/**
 * Slash-command deployment on a changed hash (#325 requirement 5): one
 * acknowledged hash per actual target (each guild, global), stored only
 * after Discord accepted that target, so a failure retries on the next
 * start and a guild list change deploys exactly the new guild.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    DEPLOY_STATE_FILE,
    LEGACY_DEPLOY_HASH_FILE,
    computeDeployHash,
    deployCommandsIfChanged,
    deployTargets,
    readDeployState
} = require('@goobster/core/utils/commandDeployment');

const routes = {
    applicationGuildCommands: (clientId, guildId) => `/applications/${clientId}/guilds/${guildId}/commands`,
    applicationCommands: clientId => `/applications/${clientId}/commands`
};

function fakeRest({ existingGlobal = [], failOn = () => false } = {}) {
    const puts = [];
    return {
        puts,
        async get() {
            return existingGlobal;
        },
        async put(route, { body }) {
            if (failOn(route)) {
                const error = new Error('Discord said no');
                error.code = 50001;
                throw error;
            }
            puts.push({ route, body });
            return body;
        }
    };
}

const BASE = {
    clientId: '111',
    guildIds: ['222'],
    guildCommands: [{ name: 'roll' }],
    globalCommands: [{ name: 'chat' }],
    activeFeatures: ['core', 'tavern']
};

let dataDir;
beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-command-deploy-'));
});
afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const deploy = (rest, overrides = {}) => deployCommandsIfChanged({ rest, routes, dataDir, ...BASE, ...overrides });
const stored = () => readDeployState(path.join(dataDir, DEPLOY_STATE_FILE));

describe('deployCommandsIfChanged', () => {
    test('deploys every target once, then skips while nothing changed', async () => {
        const rest = fakeRest();
        const first = await deploy(rest);
        expect(first.deployed.sort()).toEqual(['global:111', 'guild:111:222']);
        expect(first.failed).toEqual([]);
        expect(Object.keys(stored().targets).sort()).toEqual(['global:111', 'guild:111:222']);

        const again = fakeRest();
        const second = await deploy(again);
        expect(second.deployed).toEqual([]);
        expect(second.skipped.sort()).toEqual(['global:111', 'guild:111:222']);
        expect(again.puts).toEqual([]);
    });

    test('a failed deploy stores no hash for that target, and the next start retries only it', async () => {
        const failing = fakeRest({ failOn: route => route === '/applications/111/commands' });
        const outcome = await deploy(failing);
        expect(outcome.deployed).toEqual(['guild:111:222']);
        expect(outcome.failed.map(item => item.key)).toEqual(['global:111']);
        expect(outcome.failed[0].error.code).toBe(50001);
        expect(stored().targets['global:111']).toBeUndefined();
        expect(stored().targets['guild:111:222'].hash).toBe(deployTargets(BASE)[0].hash);

        const retry = fakeRest();
        const next = await deploy(retry);
        expect(next.deployed).toEqual(['global:111']);
        expect(next.skipped).toEqual(['guild:111:222']);
        expect(retry.puts.map(put => put.route)).toEqual(['/applications/111/commands']);
    });

    test('a REST fake that throws everywhere leaves the stored state unchanged', async () => {
        await deploy(fakeRest());
        const before = fs.readFileSync(path.join(dataDir, DEPLOY_STATE_FILE), 'utf8');
        const outcome = await deploy(fakeRest({ failOn: () => true }), { guildCommands: [{ name: 'roll' }, { name: 'flip' }] });
        expect(outcome.failed.map(item => item.key)).toEqual(['guild:111:222']);
        expect(fs.readFileSync(path.join(dataDir, DEPLOY_STATE_FILE), 'utf8')).toBe(before);
    });

    test('a guild list change deploys the new guild only and forgets the removed one', async () => {
        await deploy(fakeRest());
        const rest = fakeRest();
        const outcome = await deploy(rest, { guildIds: ['333'] });
        expect(outcome.deployed).toEqual(['guild:111:333']);
        expect(outcome.skipped).toEqual(['global:111']);
        expect(rest.puts.map(put => put.route)).toEqual(['/applications/111/guilds/333/commands']);
        expect(Object.keys(stored().targets).sort()).toEqual(['global:111', 'guild:111:333']);

        const back = fakeRest();
        expect((await deploy(back)).deployed).toEqual(['guild:111:222']);
    });

    test('another application id is another scope', async () => {
        await deploy(fakeRest());
        const outcome = await deploy(fakeRest(), { clientId: '999' });
        expect(outcome.deployed.sort()).toEqual(['global:999', 'guild:999:222']);
        expect(Object.keys(stored().targets).sort()).toEqual(['global:111', 'global:999', 'guild:111:222', 'guild:999:222']);
    });

    test('a payload change redeploys its target; a feature-set change redeploys all', async () => {
        await deploy(fakeRest());
        const payload = await deploy(fakeRest(), { globalCommands: [{ name: 'chat' }, { name: 'inbox' }] });
        expect(payload.deployed).toEqual(['global:111']);
        const featureFlip = await deploy(fakeRest(), { globalCommands: [{ name: 'chat' }, { name: 'inbox' }], activeFeatures: ['core'] });
        expect(featureFlip.deployed.sort()).toEqual(['global:111', 'guild:111:222']);
    });

    test('the Activity Entry Point command is carried through the global overwrite', async () => {
        const entryPoint = { id: '9', name: 'launch', type: 4 };
        const rest = fakeRest({ existingGlobal: [entryPoint, { id: '8', name: 'old', type: 1 }] });
        await deploy(rest);
        const global = rest.puts.find(put => put.route === '/applications/111/commands');
        expect(global.body).toEqual([entryPoint, { name: 'chat' }]);
    });

    test('--force deploys acknowledged targets anyway', async () => {
        await deploy(fakeRest());
        const outcome = await deploy(fakeRest(), { force: true });
        expect(outcome.deployed.sort()).toEqual(['global:111', 'guild:111:222']);
    });

    test('a matching legacy .command-deploy-hash counts as acknowledged; a stale one does not', async () => {
        const legacyHash = computeDeployHash(BASE);
        fs.writeFileSync(path.join(dataDir, LEGACY_DEPLOY_HASH_FILE), legacyHash);
        const migrated = await deploy(fakeRest(), { legacyHash });
        expect(migrated.deployed).toEqual([]);
        expect(migrated.skipped.sort()).toEqual(['global:111', 'guild:111:222']);
        expect(Object.keys(stored().targets).sort()).toEqual(['global:111', 'guild:111:222']);

        fs.rmSync(path.join(dataDir, DEPLOY_STATE_FILE));
        fs.writeFileSync(path.join(dataDir, LEGACY_DEPLOY_HASH_FILE), 'stale');
        const stale = await deploy(fakeRest(), { legacyHash });
        expect(stale.deployed.sort()).toEqual(['global:111', 'guild:111:222']);
    });

    test('an unreadable state file deploys everything instead of trusting it', async () => {
        fs.writeFileSync(path.join(dataDir, DEPLOY_STATE_FILE), '{ not json');
        const outcome = await deploy(fakeRest());
        expect(outcome.deployed.sort()).toEqual(['global:111', 'guild:111:222']);
        expect(stored().version).toBe(1);
    });

    test('deploy-commands.js deploys through the helper and no longer writes the single hash file', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'bot', 'deploy-commands.js'), 'utf8');
        expect(source).toMatch(/deployCommandsIfChanged\(/);
        expect(source).not.toMatch(/writeFileSync\(/);
        expect(source).toMatch(/runtime\/lifecycle'\)\.boot\(\{ worker: 'bot' \}\)/);
    });
});
