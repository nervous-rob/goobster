/**
 * Feature policy at the MCP surface (#319, P1.4).
 *
 * Covers packages/core/mcp (tools, resources, surface, http, stdio) and
 * apps/mcp: tool and resource listings, direct tools/call and resources/read,
 * and both transports are filtered per request from the feature state; with
 * the `mcp` feature off HTTP answers 404 and stdio serves nothing, while
 * token revocation and the privacy erasure path stay reachable through core.
 *
 * Feature state is injected with `features._resetForTests` and an in-memory
 * file, so nothing here reads or writes data/features.json.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-feature-gating-mcp-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const mcpConfig = require('@goobster/core/config/mcpConfig');
const mcpTokenService = require('@goobster/core/services/mcpTokenService');
const privacyService = require('@goobster/core/services/privacyService');
const { features } = require('@goobster/core/features/featureState');
const catalog = require('@goobster/core/features/catalog');
const { createMcpApp, mountMcpIfEnabled } = require('@goobster/core/mcp/http');
const { serveStdio } = require('@goobster/core/mcp/stdio');
const { TOOLS, toolDescriptors, callTool, toolNames } = require('@goobster/core/mcp/tools');
const { listResources, listResourceTemplates, readResource } = require('@goobster/core/mcp/resources');
const { _resetForTests: resetRate } = require('@goobster/core/mcp/rateLimit');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

jest.setTimeout(60_000);

const ROOT = path.join(__dirname, '..');
const USER = '100000000000000071';
const OTHER = '100000000000000072';
const MANAGEABLE = catalog.FEATURE_IDS.filter(id => id !== 'core');
const FILE = '/virtual/data/features.json';
const silent = { error() {}, warn() {}, info() {}, debug() {} };

const EXPEDITION_TOOLS = ['list_expeditions', 'get_expedition', 'list_briefs', 'get_brief'];
const PROJECT_TOOLS = ['list_projects', 'get_project', 'list_project_files'];

function useFileState({ off = [] } = {}) {
    const entries = {};
    for (const id of MANAGEABLE) entries[id] = { installed: true, active: !off.includes(id) };
    const text = JSON.stringify({
        version: 1, revision: 1, updatedAt: '2026-10-06 21:14:02', origin: 'operator', features: entries
    });
    features._resetForTests({
        fs: { existsSync: (p) => p === FILE, readFileSync: () => text },
        filePath: FILE,
        env: {},
        config: { token: 'jest-placeholder' }
    });
}

function useLegacyState() {
    features._resetForTests();
}

let server;
let port;

function request({ method = 'POST', reqPath = '/mcp', headers = {}, body = null }) {
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: reqPath,
            method,
            headers: {
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                ...headers
            }
        }, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const headersFor = (token) => ({
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {})
});

async function rpc(token, method, params = {}, id = 1) {
    return request({ headers: headersFor(token), body: { jsonrpc: '2.0', id, method, params } });
}

async function newToken(scope) {
    return (await mcpTokenService.create({ userId: USER, label: 'gate', ...(scope ? { scope } : {}) })).token;
}

async function seedBrief(userId) {
    const expeditionId = await db.insert(
        `INSERT INTO spitball_expeditions (userId, guildId, scopeKey, seed, status)
         VALUES (@userId, @guildId, @scopeKey, 'seed', 'COMPLETED')`,
        { userId, guildId: dmScopeId(userId), scopeKey: `USER:${userId}` }
    );
    return db.insert(
        `INSERT INTO expedition_briefs (expeditionId, userId, status, errorCode)
         VALUES (@expeditionId, @userId, 'FAILED', 'BUDGET')`,
        { expeditionId, userId }
    );
}

async function allResources(token) {
    const reply = await rpc(token, 'resources/list');
    expect(reply.status).toBe(200);
    return reply.json.result.resources;
}

beforeAll((done) => {
    mcpConfig._setForTests({ enabled: true, requestsPerMinute: 1000, maxTokensPerUser: 10 });
    const app = express();
    app.use('/mcp', createMcpApp({ logger: silent }));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

beforeEach(async () => {
    mcpConfig._setForTests({ enabled: true, requestsPerMinute: 1000, maxTokensPerUser: 10 });
    useLegacyState();
    resetRate();
    mcpTokenService._resetForTests();
    for (const table of ['expedition_briefs', 'mcp_tokens', 'spitball_expeditions', 'observatory_projects']) {
        await db.run(`DELETE FROM ${table}`);
    }
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterAll(async () => {
    mcpConfig._setForTests(null);
    useLegacyState();
    if (server) await new Promise(resolve => server.close(resolve));
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${TEST_DB}${suffix}`, { force: true });
});

describe('no features.json: the MCP surface is unchanged', () => {
    test('every tool and both resource families are offered', async () => {
        expect(features.status().source).toBe('none');
        expect(features.isActive('mcp')).toBe(true);
        const token = await newToken();
        const mine = await seedBrief(USER);

        const listed = await rpc(token, 'tools/list');
        expect(listed.json.result.tools.map(tool => tool.name)).toEqual(TOOLS.map(tool => tool.name));
        expect(toolNames()).toEqual(TOOLS.map(tool => tool.name));

        const uris = (await allResources(token)).map(entry => entry.uri);
        expect(uris.some(uri => uri.startsWith('goobster://docs/'))).toBe(true);
        expect(uris).toContain(`goobster://briefs/${mine}`);

        const templates = await rpc(token, 'resources/templates/list');
        expect(templates.json.result.resourceTemplates.map(entry => entry.uriTemplate))
            .toEqual(['goobster://docs/{slug}', 'goobster://briefs/{id}']);
    });

    test('with the switch off the legacy answer is still no mount', () => {
        mcpConfig._setForTests({ enabled: false });
        useLegacyState();
        expect(mountMcpIfEnabled(express(), { logger: { info() {} } })).toBe(false);
    });
});

describe('listings follow the feature state', () => {
    test('expeditions off removes its tools, its briefs resources and its template, nothing else', async () => {
        useFileState({ off: ['expeditions'] });
        const token = await newToken();
        await seedBrief(USER);

        const names = (await rpc(token, 'tools/list')).json.result.tools.map(tool => tool.name);
        for (const gone of EXPEDITION_TOOLS) expect(names).not.toContain(gone);
        for (const kept of [...PROJECT_TOOLS, 'list_docs', 'search_docs', 'search_memories', 'search_knowledge', 'list_inbox']) {
            expect(names).toContain(kept);
        }

        const uris = (await allResources(token)).map(entry => entry.uri);
        expect(uris.some(uri => uri.startsWith('goobster://briefs/'))).toBe(false);
        expect(uris.some(uri => uri.startsWith('goobster://docs/'))).toBe(true);

        const templates = await rpc(token, 'resources/templates/list');
        expect(templates.json.result.resourceTemplates.map(entry => entry.uriTemplate)).toEqual(['goobster://docs/{slug}']);
    });

    test('projects off removes only the project tools', async () => {
        useFileState({ off: ['projects'] });
        const names = toolDescriptors().map(tool => tool.name);
        for (const gone of PROJECT_TOOLS) expect(names).not.toContain(gone);
        expect(names).toEqual(expect.arrayContaining([...EXPEDITION_TOOLS, 'search_knowledge', 'list_inbox']));
    });

    test('knowledge off removes search_knowledge and the expeditions that depend on it', async () => {
        useFileState({ off: ['knowledge'] });
        const names = toolDescriptors().map(tool => tool.name);
        expect(names).not.toContain('search_knowledge');
        for (const gone of EXPEDITION_TOOLS) expect(names).not.toContain(gone);
        expect(names).toEqual(expect.arrayContaining(['list_docs', 'list_projects', 'list_inbox', 'search_memories']));
    });

    test('a docs token keeps exactly the documentation tools whatever else is off', async () => {
        useFileState({ off: ['projects', 'expeditions', 'knowledge'] });
        const token = await newToken('docs');
        const names = (await rpc(token, 'tools/list')).json.result.tools.map(tool => tool.name);
        expect(names).toEqual(['list_docs', 'search_docs', 'read_doc']);
    });

    test('everything optional off still serves the core tools and the manual', async () => {
        useFileState({ off: MANAGEABLE.filter(id => id !== 'mcp') });
        const token = await newToken();
        const names = (await rpc(token, 'tools/list')).json.result.tools.map(tool => tool.name);
        expect(names.sort()).toEqual([
            'get_inbox_item', 'list_docs', 'list_facts', 'list_inbox', 'read_doc', 'search_docs', 'search_memories'
        ]);
        const docs = await rpc(token, 'tools/call', { name: 'list_docs', arguments: {} });
        expect(docs.json.result.isError).toBeUndefined();
        expect((await allResources(token)).length).toBeGreaterThan(0);
    });

    test('is re-evaluated on the next request, not at mount time', async () => {
        const token = await newToken();
        useFileState();
        expect((await rpc(token, 'tools/list')).json.result.tools.map(tool => tool.name)).toContain('list_briefs');
        useFileState({ off: ['expeditions'] });
        expect((await rpc(token, 'tools/list')).json.result.tools.map(tool => tool.name)).not.toContain('list_briefs');
    });
});

describe('a direct call to a switched-off tool or resource is refused before it reads anything', () => {
    function spyOnReaders() {
        const expeditions = require('@goobster/core/services/spitballExpeditionService');
        const briefs = require('@goobster/core/services/expeditionBriefService');
        const projects = require('@goobster/core/services/projectService');
        const knowledge = require('@goobster/core/services/knowledgeGraphService');
        return {
            listExpeditions: jest.spyOn(expeditions, 'listExpeditions'),
            getExpedition: jest.spyOn(expeditions, 'getExpedition'),
            listBriefs: jest.spyOn(briefs, 'listForUser'),
            getBrief: jest.spyOn(briefs, 'get'),
            listProjects: jest.spyOn(projects, 'listProjects'),
            listFiles: jest.spyOn(projects, 'listFiles'),
            searchNodes: jest.spyOn(knowledge, 'searchNodes'),
            topNodes: jest.spyOn(knowledge, 'topNodes')
        };
    }

    test.each([
        ['list_briefs', ['expeditions']],
        ['get_brief', ['expeditions']],
        ['list_expeditions', ['expeditions']],
        ['get_expedition', ['expeditions']],
        ['list_projects', ['projects']],
        ['get_project', ['projects']],
        ['list_project_files', ['projects']],
        ['search_knowledge', ['knowledge']]
    ])('tools/call %s over HTTP', async (name, off) => {
        useFileState({ off });
        const token = await newToken();
        const spies = spyOnReaders();

        const reply = await rpc(token, 'tools/call', { name, arguments: { id: 1, project: 'x', query: 'x' } });

        expect(reply.status).toBe(200);
        expect(reply.json.error.code).toBe(-32602);
        expect(reply.json.error.message).toBe(`${name} is not available on this installation.`);
        expect(reply.json.result).toBeUndefined();
        for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    });

    test('callTool itself refuses, so no transport can bypass the gate', async () => {
        useFileState({ off: ['expeditions'] });
        const spies = spyOnReaders();
        await expect(callTool(USER, 'get_brief', { id: 1 }, { scope: 'read' })).rejects.toMatchObject({
            rpcCode: -32602, publicMessage: 'get_brief is not available on this installation.'
        });
        expect(spies.getBrief).not.toHaveBeenCalled();
    });

    test('the token scope is still checked first and an unknown tool is still unknown', async () => {
        useFileState({ off: ['expeditions'] });
        await expect(callTool(USER, 'get_brief', { id: 1 }, { scope: 'docs' })).rejects.toMatchObject({
            rpcCode: -32602, publicMessage: expect.stringMatching(/scope does not include get_brief/)
        });
        await expect(callTool(USER, 'delete_memory', {}, { scope: 'read' })).rejects.toMatchObject({
            publicMessage: 'Unknown tool: delete_memory'
        });
    });

    test('an available tool still runs', async () => {
        useFileState({ off: ['expeditions'] });
        const token = await newToken();
        const reply = await rpc(token, 'tools/call', { name: 'list_projects', arguments: {} });
        expect(reply.json.result.content[0].text).toBe('No projects.');
    });

    test('resources/read of a brief URI is not found, even for the owner, and reads nothing', async () => {
        const mine = await seedBrief(USER);
        const token = await newToken();
        const uri = `goobster://briefs/${mine}`;

        useFileState();
        const control = await rpc(token, 'resources/read', { uri });
        expect(control.json.result.contents[0].text).toContain('BUDGET');

        useFileState({ off: ['expeditions'] });
        const spies = spyOnReaders();
        const refused = await rpc(token, 'resources/read', { uri });
        expect(refused.json.error.code).toBe(-32002);
        expect(refused.json.error.message).toBe('Resource not found.');
        expect(spies.getBrief).not.toHaveBeenCalled();
        expect(spies.listBriefs).not.toHaveBeenCalled();
    });

    test('the resource functions refuse directly too', async () => {
        const mine = await seedBrief(USER);
        useFileState({ off: ['expeditions'] });
        await expect(readResource(USER, 'read', `goobster://briefs/${mine}`)).rejects.toMatchObject({ rpcCode: -32002 });
        const listed = await listResources(USER, 'read');
        expect(listed.resources.some(entry => entry.uri.startsWith('goobster://briefs/'))).toBe(false);
        expect(listResourceTemplates('read').resourceTemplates).toHaveLength(1);
    });

    test('the same refusal arrives over stdio', async () => {
        useFileState({ off: ['expeditions'] });
        const token = await newToken();
        const session = await mcpTokenService.authenticate(token);
        const replies = await stdioRoundtrip(session, [
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_briefs', arguments: {} } },
            { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'goobster://briefs/1' } },
            { jsonrpc: '2.0', id: 3, method: 'tools/list' }
        ]);
        const byId = new Map(replies.map(reply => [reply.id, reply]));
        expect(byId.get(1).error.code).toBe(-32602);
        expect(byId.get(2).error.code).toBe(-32002);
        expect(byId.get(3).result.tools.map(tool => tool.name)).not.toContain('list_briefs');
    });
});

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

describe('the mcp feature itself', () => {
    test('HTTP answers 404 FEATURE_UNAVAILABLE before reading the body or the token', async () => {
        useFileState({ off: ['mcp'] });
        const token = await newToken();

        const withToken = await rpc(token, 'tools/list');
        expect(withToken.status).toBe(404);
        expect(withToken.json).toEqual({ error: 'FEATURE_UNAVAILABLE', feature: 'mcp' });
        expect(withToken.headers['cache-control']).toBe('no-store');

        const noToken = await rpc(null, 'tools/list');
        expect(noToken.status).toBe(404);
        const badToken = await rpc('gst_not-a-real-token', 'tools/list');
        expect(badToken.status).toBe(404);
        expect(badToken.headers['www-authenticate']).toBeUndefined();

        const get = await request({ method: 'GET', headers: headersFor(token) });
        expect(get.status).toBe(404);

        const malformed = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path: '/mcp', method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }
            }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
            req.on('error', reject);
            req.end('{');
        });
        expect(malformed).toBe(404);
        expect(JSON.stringify(withToken.json)).not.toMatch(/reasons|features\.json|DISABLED/);
    });

    test('is decided per request on a route that stays mounted', async () => {
        const token = await newToken();
        useFileState();
        expect((await rpc(token, 'ping')).status).toBe(200);
        useFileState({ off: ['mcp'] });
        expect((await rpc(token, 'ping')).status).toBe(404);
        useFileState();
        expect((await rpc(token, 'ping')).status).toBe(200);
    });

    test('while on, authorization is unchanged: a bad token is 401 and a revoked token stops working', async () => {
        useFileState();
        expect((await rpc('gst_not-a-real-token', 'ping')).status).toBe(401);
        const created = await mcpTokenService.create({ userId: USER, label: 'revoked' });
        expect((await rpc(created.token, 'ping')).status).toBe(200);
        await mcpTokenService.revoke({ userId: USER, id: created.id });
        expect((await rpc(created.token, 'ping')).status).toBe(401);
    });

    test('the mount helper follows the feature state, not only the legacy switch', () => {
        useFileState({ off: ['mcp'] });
        expect(mountMcpIfEnabled(express(), { logger: { info() {} } })).toBe(false);
        useFileState();
        expect(mountMcpIfEnabled(express(), { logger: { info() {} } })).toBe(true);
    });

    test('stdio refuses to start: it reads nothing and writes nothing', async () => {
        useFileState({ off: ['mcp'] });
        const created = await mcpTokenService.create({ userId: USER, label: 'stdio' });
        const session = await mcpTokenService.authenticate(created.token);
        const log = jest.fn();
        const input = new PassThrough();
        const output = new PassThrough();
        const written = [];
        output.on('data', chunk => written.push(chunk));
        const done = serveStdio({ session, input, output, log });
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
        await done;
        expect(written).toHaveLength(0);
        expect(input.listenerCount('data')).toBe(0);
        expect(log).toHaveBeenCalledWith('MCP is not available on this installation.');
    });

    test('a running stdio server stops answering when the feature goes off', async () => {
        useFileState();
        const created = await mcpTokenService.create({ userId: USER, label: 'stdio' });
        const session = await mcpTokenService.authenticate(created.token);
        const input = new PassThrough();
        const output = new PassThrough();
        const lines = [];
        output.on('data', chunk => lines.push(...chunk.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))));
        const done = serveStdio({ session, input, output, log() {} });

        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
        await new Promise(resolve => setTimeout(resolve, 100));
        useFileState({ off: ['mcp'] });
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
        input.end();
        await done;

        expect(lines.find(line => line.id === 1).result).toEqual({});
        const refused = lines.find(line => line.id === 2);
        expect(refused.error).toEqual({ code: -32000, message: 'MCP is not available on this installation.' });
        expect(refused.result).toBeUndefined();
    });

    describe('the stdio entry and the token CLI', () => {
        function childEnv(dbPath, extra = {}) {
            const env = { ...process.env, GOOBSTER_DB_PATH: dbPath, GOOBSTER_MCP_ENABLED: '1', ...extra };
            delete env.GOOBSTER_DB_URL;
            delete env.GOOBSTER_PG_TEST_ISOLATE;
            return env;
        }

        test('the entry exits non-zero and says why when the feature is off; revocation still works', () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-gate-mcp-'));
            const dbPath = path.join(dir, 'gate.sqlite');
            try {
                const cli = (args, extra = {}) => spawnSync(
                    process.execPath, ['scripts/mcp-token.js', ...args],
                    { cwd: ROOT, env: childEnv(dbPath, extra), encoding: 'utf8' }
                );
                const off = { GOOBSTER_FEATURE_MCP: 'off' };

                const created = cli(['create', '--user', '100000000000000073', '--label', 'Gate'], off);
                expect(created.status).toBe(0);
                const token = created.stdout.trim();
                expect(token).toMatch(/^gst_/);

                const entry = spawnSync(process.execPath, ['apps/mcp/index.js'], {
                    cwd: ROOT, env: childEnv(dbPath, { ...off, GOOBSTER_MCP_TOKEN: token }), input: '', encoding: 'utf8'
                });
                expect(entry.status).toBe(1);
                expect(entry.stderr).toMatch(/MCP is off on this installation/);
                expect(entry.stdout).toBe('');

                const listed = cli(['list', '--user', '100000000000000073'], off);
                expect(listed.status).toBe(0);
                const id = /^(\d+)/.exec(listed.stdout.trim())?.[1] || '1';
                const revoked = cli(['revoke', '--user', '100000000000000073', '--id', id], off);
                expect(revoked.status).toBe(0);
                const after = cli(['list', '--user', '100000000000000073'], off);
                expect(after.stdout.trim()).toBe('');

                const stillOn = spawnSync(process.execPath, ['apps/mcp/index.js'], {
                    cwd: ROOT, env: childEnv(dbPath, { GOOBSTER_MCP_TOKEN: token }), input: '', encoding: 'utf8'
                });
                expect(stillOn.stderr).toMatch(/not valid/i);
                expect(stillOn.stderr).not.toMatch(/MCP is off/);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    test('token revocation and privacy erasure stay reachable with the feature off', async () => {
        useFileState({ off: ['mcp'] });
        const first = await mcpTokenService.create({ userId: USER, label: 'one' });
        const second = await mcpTokenService.create({ userId: OTHER, label: 'two' });
        expect((await mcpTokenService.list({ userId: USER })).map(row => row.id)).toEqual([first.id]);

        await mcpTokenService.revoke({ userId: USER, id: first.id });
        expect(await mcpTokenService.list({ userId: USER })).toEqual([]);

        await privacyService.forgetUser({ userId: OTHER });
        expect(await db.all('SELECT id FROM mcp_tokens WHERE userId = @userId', { userId: OTHER })).toEqual([]);
        expect(second.id).toBeTruthy();
    });
});
