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

const db = require('@goobster/core/db');
const mcpConfig = require('@goobster/core/config/mcpConfig');
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

        const unknown = await rpc(created.token, { jsonrpc: '2.0', id: 4, method: 'resources/list' });
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
        const app = express();
        expect(mountMcpIfEnabled(app, { logger: { info() {} } })).toBe(false);
        expect(consume('mcp:unused', 1)).toBe(true);
        expect(toolDescriptors().length).toBeGreaterThan(5);
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

describe('portal tokens, privacy, and export', () => {
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
        const created = await mcpTokenService.create({ userId: FORGOTTEN, label: 'Phone' });
        const data = await snapshot(FORGOTTEN);
        expect(data.mcp_tokens).toHaveLength(1);
        expect(data.mcp_tokens[0].label).toBe('Phone');
        expect(data.mcp_tokens[0].tokenHash).toBeUndefined();
        expect(JSON.stringify(data)).not.toContain(created.token);

        const counts = await privacyService.forgetUser({ userId: FORGOTTEN });
        expect(counts.mcpTokens).toBe(1);
        const audit = await privacyService.auditUser({ userId: FORGOTTEN });
        expect(audit.byTable.mcp_tokens).toBe(0);
        expect(await mcpTokenService.authenticate(created.token)).toBeNull();
    });
});

describe('stdio entry', () => {
    test('requiring the entry does not start the server', () => {
        const entry = require('../apps/mcp/index.js');
        expect(typeof entry.main).toBe('function');
    });
});
