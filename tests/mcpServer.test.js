/**
 * Read-only MCP server: JSON-RPC framing, bearer tokens, per-person
 * scoping, portal token routes, and the privacy/export seams.
 * Spec: documentation/mcp.md.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-mcp-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// Operator notes join the corpus only for an active operator; seed one so
// the boundary is exercised rather than assumed.
const OPERATOR_NOTES = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-mcp-operator-'));
fs.writeFileSync(
    path.join(OPERATOR_NOTES, 'private.md'),
    '# Private Host Notes\n\nprivatehostcanary lives in the kitchen closet.\n'
);
process.env.GOOBSTER_SELF_DOCS_OPERATOR_DIR = OPERATOR_NOTES;

const db = require('@goobster/core/db');
const mcpConfig = require('@goobster/core/config/mcpConfig');
const { features } = require('@goobster/core/features/featureState');
const mcpTokenService = require('@goobster/core/services/mcpTokenService');
const privacyService = require('@goobster/core/services/privacyService');
const inboxService = require('@goobster/core/services/inboxService');
const { snapshot } = require('@goobster/core/services/accountExportData');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const { createMcpApp, mountMcpIfEnabled } = require('@goobster/core/mcp/http');
const { serveStdio } = require('@goobster/core/mcp/stdio');
const { consume, _resetForTests: resetRate } = require('@goobster/core/mcp/rateLimit');
const { callTool, toolDescriptors } = require('@goobster/core/mcp/tools');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

jest.setTimeout(60_000);

const USER = '100000000000000041';
const OTHER = '100000000000000042';
const FORGOTTEN = '100000000000000043';
const OPERATOR = '100000000000000044';

let server;
let port;

const DIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-mcp-dist-'));

function request({ method = 'GET', reqPath, headers = {}, body = null, rawBody = null }) {
    const payload = rawBody != null ? rawBody : (body ? JSON.stringify(body) : null);
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: reqPath,
            method,
            headers: {
                ...(payload ? { 'content-type': 'application/json' } : {}),
                ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                if (text) {
                    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
                }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function login(userId, name) {
    const res = await request({
        method: 'POST',
        reqPath: '/api/app/auth/dev-session',
        body: { userId, name }
    });
    expect(res.status).toBe(200);
    return res.headers['set-cookie'].find(cookie => cookie.startsWith('goobster_web_session=')).split(';')[0];
}

function mcpHeaders(token, extra = {}) {
    return {
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extra
    };
}

async function rpc(token, message, extraHeaders) {
    return request({
        method: 'POST',
        reqPath: '/mcp',
        headers: mcpHeaders(token, extraHeaders),
        body: message
    });
}

async function stdioRoundtrip(session, messages) {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];
    output.on('data', chunk => chunks.push(chunk));
    const done = serveStdio({ session, input, output, log() {} });
    for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
    input.end();
    await done;
    return Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

beforeAll((done) => {
    fs.writeFileSync(path.join(DIST_DIR, 'index.html'), '<!doctype html><title>Goobster</title>');
    mcpConfig._setForTests({ enabled: true, requestsPerMinute: 1000, maxTokensPerUser: 10 });
    features.refresh();
    const ctx = createWebAppContext({
        client: { user: { id: '900000000000000099' }, guilds: { cache: new Map() } },
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error() {}, warn() {}, info() {}, debug() {} },
        deps: { webDistDir: DIST_DIR }
    });
    const app = express();
    app.use('/mcp', createMcpApp({ logger: { error() {}, warn() {}, info() {}, debug() {} } }));
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

afterAll(async () => {
    mcpConfig._setForTests(null);
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    fs.rmSync(OPERATOR_NOTES, { recursive: true, force: true });
});

beforeEach(async () => {
    mcpConfig._setForTests({ enabled: true, requestsPerMinute: 1000, maxTokensPerUser: 10 });
    resetRate();
    mcpTokenService._resetForTests();
    for (const table of [
        'expedition_briefs', 'mcp_tokens', 'inbox_items', 'kg_nodes',
        'memory_embeddings', 'facts', 'spitball_expeditions', 'observatory_projects'
    ]) {
        await db.run(`DELETE FROM ${table}`);
    }
});

describe('framing', () => {
    test('initialize, tools/list, and ping are read-only', async () => {
        const created = await mcpTokenService.create({ userId: USER, label: 'Cursor' });
        const init = await rpc(created.token, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
        });
        expect(init.status).toBe(200);
        expect(init.json.result.protocolVersion).toBe('2025-06-18');
        expect(init.json.result.serverInfo.name).toBe('goobster');
        expect(init.json.result.instructions).toMatch(/read-only/i);
        expect(init.json.result.capabilities.tools.listChanged).toBe(false);
        expect(init.json.result.capabilities.resources).toEqual({ subscribe: false, listChanged: false });
        expect(init.json.result.capabilities.prompts).toBeUndefined();

        const listed = await rpc(created.token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        expect(listed.status).toBe(200);
        const tools = listed.json.result.tools;
        expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
            'search_docs', 'search_memories', 'search_knowledge', 'list_projects', 'list_inbox', 'get_brief'
        ]));
        for (const tool of tools) {
            expect(tool.annotations.readOnlyHint).toBe(true);
            expect(tool.annotations.destructiveHint).toBe(false);
            expect(tool.name).not.toMatch(/create|delete|update|write|forget|send/i);
        }

        const pong = await rpc(created.token, { jsonrpc: '2.0', id: 3, method: 'ping' });
        expect(pong.json.result).toEqual({});
    });

    test('rejects a missing token, a batch, a bad method, and an unknown tool', async () => {
        const missing = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(missing.status).toBe(401);
        expect(missing.json.error.code).toBe(-32001);
        expect(missing.headers['www-authenticate']).toMatch(/Bearer/);

        const created = await mcpTokenService.create({ userId: USER, label: 'Cursor' });
        const batch = await request({
            method: 'POST',
            reqPath: '/mcp',
            headers: mcpHeaders(created.token),
            body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }]
        });
        expect(batch.status).toBe(400);
        expect(batch.json.error.message).toMatch(/batch/i);

        const unknown = await rpc(created.token, { jsonrpc: '2.0', id: 4, method: 'prompts/list' });
        expect(unknown.json.error.code).toBe(-32601);

        const write = await rpc(created.token, {
            jsonrpc: '2.0',
            id: 5,
            method: 'tools/call',
            params: { name: 'delete_memory', arguments: {} }
        });
        expect(write.json.error.code).toBe(-32602);

        const get = await request({ reqPath: '/mcp', headers: mcpHeaders(created.token) });
        expect(get.status).toBe(405);

        const badJson = await request({
            method: 'POST',
            reqPath: '/mcp',
            headers: mcpHeaders(created.token),
            rawBody: '{'
        });
        expect(badJson.status).toBe(400);
        expect(badJson.json.error.code).toBe(-32700);
    });

    test('a foreign Origin is refused and a revoked token stops working', async () => {
        const created = await mcpTokenService.create({ userId: USER, label: 'Cursor' });
        const cross = await rpc(created.token, { jsonrpc: '2.0', id: 1, method: 'ping' }, {
            origin: 'https://evil.example',
            host: `127.0.0.1:${port}`
        });
        expect(cross.status).toBe(403);

        await mcpTokenService.revoke({ userId: USER, id: created.id });
        const again = await rpc(created.token, { jsonrpc: '2.0', id: 2, method: 'ping' });
        expect(again.status).toBe(401);
    });

    test('rate limit is per token', async () => {
        mcpConfig._setForTests({ enabled: true, requestsPerMinute: 2, maxTokensPerUser: 10 });
        const created = await mcpTokenService.create({ userId: USER, label: 'Cursor' });
        const ok = await rpc(created.token, { jsonrpc: '2.0', id: 1, method: 'ping' });
        expect(ok.status).toBe(200);
        await rpc(created.token, { jsonrpc: '2.0', id: 2, method: 'ping' });
        const limited = await rpc(created.token, { jsonrpc: '2.0', id: 3, method: 'ping' });
        expect(limited.status).toBe(429);
    });

    test('stdio speaks the same protocol and ignores notifications', async () => {
        const created = await mcpTokenService.create({ userId: USER, label: 'stdio' });
        const session = await mcpTokenService.authenticate(created.token);
        const replies = await stdioRoundtrip(session, [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
            { jsonrpc: '2.0', method: 'notifications/initialized' },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' }
        ]);
        expect(replies).toHaveLength(2);
        expect(replies[0].result.protocolVersion).toBe('2024-11-05');
        expect(replies[1].result.tools.some(tool => tool.name === 'search_memories')).toBe(true);
    });

    test('the endpoint stays unmounted while the switch is off', () => {
        mcpConfig._setForTests({ enabled: false });
        features.refresh();
        try {
            const app = express();
            expect(mountMcpIfEnabled(app, { logger: { info() {} } })).toBe(false);
            expect(consume('mcp:unused', 1)).toBe(true);
            expect(toolDescriptors().length).toBeGreaterThan(5);
        } finally {
            mcpConfig._setForTests({ enabled: true, requestsPerMinute: 1000, maxTokensPerUser: 10 });
            features.refresh();
        }
    });
});

describe('scoping', () => {
    async function seedWorkspace() {
        const guild = '200000000000000041';
        await db.run(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@guildId, @authorId, 'rob', @content, x'00000000', 1, 'test/model')`,
            { guildId: dmScopeId(USER), authorId: USER, content: 'private mars notebook' }
        );
        await db.run(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@guildId, @authorId, 'rob', @content, x'00000000', 1, 'test/model')`,
            { guildId: guild, authorId: USER, content: 'guild mars notebook' }
        );
        await db.run(
            `INSERT INTO memory_embeddings (guildId, authorId, authorName, content, embedding, dims, model)
             VALUES (@guildId, @authorId, 'sam', @content, x'00000000', 1, 'test/model')`,
            { guildId: dmScopeId(OTHER), authorId: OTHER, content: 'other mars notebook' }
        );
        await db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@guildId, 'USER', @userId, @content)`,
            { guildId: dmScopeId(USER), userId: USER, content: 'likes dawn launches' }
        );
        await db.run(
            `INSERT INTO facts (guildId, subjectType, subjectId, content) VALUES (@guildId, 'USER', @userId, @content)`,
            { guildId: dmScopeId(OTHER), userId: OTHER, content: 'likes midnight launches' }
        );
        await db.run(
            `INSERT INTO kg_nodes (guildId, scopeKey, type, label, content, source)
             VALUES (@guildId, @scopeKey, 'fact', @label, @content, 'user')`,
            {
                guildId: dmScopeId(USER),
                scopeKey: `USER:${USER}`,
                label: 'Mars dust',
                content: 'Storms eased in September'
            }
        );
        await db.run(
            `INSERT INTO kg_nodes (guildId, scopeKey, type, label, content, source)
             VALUES (@guildId, @scopeKey, 'fact', @label, @content, 'user')`,
            {
                guildId: dmScopeId(OTHER),
                scopeKey: `USER:${OTHER}`,
                label: 'Secret orbit',
                content: 'belongs to someone else'
            }
        );
        await db.insert(
            `INSERT INTO observatory_projects (userId, slug, name, description)
             VALUES (@userId, 'mars-atlas', 'Mars atlas', 'Weather notes')`,
            { userId: USER }
        );
        await db.insert(
            `INSERT INTO observatory_projects (userId, slug, name, description)
             VALUES (@userId, 'secret-lab', 'Secret lab', 'not yours')`,
            { userId: OTHER }
        );
        await inboxService.deliver({
            userId: USER, kind: 'notice', title: 'Pilot note', body: 'The brief is ready.', discord: false
        });
        await inboxService.deliver({
            userId: OTHER, kind: 'notice', title: 'Other note', body: 'Stay out.', discord: false
        });
        const expeditionId = await db.insert(
            `INSERT INTO spitball_expeditions (userId, guildId, scopeKey, seed, intent, status, summary)
             VALUES (@userId, @guildId, @scopeKey, @seed, @intent, 'COMPLETED', @summary)`,
            {
                userId: USER,
                guildId: dmScopeId(USER),
                scopeKey: `USER:${USER}`,
                seed: 'mars weather',
                intent: 'track changes',
                summary: 'Dust storms eased.'
            }
        );
        const otherExpedition = await db.insert(
            `INSERT INTO spitball_expeditions (userId, guildId, scopeKey, seed, status)
             VALUES (@userId, @guildId, @scopeKey, 'secret seed', 'COMPLETED')`,
            { userId: OTHER, guildId: dmScopeId(OTHER), scopeKey: `USER:${OTHER}` }
        );
        const briefId = await db.insert(
            `INSERT INTO expedition_briefs (expeditionId, userId, status, errorCode)
             VALUES (@expeditionId, @userId, 'FAILED', 'BUDGET')`,
            { expeditionId, userId: USER }
        );
        return { expeditionId, otherExpedition, briefId };
    }

    function textOf(result) {
        return result.content.map(part => part.text).join('\n');
    }

    test('reads only the token owner\'s private workspace', async () => {
        const seeded = await seedWorkspace();
        const memories = textOf(await callTool(USER, 'search_memories', { query: 'mars' }));
        expect(memories).toContain('private mars notebook');
        expect(memories).not.toContain('guild mars notebook');
        expect(memories).not.toContain('other mars notebook');

        const facts = textOf(await callTool(USER, 'list_facts', {}));
        expect(facts).toContain('likes dawn launches');
        expect(facts).not.toContain('midnight');

        const notes = textOf(await callTool(USER, 'search_knowledge', { query: 'mars' }));
        expect(notes).toContain('Mars dust');
        expect(notes).not.toContain('Secret orbit');

        const projects = textOf(await callTool(USER, 'list_projects', {}));
        expect(projects).toContain('Mars atlas');
        expect(projects).not.toContain('Secret lab');

        const one = textOf(await callTool(USER, 'get_project', { project: 'mars-atlas' }));
        expect(one).toContain('Weather notes');
        const missing = await callTool(USER, 'get_project', { project: 'secret-lab' });
        expect(missing.isError).toBe(true);

        const files = textOf(await callTool(USER, 'list_project_files', { project: 'mars-atlas' }));
        expect(files).toMatch(/no files/i);

        const inbox = textOf(await callTool(USER, 'list_inbox', {}));
        expect(inbox).toContain('Pilot note');
        expect(inbox).not.toContain('Other note');

        const expeditions = textOf(await callTool(USER, 'list_expeditions', {}));
        expect(expeditions).toContain('mars weather');
        expect(expeditions).not.toContain('secret seed');
        const detail = textOf(await callTool(USER, 'get_expedition', { id: seeded.expeditionId }));
        expect(detail).toContain('Dust storms eased.');
        const foreign = await callTool(USER, 'get_expedition', { id: seeded.otherExpedition });
        expect(foreign.isError).toBe(true);
        expect(textOf(foreign)).not.toContain('secret seed');

        const briefs = textOf(await callTool(USER, 'list_briefs', {}));
        expect(briefs).toContain(`#${seeded.briefId}`);
        const brief = textOf(await callTool(USER, 'get_brief', { id: seeded.briefId }));
        expect(brief).toContain('FAILED');
        expect(brief).toContain('BUDGET');
    });

    test('documentation search answers from the shipped corpus', async () => {
        const listed = await callTool(USER, 'list_docs', { kind: 'guide' });
        expect(listed.isError).toBeUndefined();
        expect(textOf(listed)).toMatch(/MCP server|slug:/);
        const found = await callTool(USER, 'search_docs', { query: 'mcp token bearer' });
        expect(textOf(found).toLowerCase()).toContain('mcp');
    });
});

describe('token scopes', () => {
    const DOC_TOOL_NAMES = ['list_docs', 'search_docs', 'read_doc'];

    test('a docs token sees and may call only the documentation tools', async () => {
        const created = await mcpTokenService.create({ userId: USER, label: 'Docs', scope: 'docs' });
        expect(created.scope).toBe('docs');

        const listed = await rpc(created.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(listed.json.result.tools.map(tool => tool.name).sort()).toEqual([...DOC_TOOL_NAMES].sort());

        const allowed = await rpc(created.token, {
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: 'search_docs', arguments: { query: 'mcp token' } }
        });
        expect(allowed.json.result.isError).toBeUndefined();

        for (const name of ['search_memories', 'list_inbox', 'list_projects', 'get_brief']) {
            const refused = await rpc(created.token, {
                jsonrpc: '2.0', id: 3, method: 'tools/call',
                params: { name, arguments: { query: 'x', id: 1 } }
            });
            expect(refused.json.error.code).toBe(-32602);
            expect(refused.json.error.message).toMatch(/"docs" scope/);
        }

        const init = await rpc(created.token, { jsonrpc: '2.0', id: 4, method: 'initialize', params: {} });
        expect(init.json.result.instructions).toMatch(/documentation only/i);
    });

    test('a read token keeps every tool and an unrecognized scope gets none', async () => {
        const created = await mcpTokenService.create({ userId: USER, label: 'All' });
        expect(created.scope).toBe('read');
        const listed = await rpc(created.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(listed.json.result.tools.length).toBe(toolDescriptors().length);
        expect(toolDescriptors({ scope: 'bogus' })).toEqual([]);
        await expect(callTool(USER, 'list_docs', {}, { scope: 'bogus' })).rejects.toMatchObject({ rpcCode: -32602 });
    });

    test('an unknown scope is refused at creation', async () => {
        await expect(mcpTokenService.create({ userId: USER, label: 'Bad', scope: 'write' }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_SCOPE' });
        await expect(mcpTokenService.create({ userId: USER, label: 'Bad', scope: 'admin' }))
            .rejects.toMatchObject({ code: 'BAD_SCOPE' });
    });

    test('stdio applies the token scope', async () => {
        const created = await mcpTokenService.create({ userId: USER, label: 'stdio docs', scope: 'docs' });
        const session = await mcpTokenService.authenticate(created.token);
        expect(session.scope).toBe('docs');
        const replies = await stdioRoundtrip(session, [
            { jsonrpc: '2.0', id: 1, method: 'tools/list' },
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_inbox', arguments: {} } }
        ]);
        expect(replies[0].result.tools).toHaveLength(DOC_TOOL_NAMES.length);
        expect(replies[1].error.code).toBe(-32602);
    });
});

describe('token expiry', () => {
    function daysFromNow(text) {
        return (new Date(`${text.replace(' ', 'T')}Z`).getTime() - Date.now()) / 86_400_000;
    }

    test('a token expires after the chosen lifetime, and 0 means never', async () => {
        const dflt = await mcpTokenService.create({ userId: USER, label: 'Default' });
        expect(daysFromNow(dflt.expiresAt)).toBeGreaterThan(89.9);
        expect(daysFromNow(dflt.expiresAt)).toBeLessThan(90.1);

        const week = await mcpTokenService.create({ userId: USER, label: 'Week', expiresInDays: 7 });
        expect(daysFromNow(week.expiresAt)).toBeGreaterThan(6.9);
        expect(daysFromNow(week.expiresAt)).toBeLessThan(7.1);

        const never = await mcpTokenService.create({ userId: USER, label: 'Forever', expiresInDays: 0 });
        expect(never.expiresAt).toBeNull();
        expect(never.expired).toBe(false);

        mcpConfig._setForTests({ enabled: true, defaultTokenDays: 0 });
        const configured = await mcpTokenService.create({ userId: USER, label: 'Config never' });
        expect(configured.expiresAt).toBeNull();
    });

    test('a lifetime outside 0 to 365 days is refused', async () => {
        for (const bad of [-1, 366, 1.5, 'soon', NaN]) {
            await expect(mcpTokenService.create({ userId: USER, label: 'Bad', expiresInDays: bad }))
                .rejects.toMatchObject({ status: 400, code: 'BAD_EXPIRY' });
        }
    });

    test('a lapsed token stops working and says why', async () => {
        const created = await mcpTokenService.create({ userId: USER, label: 'Old' });
        expect(await mcpTokenService.authenticate(created.token)).not.toBeNull();

        await db.run(
            'UPDATE mcp_tokens SET expiresAt = @past WHERE id = @id',
            { past: '2020-01-01 00:00:00', id: created.id }
        );
        expect(await mcpTokenService.authenticate(created.token)).toBeNull();
        expect(await mcpTokenService.resolve(created.token)).toEqual({ status: 'expired' });
        expect(await mcpTokenService.resolve('gst_' + 'a'.repeat(43))).toEqual({ status: 'invalid' });

        const lapsed = await rpc(created.token, { jsonrpc: '2.0', id: 1, method: 'ping' });
        expect(lapsed.status).toBe(401);
        expect(lapsed.json.error.message).toMatch(/expired/i);
        expect(lapsed.headers['www-authenticate']).toMatch(/invalid_token/);

        const unknown = await rpc('gst_' + 'a'.repeat(43), { jsonrpc: '2.0', id: 2, method: 'ping' });
        expect(unknown.status).toBe(401);
        expect(unknown.json.error.message).toBe('Unauthorized');
        expect(unknown.headers['www-authenticate']).not.toMatch(/invalid_token/);
    });

    test('an expired token is listed as expired and does not count toward the cap', async () => {
        mcpConfig._setForTests({ enabled: true, maxTokensPerUser: 1 });
        const first = await mcpTokenService.create({ userId: USER, label: 'One' });
        await expect(mcpTokenService.create({ userId: USER, label: 'Two' }))
            .rejects.toMatchObject({ code: 'TOO_MANY_TOKENS' });

        await db.run(
            'UPDATE mcp_tokens SET expiresAt = @past WHERE id = @id',
            { past: '2020-01-01 00:00:00', id: first.id }
        );
        const listed = await mcpTokenService.list({ userId: USER });
        expect(listed).toHaveLength(1);
        expect(listed[0].expired).toBe(true);

        const second = await mcpTokenService.create({ userId: USER, label: 'Two' });
        expect(second.expired).toBe(false);
        await mcpTokenService.revoke({ userId: USER, id: first.id });
        expect((await mcpTokenService.list({ userId: USER })).map(row => row.id)).toEqual([second.id]);
    });
});

describe('resources', () => {
    async function seedBrief(userId, seed) {
        const expeditionId = await db.insert(
            `INSERT INTO spitball_expeditions (userId, guildId, scopeKey, seed, status)
             VALUES (@userId, @guildId, @scopeKey, @seed, 'COMPLETED')`,
            { userId, guildId: dmScopeId(userId), scopeKey: `USER:${userId}`, seed }
        );
        return db.insert(
            `INSERT INTO expedition_briefs (expeditionId, userId, status, errorCode)
             VALUES (@expeditionId, @userId, 'FAILED', 'BUDGET')`,
            { expeditionId, userId }
        );
    }

    async function call(token, method, params = {}) {
        const res = await rpc(token, { jsonrpc: '2.0', id: 1, method, params });
        expect(res.status).toBe(200);
        return res.json;
    }

    async function allResources(token) {
        const seen = [];
        let cursor;
        for (let page = 0; page < 200; page++) {
            const reply = await call(token, 'resources/list', cursor ? { cursor } : {});
            seen.push(...reply.result.resources);
            cursor = reply.result.nextCursor;
            if (!cursor) return seen;
        }
        throw new Error('resources/list never ended');
    }

    test('lists documentation and the owner\'s briefs, paged by cursor', async () => {
        const mine = await seedBrief(USER, 'mine');
        const theirs = await seedBrief(OTHER, 'theirs');
        const created = await mcpTokenService.create({ userId: USER, label: 'Cursor' });

        const everything = await allResources(created.token);
        const uris = everything.map(entry => entry.uri);
        expect(uris.some(uri => uri.startsWith('goobster://docs/'))).toBe(true);
        expect(uris).toContain(`goobster://briefs/${mine}`);
        expect(uris).not.toContain(`goobster://briefs/${theirs}`);
        expect(new Set(uris).size).toBe(uris.length);
        expect(uris.some(uri => uri.startsWith('goobster://docs/operator/'))).toBe(false);
        for (const entry of everything) {
            expect(entry.name).toBeTruthy();
            expect(entry.mimeType).toMatch(/^text\//);
        }

        mcpConfig._setForTests({ enabled: true, requestsPerMinute: 1000, resourcePageSize: 5 });
        const first = await call(created.token, 'resources/list');
        expect(first.result.resources).toHaveLength(5);
        expect(typeof first.result.nextCursor).toBe('string');
        expect((await allResources(created.token)).map(entry => entry.uri)).toEqual(uris);

        const bad = await call(created.token, 'resources/list', { cursor: '!!not-a-cursor!!' });
        expect(bad.error.code).toBe(-32602);
    });

    test('templates follow the scope', async () => {
        const all = await mcpTokenService.create({ userId: USER, label: 'All' });
        const docs = await mcpTokenService.create({ userId: USER, label: 'Docs', scope: 'docs' });
        const full = await call(all.token, 'resources/templates/list');
        expect(full.result.resourceTemplates.map(entry => entry.uriTemplate))
            .toEqual(['goobster://docs/{slug}', 'goobster://briefs/{id}']);
        const narrow = await call(docs.token, 'resources/templates/list');
        expect(narrow.result.resourceTemplates.map(entry => entry.uriTemplate))
            .toEqual(['goobster://docs/{slug}']);
    });

    test('reads a documentation page by exact URI and refuses near misses', async () => {
        const created = await mcpTokenService.create({ userId: USER, label: 'Cursor' });
        const listed = await allResources(created.token);
        const doc = listed.find(entry => entry.uri.startsWith('goobster://docs/'));
        const read = await call(created.token, 'resources/read', { uri: doc.uri });
        expect(read.result.contents).toHaveLength(1);
        expect(read.result.contents[0].uri).toBe(doc.uri);
        expect(read.result.contents[0].mimeType).toBe('text/markdown');
        expect(read.result.contents[0].text.length).toBeGreaterThan(50);

        const mcpDoc = listed.find(entry => entry.name.endsWith('mcp'));
        expect(mcpDoc).toBeTruthy();
        const mcpRead = await call(created.token, 'resources/read', { uri: mcpDoc.uri });
        expect(mcpRead.result.contents[0].text).toMatch(/read-only/i);

        const missing = await call(created.token, 'resources/read', { uri: 'goobster://docs/no-such-page-anywhere' });
        expect(missing.error.code).toBe(-32002);
        const badScheme = await call(created.token, 'resources/read', { uri: 'file:///etc/passwd' });
        expect(badScheme.error.code).toBe(-32002);
        const noUri = await call(created.token, 'resources/read', {});
        expect(noUri.error.code).toBe(-32602);
        const empty = await call(created.token, 'resources/read', { uri: 'goobster://docs/' });
        expect(empty.error.code).toBe(-32002);
    });

    test('operator notes are listed and readable only for an active operator', async () => {
        const operatorUri = 'goobster://docs/operator/private';
        const ordinary = await mcpTokenService.create({ userId: USER, label: 'Cursor' });
        const ordinaryDocs = await mcpTokenService.create({ userId: USER, label: 'Docs', scope: 'docs' });
        for (const token of [ordinary.token, ordinaryDocs.token]) {
            const uris = (await allResources(token)).map(entry => entry.uri);
            expect(uris.some(uri => uri.startsWith('goobster://docs/'))).toBe(true);
            expect(uris).not.toContain(operatorUri);
            const denied = await call(token, 'resources/read', { uri: operatorUri });
            expect(denied.error.code).toBe(-32002);
            expect(JSON.stringify(denied)).not.toContain('privatehostcanary');
        }

        const identity = require('@goobster/core/services/identityService');
        await identity.ensureLegacyPrincipal({ discordId: OPERATOR, displayName: 'ops' });
        await identity.grantAccount({ principalId: OPERATOR, entitlement: 'bootstrap', role: 'operator' });
        const operator = await mcpTokenService.create({ userId: OPERATOR, label: 'Ops', scope: 'docs' });
        const uris = (await allResources(operator.token)).map(entry => entry.uri);
        expect(uris).toContain(operatorUri);
        const read = await call(operator.token, 'resources/read', { uri: operatorUri });
        expect(read.result.contents[0].text).toContain('privatehostcanary');
    });

    test('a brief is readable by its owner only, and never by a docs token', async () => {
        const mine = await seedBrief(USER, 'mine');
        const theirs = await seedBrief(OTHER, 'theirs');
        const all = await mcpTokenService.create({ userId: USER, label: 'All' });
        const docs = await mcpTokenService.create({ userId: USER, label: 'Docs', scope: 'docs' });

        const own = await call(all.token, 'resources/read', { uri: `goobster://briefs/${mine}` });
        expect(own.result.contents[0].text).toContain('BUDGET');
        expect(own.result.contents[0].mimeType).toBe('text/plain');

        const foreign = await call(all.token, 'resources/read', { uri: `goobster://briefs/${theirs}` });
        expect(foreign.error.code).toBe(-32002);
        const narrow = await call(docs.token, 'resources/read', { uri: `goobster://briefs/${mine}` });
        expect(narrow.error.code).toBe(-32002);
        expect(narrow.error.message).toBe('Resource not found.');
        const junk = await call(all.token, 'resources/read', { uri: 'goobster://briefs/1; DROP TABLE x' });
        expect(junk.error.code).toBe(-32002);

        const docsList = await allResources(docs.token);
        expect(docsList.some(entry => entry.uri.startsWith('goobster://briefs/'))).toBe(false);
    });

    test('stdio serves resources with the same rules', async () => {
        const mine = await seedBrief(USER, 'mine');
        const created = await mcpTokenService.create({ userId: USER, label: 'stdio' });
        const session = await mcpTokenService.authenticate(created.token);
        const replies = await stdioRoundtrip(session, [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
            { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: `goobster://briefs/${mine}` } }
        ]);
        expect(replies[0].result.capabilities.resources).toBeTruthy();
        expect(replies[1].result.contents[0].text).toContain('BUDGET');
    });
});

describe('portal tokens, privacy, and export', () => {
    test('the settings API takes a scope and a lifetime and lists the choices', async () => {
        const cookie = await login(USER, 'rob');
        const created = await request({
            method: 'POST',
            reqPath: '/api/app/mcp/tokens',
            headers: { cookie },
            body: { label: 'Docs only', scope: 'docs', expiresInDays: 30 }
        });
        expect(created.status).toBe(200);
        expect(created.json.scope).toBe('docs');
        expect(created.json.expiresAt).toBeTruthy();

        const forever = await request({
            method: 'POST',
            reqPath: '/api/app/mcp/tokens',
            headers: { cookie },
            body: { label: 'Forever', expiresInDays: 0 }
        });
        expect(forever.json.expiresAt).toBeNull();

        const listed = await request({ reqPath: '/api/app/mcp', headers: { cookie } });
        expect(listed.json.scopes.map(scope => scope.id)).toEqual(['read', 'docs']);
        expect(listed.json.defaultExpiryDays).toBe(90);
        expect(listed.json.maxExpiryDays).toBe(365);
        expect(listed.json.resources).toBe(true);
        expect(listed.json.tokens.map(token => token.expired)).toEqual([false, false]);

        const badScope = await request({
            method: 'POST',
            reqPath: '/api/app/mcp/tokens',
            headers: { cookie },
            body: { label: 'Nope', scope: 'write' }
        });
        expect(badScope.status).toBe(400);
        expect(badScope.json.error.code).toBe('BAD_SCOPE');
        const badExpiry = await request({
            method: 'POST',
            reqPath: '/api/app/mcp/tokens',
            headers: { cookie },
            body: { label: 'Nope', expiresInDays: 9999 }
        });
        expect(badExpiry.status).toBe(400);
        expect(badExpiry.json.error.code).toBe('BAD_EXPIRY');
    });

    test('the settings API shows a token once and only to its owner', async () => {
        const cookie = await login(USER, 'rob');
        const created = await request({
            method: 'POST',
            reqPath: '/api/app/mcp/tokens',
            headers: { cookie },
            body: { label: 'Laptop' }
        });
        expect(created.status).toBe(200);
        expect(created.json.token).toMatch(/^gst_/);
        expect(created.json.scope).toBe('read');

        const listed = await request({ reqPath: '/api/app/mcp', headers: { cookie } });
        expect(listed.json.enabled).toBe(true);
        expect(listed.json.readOnly).toBe(true);
        expect(listed.json.tokens).toHaveLength(1);
        expect(listed.json.tokens[0].token).toBeUndefined();
        expect(listed.json.tokens[0].tokenPrefix).toBe(created.json.token.slice(0, 12));
        expect(JSON.stringify(listed.json)).not.toContain(created.json.token);

        const other = await login(OTHER, 'sam');
        const stolen = await request({
            method: 'DELETE',
            reqPath: `/api/app/mcp/tokens/${created.json.id}`,
            headers: { cookie: other }
        });
        expect(stolen.status).toBe(404);
        const ping = await rpc(created.json.token, { jsonrpc: '2.0', id: 1, method: 'ping' });
        expect(ping.status).toBe(200);

        const revoked = await request({
            method: 'DELETE',
            reqPath: `/api/app/mcp/tokens/${created.json.id}`,
            headers: { cookie }
        });
        expect(revoked.status).toBe(200);
        const dead = await rpc(created.json.token, { jsonrpc: '2.0', id: 2, method: 'ping' });
        expect(dead.status).toBe(401);
    });

    test('a blank label is refused and the cap is enforced', async () => {
        const cookie = await login(USER, 'rob');
        const blank = await request({
            method: 'POST',
            reqPath: '/api/app/mcp/tokens',
            headers: { cookie },
            body: { label: '   ' }
        });
        expect(blank.status).toBe(400);
        expect(blank.json.error.code).toBe('BAD_LABEL');

        mcpConfig._setForTests({ enabled: true, requestsPerMinute: 1000, maxTokensPerUser: 1 });
        const first = await request({
            method: 'POST',
            reqPath: '/api/app/mcp/tokens',
            headers: { cookie },
            body: { label: 'One' }
        });
        expect(first.status).toBe(200);
        const second = await request({
            method: 'POST',
            reqPath: '/api/app/mcp/tokens',
            headers: { cookie },
            body: { label: 'Two' }
        });
        expect(second.status).toBe(409);
        expect(second.json.error.code).toBe('TOO_MANY_TOKENS');
    });

    test('forget-me deletes tokens and export keeps the label without the hash', async () => {
        const created = await mcpTokenService.create({ userId: FORGOTTEN, label: 'Phone', scope: 'docs' });
        const data = await snapshot(FORGOTTEN);
        expect(data.mcp_tokens).toHaveLength(1);
        expect(data.mcp_tokens[0].label).toBe('Phone');
        expect(data.mcp_tokens[0].scope).toBe('docs');
        expect(data.mcp_tokens[0].expiresAt).toBe(created.expiresAt);
        expect(data.mcp_tokens[0].tokenHash).toBeUndefined();
        expect(JSON.stringify(data)).not.toContain(created.token);

        const counts = await privacyService.forgetUser({ userId: FORGOTTEN });
        expect(counts.mcpTokens).toBe(1);
        const audit = await privacyService.auditUser({ userId: FORGOTTEN });
        expect(audit.byTable.mcp_tokens).toBe(0);
        expect(await mcpTokenService.authenticate(created.token)).toBeNull();
    });
});

describe('stdio framing', () => {
    test('answers every request that is still running when stdin closes', async () => {
        const { attachStdio } = require('@goobster/core/mcp/protocol');
        const input = new PassThrough();
        const output = new PassThrough();
        const chunks = [];
        output.on('data', chunk => chunks.push(chunk));
        const done = attachStdio({
            input,
            output,
            onMessage: async (message) => {
                await new Promise(resolve => setTimeout(resolve, message.id === 1 ? 60 : 10));
                if (message.id === 3) throw new Error('boom');
                return { kind: 'response', body: { jsonrpc: '2.0', id: message.id, result: {} } };
            }
        });
        input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
        input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
        input.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
        input.write('not json\n');
        input.end('{"jsonrpc":"2.0","id":4,"method":"ping"}');
        await done;
        const replies = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
        const byId = new Map(replies.filter(reply => reply.id !== null).map(reply => [reply.id, reply]));
        expect(byId.get(1).result).toEqual({});
        expect(byId.get(2).result).toEqual({});
        expect(byId.get(3).error.code).toBe(-32603);
        expect(byId.get(4).result).toEqual({});
        expect(replies.some(reply => reply.error?.code === -32700)).toBe(true);
        expect(replies).toHaveLength(5);
    });
});

describe('a clean stdout', () => {
    const { spawnSync } = require('node:child_process');
    const { reserveStdout } = require('@goobster/core/mcp/stdout');
    const ROOT = path.join(__dirname, '..');

    function childEnv(dbPath, extra = {}) {
        const env = { ...process.env, GOOBSTER_DB_PATH: dbPath, GOOBSTER_MCP_ENABLED: '1', ...extra };
        delete env.GOOBSTER_DB_URL;
        delete env.GOOBSTER_PG_TEST_ISOLATE;
        return env;
    }

    test('reserveStdout sends stray writes to stderr and keeps the real stdout for the caller', () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const out = [];
        const err = [];
        stdout.on('data', chunk => out.push(chunk.toString()));
        stderr.on('data', chunk => err.push(chunk.toString()));
        const protocol = reserveStdout(stdout, stderr);
        stdout.write('[DB] Migrated: added something\n');
        protocol.write('{"jsonrpc":"2.0"}\n');
        expect(out.join('')).toBe('{"jsonrpc":"2.0"}\n');
        expect(err.join('')).toBe('[DB] Migrated: added something\n');
    });

    test('a first run prints only the secret on stdout, and a migration never reaches the MCP client', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-mcp-clean-'));
        const dbPath = path.join(dir, 'fresh.sqlite');
        try {
            const created = spawnSync(process.execPath, [
                'scripts/mcp-token.js', 'create', '--user', '100000000000000061', '--label', 'Clean', '--scope', 'docs'
            ], { cwd: ROOT, env: childEnv(dbPath), encoding: 'utf8' });
            expect(created.status).toBe(0);
            expect(created.stderr).toMatch(/Migrated/);
            const lines = created.stdout.trim().split('\n');
            expect(lines).toHaveLength(1);
            expect(lines[0]).toMatch(/^gst_[A-Za-z0-9_-]{43}$/);

            // Drop a migrated column so the server's own first open has to migrate again.
            const Database = require('better-sqlite3');
            const raw = new Database(dbPath);
            raw.exec('ALTER TABLE stock_symbols DROP COLUMN ivUpdatedAt');
            raw.close();

            const requests = [
                { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
                { jsonrpc: '2.0', id: 2, method: 'tools/list' },
                { jsonrpc: '2.0', id: 3, method: 'resources/templates/list' }
            ].map(message => JSON.stringify(message)).join('\n');
            const served = spawnSync(process.execPath, ['apps/mcp/index.js'], {
                cwd: ROOT,
                env: childEnv(dbPath, { GOOBSTER_MCP_TOKEN: lines[0] }),
                input: `${requests}\n`,
                encoding: 'utf8'
            });
            expect(served.status).toBe(0);
            expect(served.stderr).toMatch(/Migrated: added stock_symbols\.ivUpdatedAt/);
            const replies = served.stdout.trim().split('\n').map(line => JSON.parse(line));
            expect(replies).toHaveLength(3);
            const byId = new Map(replies.map(reply => [reply.id, reply]));
            expect(byId.get(1).result.protocolVersion).toBe('2025-06-18');
            expect(byId.get(2).result.tools.map(tool => tool.name).sort()).toEqual(['list_docs', 'read_doc', 'search_docs']);
            expect(byId.get(3).result.resourceTemplates).toHaveLength(1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the stdio entry tells an expired token from a wrong one and exits non-zero', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-mcp-expired-'));
        const dbPath = path.join(dir, 'expired.sqlite');
        try {
            const created = spawnSync(process.execPath, [
                'scripts/mcp-token.js', 'create', '--user', '100000000000000062', '--label', 'Soon'
            ], { cwd: ROOT, env: childEnv(dbPath), encoding: 'utf8' });
            const token = created.stdout.trim();
            const Database = require('better-sqlite3');
            const raw = new Database(dbPath);
            raw.prepare('UPDATE mcp_tokens SET expiresAt = ?').run('2020-01-01 00:00:00');
            raw.close();

            const expired = spawnSync(process.execPath, ['apps/mcp/index.js'], {
                cwd: ROOT, env: childEnv(dbPath, { GOOBSTER_MCP_TOKEN: token }), input: '', encoding: 'utf8'
            });
            expect(expired.status).toBe(1);
            expect(expired.stderr).toMatch(/expired/i);
            expect(expired.stdout).toBe('');

            const wrong = spawnSync(process.execPath, ['apps/mcp/index.js'], {
                cwd: ROOT, env: childEnv(dbPath, { GOOBSTER_MCP_TOKEN: `gst_${'a'.repeat(43)}` }), input: '', encoding: 'utf8'
            });
            expect(wrong.status).toBe(1);
            expect(wrong.stderr).toMatch(/not valid/i);
            expect(wrong.stderr).not.toMatch(/expired/i);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('stdio entry', () => {
    test('requiring the entry does not start the server', () => {
        const entry = require('../apps/mcp/index.js');
        expect(typeof entry.main).toBe('function');
    });
});
