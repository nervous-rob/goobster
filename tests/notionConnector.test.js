/**
 * The Notion connector (DA-11e, ADR 0030; documentation/delegated_notion.md).
 *
 * The properties under test: one grant reaches one page or database and
 * what is inside it, and nothing else the person's token could see; reads
 * return page text and database rows; every write (append, create a page,
 * edit a block, set page properties) lands once, can be told from "did not
 * happen" after a lost answer, and is safe to make again; Notion's own
 * refusal is "nothing changed" while a lost answer is not; and moving
 * something to the trash is never done by a run.
 *
 * Runs against an in-memory Notion (tests/helpers/fakeNotion.js) standing
 * in for `notionService._request`. The model is scripted. Nothing here
 * talks to Notion.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-notion-connector-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const registry = require('@goobster/core/services/assistant/connectors/registry');
const manifest = require('@goobster/core/services/assistant/connectors/notion');
const notionService = require('@goobster/core/services/notionService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runs = require('@goobster/core/services/assistantRunService');
const runner = require('@goobster/core/services/assistantRunnerService');
const policies = require('@goobster/core/services/attentionPolicyService');
const access = require('@goobster/core/services/assistantAccessService');
const connectorService = require('@goobster/core/services/assistantConnectorService');
const requests = require('@goobster/core/services/assistantConnectorRequestService');
const gates = require('@goobster/core/services/assistantGateService');
const inbox = require('@goobster/core/services/inboxService');
const identityService = require('@goobster/core/services/identityService');
const instanceState = require('@goobster/core/services/instanceStateService');
const { useState } = require('./helpers/featureFixtures');
const { createFakeNotion } = require('./helpers/fakeNotion');

const { internals } = manifest;
const A = `79${String(process.pid).padStart(8, '0')}00000001`;
const B = `79${String(process.pid).padStart(8, '0')}00000002`;
const TOKEN = 'secret_notion_token_of_the_owner';
const fake = createFakeNotion();

// Fixed ids, as a person would paste them.
const PLAN = 'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaa1';
const YEAR = 'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaa2';
const TASKS = 'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaa3';
const DIARY = 'bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbb1';
const HIDDEN = 'bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbb2';
const BOOKS = 'cccccccccccc4ccc8ccccccccccccccc';
const MISSING = 'dddddddddddd4ddd8ddddddddddddddd';

const connector = () => registry.get('notion');
const op = (kind, name) => registry.operationOf(connector(), kind, name);
const read = (name, input = {}, resource = PLAN) => op('read', name).run({ resource, input, token: TOKEN });
const write = (name, input, { resource = PLAN, operationId = '1:1' } = {}) => op('write', name).run({ resource, input, token: TOKEN, operationId });
const reconcile = (name, input, { resource = PLAN, operationId = '1:1' } = {}) => op('write', name).reconcile({ resource, input, token: TOKEN, operationId });
const caught = (promise) => Promise.resolve(promise).then(() => null, error => error);
const markers = (id) => fake.texts(id).filter(text => text.startsWith(internals.MARKER_PREFIX));
const blockId = (parent, text) => {
    const found = fake.request(TOKEN, `/v1/blocks/${parent}/children`, { params: { page_size: 100 } });
    return found.then(batch => batch.results.find(block => JSON.stringify(block).includes(text))?.id);
};

/** The workspace every test starts from. */
function seed() {
    fake.reset();
    internals.forgetKinds();
    fake.allow(TOKEN);
    fake.addPage({
        id: PLAN, title: 'Decade plan',
        blocks: [
            { type: 'heading_1', text: 'Goals' },
            'Run a marathon',
            { type: 'to_do', text: 'Book the trip', checked: false },
            { type: 'toggle', text: 'Details', children: ['Nested note', { type: 'bulleted_list_item', text: 'Deeper', children: ['Deepest'] }] },
            { type: 'divider' }
        ]
    });
    fake.addPage({ id: YEAR, parent: PLAN, title: 'Year one', blocks: ['Start small'] });
    fake.addDatabase({
        id: TASKS, parent: PLAN, title: 'Tasks',
        properties: { Name: 'title', Status: 'select', Done: 'checkbox', Due: 'date', Count: 'number', Tags: 'multi_select', Notes: 'rich_text', Owner: 'people' }
    });
    fake.addPage({ parent: TASKS, title: 'Buy shoes', properties: { Status: { select: { name: 'Todo' } } }, blocks: ['Size 44'] });
    fake.addPage({ parent: TASKS, title: 'Find a route', properties: { Status: { select: { name: 'Doing' } } } });
    // The same token can see these; no grant in this file names them unless a test says so.
    fake.addPage({ id: DIARY, title: 'Private diary', blocks: ['DIARY-SECRET the gate code is 1234'] });
    fake.addPage({ id: HIDDEN, title: 'Not shared', shared: false, blocks: ['never visible'] });
    fake.addDatabase({ id: BOOKS, title: 'Books', properties: { Title: 'title', Rating: 'number' } });
    fake.addPage({ parent: BOOKS, title: 'Dune', properties: { Rating: { number: 5 } } });
    fake.state.calls.length = 0;
    fake.state.tokensSeen.clear();
}

beforeAll(() => { fake.install(); });

afterAll(async () => {
    fake.uninstall();
    initiatives.stopListening();
    useState();
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await db.run('DELETE FROM user_integrations WHERE userId IN (@a, @b)', { a: A, b: B });
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    runner._reset();
    seed();
    for (const table of [
        'assistant_connector_requests', 'assistant_run_operations', 'assistant_runs', 'assistant_initiatives',
        'assistant_source_cursors', 'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions',
        'assistant_responsibilities', 'attention_policies', 'attention_items', 'inbox_items', 'usage_reservations',
        'work_failures', 'resource_events', 'user_integrations', 'user_settings'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    await instanceState.remove(access.KEY_PILOT);
    await db.run('DELETE FROM app_accounts WHERE principalId IN (@a, @b)', { a: A, b: B });
    await identityService.ensureLegacyPrincipal({ discordId: A, displayName: 'owner' });
    await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
    await identityService.ensureLegacyPrincipal({ discordId: B, displayName: 'member' });
    await db.run(
        "INSERT INTO user_integrations (userId, provider, token, accountLabel) VALUES (@userId, 'notion', @token, 'Fake workspace')",
        { userId: A, token: TOKEN }
    );
});

describe('the manifest', () => {
    test('ships registered, with the owner\'s decision, the person\'s own notion credential and no feature of its own', () => {
        expect(require('@goobster/core/services/assistant/connectors/shipped')).toEqual([manifest]);
        const described = registry.describe(connector());
        expect(described).toMatchObject({
            id: 'notion', name: 'Notion', provider: 'notion', feature: null,
            decision: { recordedBy: 'Rob (owner)', recordedAt: '2026-11-09', reference: expect.stringContaining('ADR 0030') },
            reads: [{ operation: 'page' }, { operation: 'blocks' }, { operation: 'rows' }],
            writes: [
                { operation: 'append', reconcilable: true }, { operation: 'createPage', reconcilable: true },
                { operation: 'updateBlock', reconcilable: true }, { operation: 'updatePage', reconcilable: true }
            ],
            asks: [{ operation: 'archive', action: 'Move it to the trash' }]
        });
        // Nothing that deletes or archives is a write a grant can allow.
        expect(connector().writes.map(entry => entry.operation).filter(name => /archiv|delet|trash|remove/i.test(name))).toEqual([]);
        expect(connector().testOnly).toBeFalsy();
    });

    test('a resource is 32 hex characters; a pasted link or a dashed id is turned into them', async () => {
        const { canonical } = internals;
        expect(canonical(PLAN)).toBe(PLAN);
        expect(canonical('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1')).toBe(PLAN);
        expect(canonical(`https://www.notion.so/rob/Decade-plan-${PLAN}`)).toBe(PLAN);
        expect(canonical(`https://www.notion.so/${BOOKS}?v=${MISSING}`)).toBe(BOOKS);
        expect(canonical(`https://www.notion.so/rob/Decade-plan-${PLAN}?pvs=4#${MISSING}`)).toBe(PLAN);
        // A title that ends in hex letters is not part of the id.
        expect(canonical(`https://www.notion.so/rob/My-cafe-${PLAN}`)).toBe(PLAN);
        for (const junk of ['', 'decade plan', 'https://www.notion.so/rob', '*', `${PLAN}0`, `x${PLAN}`, 'aaaa', `${PLAN} ${BOOKS}`]) {
            expect(canonical(junk)).toBeNull();
        }

        expect(registry.canonicalRef(`notion:https://www.notion.so/rob/Decade-plan-${PLAN}`)).toBe(`notion:${PLAN}`);
        expect(registry.parseRef(`notion:${PLAN}`)).toMatchObject({ resource: PLAN });
        for (const ref of ['notion:*', 'notion:', 'notion:Decade plan', `notion:${PLAN.toUpperCase()}`, `notion:${PLAN.slice(1)}`]) {
            expect(registry.parseRef(ref)).toBeNull();
        }

        // A grant made with a link keeps the id, and one with no id in it is refused.
        const { responsibility } = await responsibilities.create({
            userId: A, body: { title: 'Plan', operations: [{ operation: 'read', resource: { kind: 'external', ids: [`https://www.notion.so/rob/Decade-plan-${PLAN}`].map(link => `notion:${link}`) } }] }
        });
        expect(responsibility.operations[0].resource.ids).toEqual([`notion:${PLAN}`]);
        await expect(responsibilities.create({
            userId: A, body: { title: 'Plan', operations: [{ operation: 'read', resource: { kind: 'external', ids: ['notion:everything'] } }] }
        })).rejects.toMatchObject({ status: 400 });
    });
});

describe('reading', () => {
    test('a page\'s text, the blocks under it with their ids, and a database\'s rows', async () => {
        const page = await read('page');
        expect(page).toContain('Page "Decade plan"');
        expect(page).toContain('Run a marathon');
        expect(page).toContain('Nested note');
        expect(await read('page', { page: YEAR })).toContain('Start small');

        const blocks = await read('blocks');
        const todo = await blockId(PLAN, 'Book the trip');
        expect(blocks).toContain(`${todo} to_do [ ]: Book the trip`);
        expect(blocks).toMatch(/toggle \(has blocks under it\): Details/);
        expect(blocks).toContain(`${notionService.normalizePageId(YEAR)} page (has blocks under it): Year one`);
        expect(blocks).toContain('database: Tasks');
        const toggle = await blockId(PLAN, 'Details');
        expect(await read('blocks', { parent: toggle })).toContain('Nested note');

        const rows = await read('rows', { database: TASKS });
        expect(rows).toContain('Database "Tasks"');
        expect(rows).toContain('Status (select)');
        expect(rows).toMatch(/"Buy shoes" \| Status: Todo/);
        expect(await read('rows', { database: TASKS, title: 'route' })).not.toContain('Buy shoes');
        // A granted database is read without naming it.
        expect(await read('rows', {}, BOOKS)).toMatch(/"Dune" \| Rating: 5/);

        expect(fake.writes()).toEqual([]);
        expect([...fake.state.tokensSeen]).toEqual([TOKEN]);
    });

    test('says which kind of thing is needed instead of guessing', async () => {
        expect(await caught(read('rows'))).toMatchObject({ declined: true, code: 'NEEDS_DATABASE' });
        expect(await caught(read('page', {}, BOOKS))).toMatchObject({ declined: true, code: 'NEEDS_PAGE' });
        expect(registry.inputProblem(op('read', 'page'), { page: 'not an id' })).toBe('BAD_ID');
        expect(registry.inputProblem(op('read', 'rows'), { limit: 500 })).toBe('BAD_LIMIT');
    });
});

describe('nothing outside the granted resource is reachable', () => {
    test('a page, block, database or row elsewhere in the workspace is refused before anything is sent', async () => {
        const diaryBlock = await blockId(DIARY, 'DIARY-SECRET');
        const dune = fake.rows(BOOKS)[0].id;
        fake.state.calls.length = 0;
        const outside = { declined: true, code: 'OUTSIDE_RESOURCE' };
        const attempts = [
            read('page', { page: DIARY }),
            read('blocks', { parent: DIARY }),
            read('blocks', { parent: diaryBlock }),
            read('rows', { database: BOOKS }),
            read('page', { page: dune }),
            read('page', { page: HIDDEN }),
            read('page', { page: MISSING }),
            write('append', { text: 'hello', parent: DIARY }),
            write('append', { text: 'hello', parent: diaryBlock }),
            write('createPage', { title: 'x', database: BOOKS }),
            write('updateBlock', { block: diaryBlock, text: 'changed' }),
            write('updatePage', { page: DIARY, properties: { title: 'Mine now' } }),
            write('updatePage', { page: dune, properties: { Rating: 1 } }),
            op('ask', 'archive').prepare({ resource: PLAN, input: { target: DIARY }, token: TOKEN }),
            op('ask', 'archive').run({ resource: PLAN, target: diaryBlock, token: TOKEN })
        ];
        for (const attempt of attempts) expect(await caught(attempt)).toMatchObject(outside);
        expect(fake.writes()).toEqual([]);
        expect(fake.texts(DIARY)).toEqual(['DIARY-SECRET the gate code is 1234']);
        // The refusal carries none of what is there.
        for (const attempt of [read('page', { page: DIARY }), read('blocks', { parent: diaryBlock })]) {
            expect((await caught(attempt)).message).not.toMatch(/DIARY|diary|1234/);
        }
    });

    test('a page inside a granted page is inside; the granted page\'s own parent is not', async () => {
        // The grant is Year one, a page inside Decade plan.
        expect(await read('page', {}, YEAR)).toContain('Start small');
        expect(await caught(read('page', { page: PLAN }, YEAR))).toMatchObject({ code: 'OUTSIDE_RESOURCE' });
        expect(await caught(read('rows', { database: TASKS }, YEAR))).toMatchObject({ code: 'OUTSIDE_RESOURCE' });
        const sibling = await blockId(PLAN, 'Run a marathon');
        expect(await caught(write('updateBlock', { block: sibling, text: 'x' }, { resource: YEAR }))).toMatchObject({ code: 'OUTSIDE_RESOURCE' });
        expect(fake.writes()).toEqual([]);
    });

    test('rows of a database inside the granted page, and blocks nested under them, are inside', async () => {
        const shoes = fake.rows(TASKS).find(row => JSON.stringify(row).includes('Buy shoes')).id;
        expect(await read('page', { page: shoes })).toContain('Size 44');
        const toggle = await blockId(PLAN, 'Details');
        const deeper = await blockId(toggle, 'Deeper');
        const deepest = await blockId(deeper, 'Deepest');
        await write('updateBlock', { block: deepest, text: 'Deepest, edited' });
        expect(fake.texts(deeper)).toEqual(['Deepest, edited']);
    });

    test('a chain of parents longer than the limit is treated as outside', async () => {
        let parent = PLAN;
        for (let depth = 0; depth < internals.MAX_HOPS + 2; depth += 1) {
            parent = fake.addBlocks(parent, [{ type: 'toggle', text: `level ${depth}` }])[0].id;
        }
        expect(await caught(write('updateBlock', { block: parent, text: 'x' }))).toMatchObject({ declined: true, code: 'OUTSIDE_RESOURCE' });
        expect(fake.writes()).toEqual([]);
    });

    test('a granted resource that is in the trash, or not shared with the integration, is not used', async () => {
        fake.get(PLAN).archived = true;
        expect(await caught(read('page'))).toMatchObject({ declined: true, code: 'RESOURCE_ARCHIVED' });
        expect(await caught(write('append', { text: 'x' }))).toMatchObject({ declined: true, code: 'RESOURCE_ARCHIVED' });
        expect(await caught(read('page', {}, HIDDEN))).toMatchObject({ declined: true, code: 'NOT_FOUND' });
        expect(fake.writes()).toEqual([]);
    });
});

describe('append', () => {
    test('adds the lines as blocks, then one grey line saying which operation wrote them', async () => {
        const result = await write('append', { text: '# Week 12\n- ran 10 km\n- [ ] stretch\n> keep going\nA plain line' });
        expect(result).toBe('added 5 blocks to the page');
        const texts = fake.texts(PLAN);
        expect(texts.slice(-6, -1)).toEqual(['Week 12', 'ran 10 km', 'stretch', 'keep going', 'A plain line']);
        expect(texts[texts.length - 1]).toMatch(/^Goobster · ref [0-9a-f]{12}$/);
        expect(fake.writes()).toHaveLength(1);

        const toggle = await blockId(PLAN, 'Details');
        expect(await write('append', { text: 'Under the toggle', parent: toggle }, { operationId: '1:2' })).toContain(toggle);
        expect(fake.texts(toggle)).toEqual(expect.arrayContaining(['Under the toggle']));
        // Each operation has its own line; the same operation always has the same one.
        expect(internals.markerOf('1:1', PLAN, { text: 'a' })).toBe(internals.markerOf('1:1', PLAN, { text: 'a' }));
        expect(internals.markerOf('1:1', PLAN, { text: 'a' })).not.toBe(internals.markerOf('1:2', PLAN, { text: 'a' }));
        expect(internals.markerOf('1:1', PLAN, { text: 'a' })).not.toBe(internals.markerOf('1:1', PLAN, { text: 'b' }));
        expect(internals.markerOf('1:1', PLAN, { text: 'a' })).not.toBe(internals.markerOf('1:1', YEAR, { text: 'a' }));
    });

    test('a lost answer is told apart from a write that never happened', async () => {
        const input = { text: 'Ran 12 km' };
        expect(await reconcile('append', input)).toEqual({ state: 'absent' });

        fake.fail('lost');
        const error = await caught(write('append', input));
        expect(error).toMatchObject({ code: 'UNAVAILABLE' });
        expect(error.declined).not.toBe(true);
        expect(await reconcile('append', input)).toEqual({ state: 'done', result: expect.stringContaining('added text') });
        // Another operation's identical text is not mistaken for it.
        expect(await reconcile('append', input, { operationId: '9:9' })).toEqual({ state: 'absent' });
        expect(markers(PLAN)).toHaveLength(1);
    });

    test('Notion\'s own refusal is certain; being unreachable while writing is not', async () => {
        fake.fail('refuse', call => call.write, { code: 'FORBIDDEN' });
        expect(await caught(write('append', { text: 'x' }))).toMatchObject({ declined: true, code: 'FORBIDDEN' });
        fake.fail('refuse', call => call.write, { code: 'RATE_LIMITED' });
        expect(await caught(write('append', { text: 'x' }))).toMatchObject({ declined: true, code: 'RATE_LIMITED' });
        // Unreachable before the changing request was sent: nothing can have changed.
        fake.fail('unavailable', call => !call.write);
        expect(await caught(write('append', { text: 'x' }))).toMatchObject({ declined: true, code: 'UNAVAILABLE' });
        // Unreachable on the changing request: it may have landed.
        fake.fail('unavailable');
        expect((await caught(write('append', { text: 'x' }))).declined).not.toBe(true);
        expect(markers(PLAN)).toEqual([]);

        expect(await caught(write('append', { text: Array.from({ length: 61 }, (_, n) => `line ${n}`).join('\n') }))).toMatchObject({ code: 'TOO_MANY_BLOCKS' });
        expect(registry.inputProblem(op('write', 'append'), { text: '  ' })).toBe('EMPTY_TEXT');
        expect(registry.inputProblem(op('write', 'append'), { text: 'x', parent: 'nope' })).toBe('BAD_ID');
    });

    test('a marker past what is read back cannot be said either way', async () => {
        const input = { text: 'early' };
        await write('append', input);
        fake.addBlocks(PLAN, Array.from({ length: 2100 }, (_, n) => `filler ${n}`));
        // It is on the first page read, so it is still found.
        expect((await reconcile('append', input)).state).toBe('done');
        // One that would be past the last page read is unknown, never "absent".
        expect(await reconcile('append', { text: 'never written' })).toEqual({ state: 'unknown' });
    });
});

describe('createPage', () => {
    test('adds a row with typed properties and content to the granted database', async () => {
        const result = await write('createPage', {
            title: 'Enter the race',
            properties: { Status: 'Todo', Done: false, Due: '2027-04-01', Count: 3, Tags: ['running', 'spring'], Notes: 'Early bird price' },
            text: 'Sign up before March\n- [ ] pay the fee',
            database: TASKS
        });
        expect(result).toMatch(/^created the page "Enter the race" \(/);
        const row = fake.rows(TASKS).find(entry => JSON.stringify(entry).includes('Enter the race'));
        expect(row.properties).toMatchObject({
            Status: { select: { name: 'Todo' } }, Done: { checkbox: false }, Due: { date: { start: '2027-04-01' } },
            Count: { number: 3 }, Tags: { multi_select: [{ name: 'running' }, { name: 'spring' }] }
        });
        expect(fake.texts(row.id).slice(0, 2)).toEqual(['Sign up before March', 'pay the fee']);
        expect(markers(row.id)).toHaveLength(1);

        // A granted database needs no `database`; its title property is whatever it is called.
        await write('createPage', { title: 'Hyperion', properties: { Rating: '4.5' } }, { resource: BOOKS, operationId: '1:2' });
        expect(fake.rows(BOOKS).map(entry => entry.properties.Title.title[0].plain_text)).toEqual(['Dune', 'Hyperion']);
        expect(fake.rows(BOOKS)[1].properties.Rating.number).toBe(4.5);
    });

    test('what cannot be set is refused before anything is created', async () => {
        const refused = async (properties, code) => {
            expect(await caught(write('createPage', { title: 'x', properties, database: TASKS }))).toMatchObject({ declined: true, code });
        };
        await refused({ Nope: 'x' }, 'NO_SUCH_PROPERTY');
        await refused({ Owner: 'someone' }, 'UNSUPPORTED_PROPERTY');
        await refused({ Done: 'yes' }, 'BAD_PROPERTY_VALUE');
        await refused({ Due: 'next week' }, 'BAD_PROPERTY_VALUE');
        await refused({ Count: 'many' }, 'BAD_PROPERTY_VALUE');
        await refused({ Tags: 'one' }, 'BAD_PROPERTY_VALUE');
        expect(await caught(write('createPage', { title: 'x' }))).toMatchObject({ declined: true, code: 'NEEDS_DATABASE' });
        expect(registry.inputProblem(op('write', 'createPage'), { title: ' ' })).toBe('NO_TITLE');
        expect(fake.writes()).toEqual([]);
        expect(fake.rows(TASKS)).toHaveLength(2);
    });

    test('after a lost answer the row is found by its line, and a same-titled row is not mistaken for it', async () => {
        const input = { title: 'Buy shoes', text: 'A second pair', database: TASKS };
        // A row with that title already exists and was not made by this operation.
        expect(await reconcile('createPage', input)).toEqual({ state: 'absent' });
        fake.fail('lost');
        expect((await caught(write('createPage', input))).declined).not.toBe(true);
        expect(fake.rows(TASKS)).toHaveLength(3);
        expect(await reconcile('createPage', input)).toMatchObject({ state: 'done', result: expect.stringContaining('created the page "Buy shoes"') });
        expect(await reconcile('createPage', input, { operationId: '2:7' })).toEqual({ state: 'absent' });
    });
});

describe('editing what is there', () => {
    test('updateBlock replaces a block\'s text or ticks a to-do, and keeps its type', async () => {
        const marathon = await blockId(PLAN, 'Run a marathon');
        const todo = await blockId(PLAN, 'Book the trip');
        expect(await write('updateBlock', { block: marathon, text: 'Run two marathons' })).toBe('changed the paragraph "Run a marathon"');
        expect(await write('updateBlock', { block: todo, checked: true })).toContain('to do');
        expect(fake.get(marathon)).toMatchObject({ type: 'paragraph' });
        expect(fake.texts(PLAN)).toEqual(expect.arrayContaining(['Run two marathons', 'Book the trip']));
        expect(fake.get(todo).to_do.checked).toBe(true);
        // Nothing was added: an edit carries no marker line.
        expect(markers(PLAN)).toEqual([]);
    });

    test('what cannot be edited is refused with nothing sent', async () => {
        const marathon = await blockId(PLAN, 'Run a marathon');
        const divider = (await fake.request(TOKEN, `/v1/blocks/${PLAN}/children`, {})).results.find(block => block.type === 'divider').id;
        fake.state.calls.length = 0;
        expect(await caught(write('updateBlock', { block: marathon, checked: true }))).toMatchObject({ declined: true, code: 'NOT_A_TODO' });
        expect(await caught(write('updateBlock', { block: divider, text: 'x' }))).toMatchObject({ declined: true, code: 'UNSUPPORTED_BLOCK' });
        expect(await caught(write('updateBlock', { block: YEAR, text: 'x' }))).toMatchObject({ declined: true, code: 'UNSUPPORTED_BLOCK' });
        expect(await caught(write('updateBlock', { block: PLAN, text: 'x' }))).toMatchObject({ declined: true, code: 'NOT_A_BLOCK' });
        expect(registry.inputProblem(op('write', 'updateBlock'), { block: marathon })).toBe('NOTHING_TO_SET');
        expect(fake.writes()).toEqual([]);
    });

    test('updatePage sets a page\'s title and a row\'s properties', async () => {
        expect(await write('updatePage', { properties: { title: 'Decade plan, revised' } })).toBe('set "title" on the page "Decade plan"');
        expect(fake.get(PLAN).properties.title.title[0].plain_text).toBe('Decade plan, revised');

        const shoes = fake.rows(TASKS).find(row => JSON.stringify(row).includes('Buy shoes')).id;
        await write('updatePage', { page: shoes, properties: { Status: 'Done', Done: true, title: 'Bought shoes' } });
        expect(fake.get(shoes).properties).toMatchObject({
            Status: { select: { name: 'Done' } }, Done: { checkbox: true }, Name: { title: [{ plain_text: 'Bought shoes' }] }
        });
        expect(await caught(write('updatePage', { page: shoes, properties: { Owner: 'me' } }))).toMatchObject({ declined: true, code: 'UNSUPPORTED_PROPERTY' });
        expect(registry.inputProblem(op('write', 'updatePage'), { properties: {} })).toBe('NO_PROPERTIES');
    });

    test('an edit is reconciled by comparing: equal is done, different is made again, and twice is the same as once', async () => {
        const marathon = await blockId(PLAN, 'Run a marathon');
        const edit = { block: marathon, text: 'Run two marathons' };
        expect(await reconcile('updateBlock', edit)).toEqual({ state: 'absent' });
        fake.fail('lost');
        expect((await caught(write('updateBlock', edit))).declined).not.toBe(true);
        expect(await reconcile('updateBlock', edit)).toMatchObject({ state: 'done' });
        await write('updateBlock', edit);
        expect(fake.texts(PLAN).filter(text => text === 'Run two marathons')).toHaveLength(1);

        const shoes = fake.rows(TASKS).find(row => JSON.stringify(row).includes('Buy shoes')).id;
        const set = { page: shoes, properties: { Status: 'Done', Tags: ['a', 'b'], Count: 2, Due: '2027-01-02' } };
        expect(await reconcile('updatePage', set)).toEqual({ state: 'absent' });
        fake.fail('lost');
        expect((await caught(write('updatePage', set))).declined).not.toBe(true);
        expect(await reconcile('updatePage', set)).toMatchObject({ state: 'done' });
        // Something outside the resource cannot be reconciled into existence either.
        expect(await caught(reconcile('updatePage', { page: DIARY, properties: { title: 'x' } }))).toMatchObject({ code: 'OUTSIDE_RESOURCE' });
    });
});

// --- In a delegated run ----------------------------------------------------------

let callId = 0;
let goalSeq = 0;
const call = (name, args = {}) => ({ id: `c${++callId}`, name, arguments: JSON.stringify(args) });
function script(...rounds) {
    const queue = [...rounds];
    const chat = jest.spyOn(aiService, 'chat');
    chat.mockClear();
    return chat.mockImplementation(async () => {
        const next = queue.shift();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
}
const FINISH = [call('finish', { outcome: 'finding', title: 'Kept the plan', summary: 'See below.' })];
const tool = (name, operation, input = {}, resource = PLAN) => call(name, { connector: 'notion', resource, operation, input });
const grantOn = (operation, resource = PLAN) => ({ operation, resource: { kind: 'external', ids: [`notion:${resource}`] } });

async function queued({ userId = A, operations = [grantOn('read'), grantOn('external.write')], budgets = { externalOperations: 10 } } = {}) {
    await policies.enroll({ userId, initiative: 'delegate' });
    await policies.setBoundary({ userId, category: 'general', externalWrite: true });
    const item = await db.insert(
        `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
         VALUES (@guildId, @userId, 'goal', @subject, 'Keep the decade plan current', 'active')`,
        { guildId: `dm:${userId}`, userId, subject: `plan-${++goalSeq}` }
    );
    const { responsibility } = await responsibilities.create({
        userId, body: { title: 'Keep the decade plan current', operations, attentionItemId: item, ...(budgets ? { budgets } : {}) }
    });
    const active = (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
    await db.run('UPDATE attention_items SET goal = @goal WHERE id = @id', { id: item, goal: `Keep the decade plan current, take ${++goalSeq}` });
    const [id] = (await initiatives.reconcileResponsibility(active.id)).proposed;
    const row = await initiatives.get({ userId, id });
    return { grant: active, initiative: (await initiatives.act({ userId, id, action: 'queue', expectedRevision: row.revision })).initiative };
}

const operations = () => db.all('SELECT id, runId, tool, status, refusalCode, operation, resourceKind, resourceId, resultText FROM assistant_run_operations ORDER BY id', {});
const connectorOps = async () => (await operations()).filter(row => /Connector/.test(row.tool));
const needsYou = async (userId = A) => (await inbox.list({ userId, view: 'needs_you' })).items;

describe('in a delegated run', () => {
    test('a run reads the page, edits a block it found there, adds to it and creates a row', async () => {
        await queued();
        const marathon = await blockId(PLAN, 'Run a marathon');
        const chat = script(
            [call('listConnectors')],
            [tool('readConnector', 'blocks')],
            [tool('writeConnector', 'updateBlock', { block: marathon, text: 'Run two marathons' })],
            [tool('writeConnector', 'append', { text: 'Reviewed this week.' })],
            [tool('writeConnector', 'createPage', { title: 'Book a physio', database: TASKS, properties: { Status: 'Todo' } })],
            FINISH
        );
        await runner.tick({ wait: true });

        const ops = await connectorOps();
        expect(ops.map(row => `${row.tool} ${row.refusalCode || row.status}`)).toEqual([
            'listConnectors SUCCEEDED', 'readConnector SUCCEEDED', 'writeConnector SUCCEEDED', 'writeConnector SUCCEEDED', 'writeConnector SUCCEEDED'
        ]);
        expect(ops[0].resultText).toContain(`notion / ${PLAN}: Notion, read: page`);
        expect(ops[0].resultText).toContain('only by asking the person (askConnector): archive');
        expect(ops.slice(1).every(row => row.resourceKind === 'external' && row.resourceId === `notion:${PLAN}`)).toBe(true);
        expect(ops[2].resultText).toMatch(/^Wrote to Notion \([0-9a-f]{32}\): changed the paragraph "Run a marathon"\. That cannot be undone from here\.$/);

        expect(fake.texts(PLAN)).toEqual(expect.arrayContaining(['Run two marathons', 'Reviewed this week.']));
        expect(markers(PLAN)).toHaveLength(1);
        expect(fake.rows(TASKS).map(row => row.properties.Name.title[0].plain_text)).toContain('Book a physio');
        expect([...fake.state.tokensSeen]).toEqual([TOKEN]);

        const run = await db.get('SELECT * FROM assistant_runs', {});
        expect(run.status).toBe('COMPLETED');
        expect(run.resultSummary).toMatch(/Changed:.*Wrote to Notion/s);
        // The model is offered the four connector tools, and its token is in none of what it was sent.
        expect(chat.mock.calls[0][1].functions.map(entry => entry.name)).toEqual(expect.arrayContaining(['listConnectors', 'readConnector', 'writeConnector', 'askConnector']));
        expect(JSON.stringify(chat.mock.calls)).not.toContain(TOKEN);
        // Nor is it, or any of the page, in a ledger row.
        const ledgers = JSON.stringify([await db.all('SELECT * FROM work_failures', {}), await db.all('SELECT * FROM resource_events', {})]);
        expect(ledgers).not.toContain(TOKEN);
        expect(ledgers).not.toMatch(/marathon|Reviewed/);
    }, 60_000);

    test('the model may spell the resource as a link or with dashes; another resource is refused by the grant', async () => {
        await queued();
        script(
            [tool('readConnector', 'page', {}, `https://www.notion.so/rob/Decade-plan-${PLAN}`)],
            [tool('writeConnector', 'append', { text: 'spelled with dashes' }, notionService.normalizePageId(PLAN))],
            [tool('readConnector', 'page', {}, DIARY)],
            [tool('writeConnector', 'append', { text: 'into the diary' }, DIARY)],
            [tool('writeConnector', 'append', { text: 'into the diary', parent: DIARY })],
            FINISH
        );
        await runner.tick({ wait: true });
        const ops = await connectorOps();
        expect(ops.map(row => row.refusalCode || row.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'OPERATION_OUT_OF_SCOPE', 'OPERATION_OUT_OF_SCOPE', 'SUCCEEDED']);
        // Naming an outside page as the parent is answered, as nothing changed, by the connector itself.
        expect(ops[4].resultText).toMatch(/^Not written \(OUTSIDE_RESOURCE\)/);
        expect(fake.texts(DIARY)).toEqual(['DIARY-SECRET the gate code is 1234']);
        expect(JSON.stringify(ops)).not.toContain('DIARY-SECRET');
    }, 60_000);

    test('a read-only grant reads and cannot write or ask; someone outside the pilot gets nothing', async () => {
        await queued({ operations: [grantOn('read')] });
        let chat = script(
            [tool('readConnector', 'page')],
            [tool('writeConnector', 'append', { text: 'x' })],
            [tool('askConnector', 'archive', { target: YEAR })],
            FINISH
        );
        await runner.tick({ wait: true });
        expect(chat.mock.calls[0][1].functions.map(entry => entry.name).filter(name => /Connector/.test(name)).sort()).toEqual(['listConnectors', 'readConnector']);
        const ops = await connectorOps();
        expect(ops[0].status).toBe('SUCCEEDED');
        expect(ops.slice(1).every(row => row.status === 'REFUSED')).toBe(true);
        expect(fake.writes()).toEqual([]);
        expect(await db.all('SELECT id FROM assistant_connector_requests', {})).toEqual([]);

        // The pilot is the installation's owner unless the host names others.
        expect(await connectorService.list(B)).toEqual({ allowed: false, connectors: [] });
        expect(await connectorService.list(A)).toMatchObject({ allowed: true, connectors: [{ id: 'notion', connected: true }] });
        await db.run("UPDATE app_accounts SET status = 'disabled' WHERE principalId = @id", { id: A });
        const guard = runs.TOOLS.writeConnector.guard;
        const held = await db.get('SELECT id FROM assistant_responsibilities', {});
        expect(await guard(
            { connector: 'notion', resource: PLAN, operation: 'append', input: { text: 'x' } },
            { run: { id: 1, ownerUserId: A, responsibilityId: held.id }, opId: 1, actor: A }
        )).toBe(access.REFUSAL_CODE);
    }, 60_000);

    /** A run whose worker died with one append sent or about to be sent. */
    async function died() {
        const { initiative } = await queued();
        const claimed = await initiatives.claim({ id: initiative.id });
        const runId = await db.insert(
            `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId)
             VALUES (@i, @r, @rev, @u, @u, @u)`,
            { i: initiative.id, r: initiative.responsibilityId, rev: claimed.initiative.responsibilityRevision, u: A }
        );
        const args = { connector: 'notion', resource: PLAN, operation: 'append', input: { text: 'Weekly review done.' } };
        const opId = await db.insert(
            `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, seq, effect, status)
             VALUES (@runId, @u, 'writeConnector', @hash, 1, 'write', 'DISPATCHED')`,
            { runId, u: A, hash: runs.argsHash(args) }
        );
        const resume = () => {
            script([call('writeConnector', args)], FINISH);
            return runs.execute({ initiative: claimed.initiative, leaseToken: claimed.leaseToken });
        };
        return { args, opId, operationId: `${runId}:${opId}`, resume };
    }
    const reviews = () => fake.texts(PLAN).filter(text => text === 'Weekly review done.');

    test('a write whose answer was lost is not made twice when the run resumes', async () => {
        const dead = await died();
        // The worker sent it, Notion took it, and the worker died before the answer was journaled.
        await write('append', dead.args.input, { operationId: dead.operationId });
        fake.state.calls.length = 0;
        await dead.resume();
        expect(fake.writes()).toEqual([]);
        expect(reviews()).toHaveLength(1);
        expect((await operations()).find(row => row.id === dead.opId)).toMatchObject({ status: 'SUCCEEDED', resultText: expect.stringContaining('Wrote to Notion') });
    }, 60_000);

    test('a write that never reached Notion is made once when the run resumes', async () => {
        const dead = await died();
        await dead.resume();
        expect(fake.writes()).toHaveLength(1);
        expect(reviews()).toHaveLength(1);
        expect(markers(PLAN)).toEqual([internals.markerOf(dead.operationId, PLAN, dead.args.input)]);
        expect((await operations()).find(row => row.id === dead.opId)).toMatchObject({ status: 'SUCCEEDED' });
    }, 60_000);

    test('when Notion cannot be asked whether it landed, the work stops for review and nothing is sent', async () => {
        const dead = await died();
        fake.fail('unavailable', () => true, { times: 50 });
        expect(await dead.resume()).toMatchObject({ stopCode: 'OPERATION_UNCERTAIN' });
        expect(fake.writes()).toEqual([]);
        expect(reviews()).toEqual([]);
    }, 60_000);

    test('moving something to the trash is only ever asked for, and happens when the person approves it', async () => {
        await queued();
        script(
            [tool('readConnector', 'blocks')],
            // There is no such write, whatever it is called.
            [tool('writeConnector', 'archive', { target: YEAR })],
            [tool('writeConnector', 'updatePage', { page: YEAR, properties: { archived: true } })],
            [tool('askConnector', 'archive', { target: YEAR })],
            [tool('askConnector', 'archive', { target: PLAN })],
            [tool('askConnector', 'archive', { target: DIARY })],
            [tool('askConnector', 'archive', { target: TASKS })],
            FINISH
        );
        await runner.tick({ wait: true });
        const ops = (await connectorOps()).slice(1);
        expect(ops[0].status === 'REFUSED' || /^Not written/.test(ops[0].resultText)).toBe(true);
        expect(ops[1].resultText).toMatch(/^Not written \(NO_SUCH_PROPERTY\)/);
        expect(ops[2].resultText).toMatch(/^Not done: the person has been asked to approve it \(move it to the trash: the page "Year one", in Notion\)/);
        expect(ops[3].resultText).toMatch(/^Not asked \(ROOT_NOT_ARCHIVABLE\)/);
        expect(ops[4].resultText).toMatch(/^Not asked \(OUTSIDE_RESOURCE\)/);
        expect(ops[5].resultText).toMatch(/^Not asked \(UNSUPPORTED_BLOCK\)/);
        // Nothing was changed in Notion by the run.
        expect(fake.writes()).toEqual([]);
        expect(fake.get(YEAR).archived).toBe(false);
        expect((await db.get('SELECT resultSummary FROM assistant_runs', {})).resultSummary || '').not.toContain('Changed:');

        const [request] = await db.all('SELECT * FROM assistant_connector_requests', {});
        expect(request).toMatchObject({ connector: 'notion', resource: PLAN, operation: 'archive', target: notionService.normalizePageId(YEAR), status: 'PENDING' });
        const [item] = await needsYou();
        expect(item.decision).toMatchObject({
            kind: 'connector_request', state: 'open', title: 'Move it to the trash: the page "Year one", in Notion?',
            options: [{ id: 'approve', label: 'Move it to the trash', danger: true }, { id: 'decline', label: 'Leave it' }]
        });
        expect(item.decision.options[0].effect).toContain('restore it from Notion\'s trash');

        fake.state.tokensSeen.clear();
        const outcome = await gates.decide({
            userId: A, ref: item.decision.ref, option: 'approve', occurrence: item.decision.occurrence, revision: item.decision.revision, surface: 'home'
        });
        expect(outcome.decided.message).toBe('Moved the page "Year one" to the trash.');
        expect(fake.get(YEAR).archived).toBe(true);
        expect(fake.writes()).toHaveLength(1);
        expect([...fake.state.tokensSeen]).toEqual([TOKEN]);
        expect(await requests.get(request.id)).toMatchObject({ status: 'APPROVED' });
        expect(await needsYou()).toEqual([]);
    }, 60_000);

    test('a block can be asked about too; refusing leaves it, and one moved out of the resource since is not touched', async () => {
        await queued();
        const marathon = await blockId(PLAN, 'Run a marathon');
        const todo = await blockId(PLAN, 'Book the trip');
        script([tool('askConnector', 'archive', { target: marathon })], [tool('askConnector', 'archive', { target: todo })], FINISH);
        await runner.tick({ wait: true });
        const items = await needsYou();
        expect(items).toHaveLength(2);
        const cardFor = (text) => items.find(entry => entry.decision.title.includes(text)).decision;
        const press = (card, option) => gates.decide({ userId: A, ref: card.ref, option, occurrence: card.occurrence, revision: card.revision, surface: 'inbox' });

        expect((await press(cardFor('Run a marathon'), 'decline')).decided.message).toBe('Nothing was changed.');
        expect(fake.get(marathon).archived).toBe(false);

        // Since it was asked, the to-do was moved under a page the grant does not cover.
        fake.get(todo).parent = { type: 'page_id', page_id: notionService.normalizePageId(DIARY) };
        expect(await caught(press(cardFor('Book the trip'), 'approve'))).toMatchObject({ code: 'STALE_GATE' });
        expect(fake.get(todo).archived).toBe(false);
        expect(fake.writes()).toEqual([]);
        expect((await db.all('SELECT status, resultCode FROM assistant_connector_requests ORDER BY id', {}))).toEqual([
            { status: 'DECLINED', resultCode: null }, { status: 'WITHDRAWN', resultCode: 'OUTSIDE_RESOURCE' }
        ]);
    }, 60_000);

    test('what a run read in the person\'s notes, or in another Notion resource, is not written into Notion', async () => {
        const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
        const realExecute = toolsRegistry.execute.bind(toolsRegistry);
        jest.spyOn(toolsRegistry, 'execute').mockImplementation(async (name, args) => (
            name === 'lookupNotes' ? 'JOURNAL-SECRET a private note' : realExecute(name, args)
        ));
        await queued({
            operations: [
                grantOn('read'), grantOn('external.write'), grantOn('read', BOOKS), grantOn('external.write', BOOKS),
                { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } }
            ]
        });
        script(
            [tool('readConnector', 'rows', {}, BOOKS)],
            [tool('writeConnector', 'append', { text: 'Dune is rated 5' })],
            [tool('writeConnector', 'createPage', { title: 'Hyperion' }, BOOKS)],
            [call('lookupNotes', { query: 'anything' })],
            [tool('writeConnector', 'createPage', { title: 'From my notes' }, BOOKS)],
            FINISH
        );
        await runner.tick({ wait: true });
        expect((await operations()).filter(row => row.tool !== 'finish').map(row => `${row.tool} ${row.refusalCode || row.status}`)).toEqual([
            'readConnector SUCCEEDED', 'writeConnector PRIVATE_CONTEXT', 'writeConnector SUCCEEDED', 'lookupNotes SUCCEEDED', 'writeConnector PRIVATE_CONTEXT'
        ]);
        expect(fake.writes()).toHaveLength(1);
        expect(markers(PLAN)).toEqual([]);
    }, 60_000);

    test('writes count against the grant\'s daily budget of outside operations: two unless the grant says more', async () => {
        await queued({ budgets: null });
        script(
            [tool('writeConnector', 'append', { text: 'one' })],
            [tool('writeConnector', 'append', { text: 'two' })],
            [tool('writeConnector', 'append', { text: 'three' })],
            // Asking is not a write and takes none of it.
            [tool('askConnector', 'archive', { target: YEAR })],
            FINISH
        );
        await runner.tick({ wait: true });
        expect((await connectorOps()).map(row => row.refusalCode || row.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'EXTERNAL_BUDGET', 'SUCCEEDED']);
        expect(markers(PLAN)).toHaveLength(2);
        expect(fake.texts(PLAN)).not.toContain('three');
    }, 60_000);

    test('the person\'s own Notion allowlist is honoured: a granted page that is not on it is not used', async () => {
        const settings = require('@goobster/core/services/userSettingsService');
        const allow = (list) => settings.updateSection({ userId: A, section: 'connections', changes: { notionAllowlist: list } });
        const { grant: held } = await queued();
        const ctx = { run: { id: 1, ownerUserId: A, responsibilityId: held.id }, opId: 1, actor: A };
        const args = { connector: 'notion', resource: PLAN, operation: 'append', input: { text: 'x' } };
        const guard = runs.TOOLS.writeConnector.guard;
        // No list restricts nothing.
        expect(await guard(args, ctx)).toBeNull();

        await allow([`https://www.notion.so/rob/Private-diary-${DIARY}`]);
        expect(await guard(args, ctx)).toBe('NOT_ON_ALLOWLIST');
        script(
            [tool('readConnector', 'page')],
            [tool('writeConnector', 'append', { text: 'not allowed' })],
            [tool('askConnector', 'archive', { target: YEAR })],
            FINISH
        );
        await runner.tick({ wait: true });
        expect((await connectorOps()).map(row => row.refusalCode || row.status)).toEqual(['NOT_ON_ALLOWLIST', 'NOT_ON_ALLOWLIST', 'NOT_ON_ALLOWLIST']);
        expect(fake.state.calls).toEqual([]);

        // On the list, it is used; and a list that cannot be read refuses.
        await allow([DIARY, notionService.normalizePageId(PLAN)]);
        expect(await guard(args, ctx)).toBeNull();
        jest.spyOn(settings, 'getPreference').mockRejectedValue(new Error('settings unavailable'));
        await expect(guard(args, ctx)).rejects.toThrow('settings unavailable');
    }, 60_000);

    test('an approval is held to the allowlist too', async () => {
        const settings = require('@goobster/core/services/userSettingsService');
        await queued();
        script([tool('askConnector', 'archive', { target: YEAR })], FINISH);
        await runner.tick({ wait: true });
        const [item] = await needsYou();
        await settings.updateSection({ userId: A, section: 'connections', changes: { notionAllowlist: [DIARY] } });
        const press = () => gates.decide({
            userId: A, ref: item.decision.ref, option: 'approve', occurrence: item.decision.occurrence, revision: item.decision.revision, surface: 'home'
        });
        fake.state.calls.length = 0;
        expect(await caught(press())).toMatchObject({ code: 'NOT_ON_ALLOWLIST', status: 403 });
        expect(fake.state.calls).toEqual([]);
        expect(fake.get(YEAR).archived).toBe(false);
        // Still waiting: taking the restriction away lets the same request be approved.
        await settings.updateSection({ userId: A, section: 'connections', changes: { notionAllowlist: [] } });
        expect((await press()).decided.option).toBe('approve');
        expect(fake.get(YEAR).archived).toBe(true);
    }, 60_000);

    test('revoking Notion removes the token and the next call sends nothing', async () => {
        const { grant: held } = await queued();
        expect(await connectorService.revoke({ userId: A, connectorId: 'notion' })).toEqual({ revoked: true, responsibilities: [held.id] });
        expect(await db.get('SELECT 1 AS n FROM user_integrations WHERE userId = @a', { a: A })).toBeFalsy();
        script([tool('writeConnector', 'append', { text: 'too late' })], FINISH);
        await runner.tick({ wait: true });
        expect((await connectorOps())[0]).toMatchObject({ status: 'REFUSED', refusalCode: 'RESOURCE_UNAVAILABLE' });
        expect(fake.state.calls).toEqual([]);
    }, 60_000);
});
