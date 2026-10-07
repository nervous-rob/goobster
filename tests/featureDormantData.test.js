/**
 * Dormant-data regression (#322).
 *
 * Turning a feature off stops its workers, tools, routes and commands; it
 * must never strand, hide, or silently delete a person's data. This spec
 * seeds per-user rows for TWO accounts across every feature that owns
 * per-user tables, writes a features.json that turns every optional feature
 * off, and then runs the REAL privacy, export and retention services:
 *
 *   - buildUserReport / auditUser still list the data
 *   - the account export still carries it (and only the owner's)
 *   - the ledger retention sweep still prunes; the feature rows are untouched
 *   - an off -> on round trip changes nothing
 *   - forgetUser erases account A (cleanupVecIndex leaves no orphan vectors)
 *     while account B's rows are byte-identical afterwards, and still are
 *     when the features come back on
 *   - none of it starts a feature worker, calls a provider, runs a feature
 *     tool or touches the network
 *
 * Throwaway database (SQLite file, or an isolated schema on Postgres), no
 * Discord token, no key, no network.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-dormant-data-'));
process.env.GOOBSTER_DATA_DIR = ROOT;
process.env.GOOBSTER_UPLOADS_DIR = path.join(ROOT, 'uploads');
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'test.sqlite');

jest.mock('@goobster/core/services/aiService', () => ({
    chat: jest.fn(),
    generateText: jest.fn().mockResolvedValue(''),
    listProviders: () => [],
    supportsNativeWebSearch: jest.fn().mockReturnValue(false)
}));

const db = require('@goobster/core/db');
const inventory = require('@goobster/core/features/inventory');
const aiService = require('@goobster/core/services/aiService');
const privacyService = require('@goobster/core/services/privacyService');
const memoryService = require('@goobster/core/services/memoryService');
const ledgerRetentionService = require('@goobster/core/services/ledgerRetentionService');
const chatHistoryRetentionService = require('@goobster/core/services/chatHistoryRetentionService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const { AccountExportService } = require('@goobster/core/services/accountExportService');
const { snapshot, INVENTORY: EXPORT_INVENTORY } = require('@goobster/core/services/accountExportData');
const { startCoreRuntime } = require('@goobster/core/runtime/coreRuntime');
const { features } = require('@goobster/core/features/featureState');
const {
    MANAGEABLE,
    FEATURE_STEPS,
    MARKERS,
    useState,
    fakeDeps,
    quiet,
    FAKE_CLIENT
} = require('./helpers/featureFixtures');

const {
    A, B, GUILD, CHANNEL, TABLES, createDormantSeed, unpackTarGz: unpack
} = require('./helpers/dormantSeed');

const { seedAccount, rowsOf, countOf, totalOf, captureFor, vecOrphans } = createDormantSeed(db);

/**
 * Tables the inventory gives to a feature that carry a person-shaped column
 * but are deliberately not per-account in this spec, with the reason. A new
 * feature table with a user column must be seeded in helpers/dormantSeed.js or listed here.
 */
const NOT_SEEDED = {
    project_asset_versions: 'projects: reached through project_assets by the same userId erasure (privacyService.test.js seeds it)',
    project_decisions: 'projects: same erasure path as project_assets (privacyService.test.js)',
    project_invites: 'projects: invitee/inviter ids, erased with project_members (privacyService.test.js)',
    project_members: 'projects: membership rows, erased by userId (privacyService.test.js)',
    project_mission_approval_receipts: 'projects: erased with the mission rows (privacyService.test.js)',
    project_mission_events: 'projects: erased with the mission rows (privacyService.test.js)',
    project_mission_evidence: 'projects: erased with the mission rows (privacyService.test.js)',
    project_mission_steps: 'projects: erased with the mission rows (privacyService.test.js)',
    project_missions: 'projects: erased by userId (privacyService.test.js)',
    project_trigger_deliveries: 'projects: no user column, keyed by trigger',
    project_triggers: 'projects: erased by userId (privacyService.test.js)',
    spitball_expedition_cycles: 'expeditions: no user column, keyed by expedition (cascades)',
    research_claims: 'expeditions: no user column, keyed by expedition (cascades)',
    corporate_actions: 'exchange: guild-wide market data, no person',
    economy_settings: 'economy: guild settings, no person',
    exchange_settings: 'exchange: guild settings, no person',
    stock_prices: 'exchange: market data, no person',
    stock_symbols: 'exchange: market data, no person',
    table_games: 'gambling: shared table state, no per-user column',
    tavern_lore: 'tavern: guild lore, no person',
    gba_run_clients: 'gba: one pairing per guild channel, no per-user table (documentation/goobster_plays_pokemon.md)',
    gba_run_milestones: 'gba: guild-level text, reached only by the name-mention review pass (documentation/goobster_plays_pokemon.md)'
};

/** Seeded tables the account export deliberately leaves out, with the reason. */
const NOT_EXPORTED = {
    prediction_markets: 'a guild market: the person is attributed as creator, the market is not theirs',
    tavern_adventures: 'a guild adventure: the person is attributed as creator, the scene state is shared',
    observatory_share_links: 'the share token is a bearer credential; the project it opens is exported'
};

const PERSON_COLUMN = /user|owner|by$|member|author|requested|payer|started/i;

/** Everything a feature would run if it were on: none of it may be called by data-rights paths. */
function featureJobSpies() {
    const wheelService = require('@goobster/core/services/exchange/wheelService');
    const observatoryService = require('@goobster/core/services/observatoryService');
    const spitballExpeditionRunner = require('@goobster/core/services/spitballExpeditionRunner');
    const projectTriggerService = require('@goobster/core/services/projectTriggerService');
    const knowledgeReflectionService = require('@goobster/core/services/knowledgeReflectionService');
    const pushService = require('@goobster/core/services/pushService');
    const sandboxService = require('@goobster/core/services/sandboxService');
    return {
        fetch: jest.spyOn(global, 'fetch'),
        chat: aiService.chat,
        generateText: aiService.generateText,
        spin: jest.spyOn(wheelService, 'spin'),
        resume: jest.spyOn(observatoryService, 'autoResumeInterrupted'),
        expeditions: jest.spyOn(spitballExpeditionRunner, 'kick'),
        expeditionStart: jest.spyOn(spitballExpeditionRunner, 'start'),
        triggers: jest.spyOn(projectTriggerService, 'catchUpEventTriggers'),
        reflection: jest.spyOn(knowledgeReflectionService, 'start'),
        push: jest.spyOn(pushService, '_sendOne'),
        sandbox: jest.spyOn(sandboxService, 'run')
    };
}

function expectNoFeatureWork(spies) {
    for (const [name, spy] of Object.entries(spies)) {
        expect([name, spy.mock.calls.length]).toEqual([name, 0]);
    }
}

let spies;
let beforeA;
let beforeB;
let service;
const exported = {};

beforeAll(async () => {
    await seedAccount(A, 'A');
    await seedAccount(B, 'B');
    await memoryService.syncVecIndex();
    service = new AccountExportService({
        autoKick: false,
        root: path.join(ROOT, 'exports'),
        settings: async () => ({ schemaVersion: 1, settings: {} })
    });
    beforeA = await captureFor(A);
    beforeB = await captureFor(B);
    useState({ inactive: MANAGEABLE });
    spies = featureJobSpies();
});

afterAll(async () => {
    jest.restoreAllMocks();
    await service.stop();
    features._resetForTests({});
    await db.closeConnection();
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('the seed and the inventory agree', () => {
    test('every seeded table is owned by the feature the spec says, and every optional feature that owns tables is represented', () => {
        for (const { feature, table } of TABLES) {
            expect([table, inventory.ownerOf('table', table)?.owner]).toEqual([table, feature]);
        }
        const represented = new Set(TABLES.map(entry => entry.feature));
        for (const id of ['economy', 'exchange', 'gambling', 'tavern', 'music', 'push', 'sandbox', 'cursor',
            'github', 'screenVision', 'mcp', 'projects', 'observatory', 'expeditions']) {
            expect([id, represented.has(id)]).toEqual([id, true]);
        }
    });

    test('every feature-owned table with a person-shaped column is seeded or explained', async () => {
        const seeded = new Set(TABLES.map(entry => entry.table));
        const tables = await db.all(
            process.env.GOOBSTER_DB_URL
                ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'"
                : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        );
        const unexplained = [];
        for (const { name } of tables) {
            const owner = inventory.ownerOf('table', name)?.owner;
            if (!owner || owner === 'core' || name.includes('vec')) continue;
            const columns = process.env.GOOBSTER_DB_URL
                ? (await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = @name', { name })).map(row => row.name)
                : (await db.all(`PRAGMA table_info(${name})`)).map(row => row.name);
            if (!columns.some(column => PERSON_COLUMN.test(column) && !/At$/.test(column) && column !== 'cancelRequested')) continue;
            if (seeded.has(name) || NOT_SEEDED[name]) continue;
            unexplained.push(`${owner}:${name}`);
        }
        expect(unexplained).toEqual([]);
    });

    test('both accounts really hold data before anything is switched off', async () => {
        for (const { table, column, accounts } of TABLES) {
            expect([table, await countOf(table, column, A)]).toEqual([table, accounts?.A ?? 1]);
            expect([table, await countOf(table, column, B)]).toEqual([table, accounts?.B ?? 1]);
        }
    });
});

describe('with every optional feature off the data is still reported, exported and prunable', () => {
    test('the state really refuses every optional feature', () => {
        for (const id of MANAGEABLE) expect([id, features.enforcedOff(id)]).toEqual([id, true]);
    });

    test('no feature worker starts, no feature tool runs, no provider is called', async () => {
        const log = [];
        const runtime = await startCoreRuntime({ client: FAKE_CLIENT, logger: quiet(), deps: fakeDeps(log) });
        try {
            expect(runtime.featureSkipped.sort()).toEqual([...FEATURE_STEPS].sort());
            for (const name of FEATURE_STEPS) expect([name, log.includes(MARKERS[name])]).toEqual([name, false]);
        } finally {
            await runtime.stop();
        }

        const writes = [jest.spyOn(db, 'run'), jest.spyOn(db, 'insert'), jest.spyOn(db, 'transaction')];
        const context = { guildId: GUILD, channelId: CHANNEL, user: { id: A }, member: { id: A }, guild: { id: GUILD } };
        const offered = (await toolsRegistry.getDefinitions(undefined, { isWeb: true })).map(def => def.name);
        for (const [tool, args, feature] of [
            ['checkPoints', {}, 'economy'],
            ['tradeStock', { action: 'buy', symbol: 'AAPL', units: 1 }, 'exchange'],
            ['gamblePoints', { game: 'poker', bet: 5 }, 'gambling'],
            ['rollDice', { notation: '1d20' }, 'tavern'],
            ['runCode', { language: 'python', code: 'print(1)' }, 'sandbox'],
            ['launchCursorAgent', { prompt: 'x' }, 'cursor'],
            ['searchGithubCode', { query: 'x' }, 'github']
        ]) {
            expect([tool, offered.includes(tool)]).toEqual([tool, false]);
            const result = await toolsRegistry.execute(tool, { ...args, interactionContext: context });
            expect(result).toMatchObject({ ok: false, code: 'FEATURE_UNAVAILABLE', feature });
        }
        for (const spy of writes) {
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        }
        expectNoFeatureWork(spies);
    });

    test('auditUser lists the rows of the dormant features for each account', async () => {
        for (const userId of [A, B]) {
            const audit = await privacyService.auditUser({ userId });
            const missing = TABLES
                .filter(({ table, accounts, audit: key }) => (userId === A ? accounts?.A ?? 1 : accounts?.B ?? 1) > 0 && !((key || table) in audit.byTable))
                .map(({ table }) => table);
            expect(missing).toEqual([]);
            for (const { table, accounts, audit: key } of TABLES) {
                const expected = userId === A ? accounts?.A ?? 1 : accounts?.B ?? 1;
                if (expected > 0) expect([table, audit.byTable[key || table] > 0]).toEqual([table, true]);
            }
        }
    });

    test('buildUserReport lists them too', async () => {
        const report = await privacyService.buildUserReport({ guildId: GUILD, userId: A });
        expect(report.economy).toMatchObject({ balance: 750, transactions: 1, stockHoldings: 1, stockTrades: 1 });
        expect(report.exchange).toMatchObject({ shortPositions: 1, optionPositions: 1, optionTrades: 1, orders: 1, perpPositions: 1, groupOptIns: 1 });
        expect(report.observatory).toMatchObject({ projects: 1, jobs: 1, assets: 1, sharedDashboards: 1 });
        expect(report.spitball).toMatchObject({ expeditions: 1, researchSources: 1 });
        expect(report.spitball.briefs.total).toBe(1);
        expect(report.developerIntegrations).toEqual({ agentRuns: 1, pendingActions: 1, auditEntries: 1, repoWatches: 1 });
        expect(report.screenVision).toMatchObject({ paired: true });
        expect(report.studioSongs).toBeTruthy();
        const text = JSON.stringify(report);
        for (const secret of ['hash-secret', 'ghp-secret', 'mcp-hash', 'p256dh-secret', 'auth-secret', 'refactor the parser']) {
            expect([secret, text.includes(secret)]).toEqual([secret, false]);
        }
        expectNoFeatureWork(spies);
    });

    test('the account export still carries the person\'s rows, and only theirs', async () => {
        const data = await snapshot(A);
        const exportedTables = new Set(EXPORT_INVENTORY.map(([table]) => table));
        const notExported = TABLES.filter(({ table }) => !exportedTables.has(table)).map(({ table }) => table);
        expect(notExported.sort()).toEqual(Object.keys(NOT_EXPORTED).sort());
        for (const { table } of TABLES) {
            if (notExported.includes(table)) continue;
            expect([table, (data[table] || []).length > 0]).toEqual([table, true]);
        }
        const text = JSON.stringify(data);
        for (const secret of ['hash-secret', 'ghp-secret', 'mcp-hash', 'p256dh-secret', 'auth-secret', 'person-b', 'Hero b']) {
            expect([secret, text.includes(secret)]).toEqual([secret, false]);
        }

        const job = await service.request(A);
        await service.sweep();
        const ready = (await service.list(A)).exports.find(entry => entry.id === job.id);
        expect(ready.status).toBe('READY');
        const download = await service.download(A, job.id);
        await download.handle.close();
        const files = await unpack(path.join(service.directory({ ...job, userId: A }), 'account.tar.gz'));
        exported.names = [...files.keys()];
        expect(files.get('data/economy_wallets.json').toString()).toContain(A);
        expect(files.get('data/tavern_characters.json').toString()).toContain('Hero a');
        expect(files.get('data/agent_runs.json').toString()).toContain(A);
        expect([...files.values()].map(buffer => buffer.toString()).join('\n')).not.toContain('person-b');
        expectNoFeatureWork(spies);
    });

    test('push is the one outbound echo of the Inbox: with push off a stored device is kept and nothing is sent to it', async () => {
        const pushService = require('@goobster/core/services/pushService');
        const before = await rowsOf('push_subscriptions', 'userId', A);
        expect(before).toHaveLength(1);
        const summary = await pushService.notify({ userId: A, title: 'Your export is ready' });
        expect(summary).toEqual({ sent: 0, failed: 0, pruned: 0, skipped: true });
        expect(await rowsOf('push_subscriptions', 'userId', A)).toEqual(before);
        expect(await pushService.countForUser(A)).toBe(1);
        expectNoFeatureWork(spies);
    });

    test('the retention sweeps still prune what retention owns and leave the dormant rows alone', async () => {
        const oldBefore = Number((await db.get("SELECT COUNT(*) AS c FROM resource_events WHERE kind = 'sandbox_run' AND createdAt < @cutoff", { cutoff: '2021-01-01 00:00:00' })).c);
        expect(oldBefore).toBe(2);

        const ledger = await ledgerRetentionService.sweep();
        expect(ledger.skipped).toBe(false);
        expect(ledger.resourceEvents).toBe(2);
        expect(Number((await db.get("SELECT COUNT(*) AS c FROM resource_events WHERE kind = 'sandbox_run'")).c)).toBe(2);
        await chatHistoryRetentionService.sweep();

        expect(await captureFor(A)).toEqual(beforeA);
        expect(await captureFor(B)).toEqual(beforeB);
        expectNoFeatureWork(spies);
    });

    test('off -> on round trip: with no privacy or retention action every row is exactly as seeded', async () => {
        useState();
        expect(await captureFor(A)).toEqual(beforeA);
        expect(await captureFor(B)).toEqual(beforeB);
        useState({ inactive: MANAGEABLE });
        expect(await captureFor(A)).toEqual(beforeA);
        expect(await captureFor(B)).toEqual(beforeB);
    });
});

describe('forgetUser while the features are off', () => {
    const totals = {};

    test('erases account A everywhere, keeps guild-wide rows anonymised, and removes no vector from under a surviving memory', async () => {
        for (const { table } of TABLES) totals[table] = await totalOf(table);
        expect(await vecOrphans()).toEqual({ indexed: 2, stored: 2 });

        const result = await privacyService.forgetUser({ userId: A });
        expect(result).toBeTruthy();

        const audit = await privacyService.auditUser({ userId: A });
        const remaining = Object.entries(audit.byTable).filter(([, count]) => count > 0).map(([table]) => table);
        const optionalRemaining = remaining.filter(table => TABLES.some(entry => entry.table === table));
        expect(optionalRemaining).toEqual([]);

        for (const { table, column, kept, accounts } of TABLES) {
            expect([table, await countOf(table, column, A)]).toEqual([table, 0]);
            const lost = kept ? 0 : accounts?.A ?? 1;
            expect([table, await totalOf(table)]).toEqual([table, totals[table] - lost]);
        }

        expect(await vecOrphans()).toEqual({ indexed: 1, stored: 1 });
        const orphans = await db.get('SELECT COUNT(*) AS c FROM memory_embeddings WHERE authorId = @u', { u: A });
        expect(Number(orphans.c)).toBe(0);
        expectNoFeatureWork(spies);
    });

    test('the ledger keeps its rows and loses the actor', async () => {
        expect(Number((await db.get("SELECT COUNT(*) AS c FROM resource_events WHERE kind = 'sandbox_run'")).c)).toBe(2);
        expect(Number((await db.get('SELECT COUNT(*) AS c FROM resource_events WHERE actor = @u', { u: A })).c)).toBe(0);
        expect(Number((await db.get('SELECT COUNT(*) AS c FROM resource_events WHERE actor = @u', { u: B })).c)).toBe(1);
    });

    test('account B is byte-identical, and still is after the features come back on', async () => {
        expect(await captureFor(B)).toEqual(beforeB);
        expect(Number((await db.get('SELECT COUNT(*) AS c FROM users WHERE discordId = @u', { u: B })).c)).toBe(1);

        useState();
        expect(await captureFor(B)).toEqual(beforeB);
        expect(await captureFor(A)).toEqual(Object.fromEntries(TABLES.map(({ table }) => [table, []])));

        const audit = await privacyService.auditUser({ userId: B });
        for (const { table, accounts, audit: key } of TABLES) {
            if ((accounts?.B ?? 1) > 0) expect([table, audit.byTable[key || table] > 0]).toEqual([table, true]);
        }
        expectNoFeatureWork(spies);
    });
});
