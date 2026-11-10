/**
 * What notionService puts on the wire for the delegated connector's calls
 * (DA-11e, ADR 0030), and how Notion's answers become NotionError codes.
 * The connector reads those codes to tell "Notion refused, nothing changed"
 * from "no answer, it may have happened", so the mapping is load-bearing.
 *
 * `fetch` is replaced; nothing here talks to Notion.
 */

const notion = require('@goobster/core/services/notionService');

const TOKEN = 'secret_wire_token';
const ID = 'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaa1';
const DASHED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const realFetch = global.fetch;
let sent;

function answer(status = 200, body = { ok: true }) {
    sent = [];
    global.fetch = jest.fn(async (url, init) => {
        sent.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
        return { status, ok: status >= 200 && status < 300, json: async () => body };
    });
}

afterEach(() => { global.fetch = realFetch; });

describe('the calls the Notion connector makes', () => {
    test('each goes to the documented path, as the person, with the pinned API version', async () => {
        answer();
        await notion.getBlock(TOKEN, ID);
        await notion.getPage(TOKEN, ID);
        await notion.getDatabase(TOKEN, ID);
        await notion.listChildren(TOKEN, ID, { cursor: 'c1', limit: 500 });
        await notion.queryDatabase(TOKEN, ID, { filter: { property: 'Name', title: { equals: 'x' } }, limit: 5 });
        await notion.appendChildren(TOKEN, ID, [{ object: 'block', type: 'divider', divider: {} }]);
        await notion.createPage(TOKEN, { databaseId: ID, properties: { Name: { title: [] } } });
        await notion.updateBlock(TOKEN, ID, { paragraph: { rich_text: [] } });
        await notion.updatePage(TOKEN, ID, { Done: { checkbox: true } });
        await notion.archiveBlock(TOKEN, ID);
        await notion.archivePage(TOKEN, ID);

        expect(sent.map(call => `${call.method} ${call.url.replace('https://api.notion.com', '')}`)).toEqual([
            `GET /v1/blocks/${DASHED}`,
            `GET /v1/pages/${DASHED}`,
            `GET /v1/databases/${DASHED}`,
            `GET /v1/blocks/${DASHED}/children?page_size=100&start_cursor=c1`,
            `POST /v1/databases/${DASHED}/query`,
            `PATCH /v1/blocks/${DASHED}/children`,
            'POST /v1/pages',
            `PATCH /v1/blocks/${DASHED}`,
            `PATCH /v1/pages/${DASHED}`,
            `PATCH /v1/blocks/${DASHED}`,
            `PATCH /v1/pages/${DASHED}`
        ]);
        for (const call of sent) {
            expect(call.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28' });
            // The token is a header and nothing else.
            expect(call.url).not.toContain(TOKEN);
            expect(JSON.stringify(call.body)).not.toContain(TOKEN);
        }
        expect(sent[4].body).toEqual({ page_size: 5, filter: { property: 'Name', title: { equals: 'x' } } });
        expect(sent[5].body).toEqual({ children: [{ object: 'block', type: 'divider', divider: {} }] });
        expect(sent[6].body).toEqual({ parent: { database_id: DASHED }, properties: { Name: { title: [] } } });
        expect(sent[8].body).toEqual({ properties: { Done: { checkbox: true } } });
        // Archiving is the only call that sends `archived`, and nothing deletes.
        expect(sent.filter(call => call.body && 'archived' in call.body).map(call => call.body)).toEqual([{ archived: true }, { archived: true }]);
        expect(sent.some(call => call.method === 'DELETE')).toBe(false);
    });

    test('Notion\'s own refusals have their own codes; anything else says nothing either way', async () => {
        const codeFor = async (status) => {
            answer(status);
            return notion.updatePage(TOKEN, ID, {}).then(() => null, error => `${error.name}:${error.code}`);
        };
        expect(await codeFor(400)).toBe('NotionError:BAD_REQUEST');
        expect(await codeFor(401)).toBe('NotionError:BAD_TOKEN');
        expect(await codeFor(403)).toBe('NotionError:FORBIDDEN');
        expect(await codeFor(404)).toBe('NotionError:NOT_FOUND');
        expect(await codeFor(409)).toBe('NotionError:CONFLICT');
        expect(await codeFor(429)).toBe('NotionError:RATE_LIMITED');
        for (const status of [500, 502, 503, 504]) expect(await codeFor(status)).toBe('NotionError:UNAVAILABLE');

        global.fetch = jest.fn(async () => { throw new Error('socket hang up'); });
        const lost = await notion.appendChildren(TOKEN, ID, []).then(() => null, error => error);
        expect(lost).toMatchObject({ name: 'NotionError', code: 'UNAVAILABLE' });
        expect(lost.message).not.toContain(TOKEN);
    });
});
