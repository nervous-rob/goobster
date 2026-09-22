const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-shared-'));
process.env.GOOBSTER_DB_PATH = path.join(temp, 'db.sqlite');
const db = require('@goobster/core/db');
const identity = require('@goobster/core/services/identityService');
const sessions = require('@goobster/core/services/webSessionService');
const admission = require('@goobster/core/services/resourceAdmissionService');
const kg = require('@goobster/core/services/knowledgeGraphService');
const settings = require('@goobster/core/services/userSettingsService');
const assets = require('@goobster/core/services/projectAssetService');
const projects = require('@goobster/core/services/projectService');
const missions = require('@goobster/core/services/projectMissionService');
const privacy = require('@goobster/core/services/privacyService');
const { createWebAppContext, createWebAppApp, attachWebAppWebSocket } = require('@goobster/core/web/appApi');
const { authorizedChannel } = require('@goobster/core/web/liveAuthorization');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const { DisabledGateway } = require('@goobster/core/gateway/disabledGateway');
let a, b, tokenA, tokenB, server, base, wss;
let voiceSocket;

async function account(name) {
    const p = await identity.createNativePrincipal({ displayName: name });
    await identity.grantAccount({ principalId: p.id, entitlement: 'invite' });
    return p.id;
}
async function api(url, { user = tokenA, method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(base + url, { method, headers: {
        cookie: `goobster_web_session=${user}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json(), headers: res.headers };
}
async function project(owner = a, slug = `lab-${Date.now()}-${Math.random().toString(36).slice(2)}`) {
    const id = await db.insert('INSERT INTO observatory_projects (userId, slug, name) VALUES (@owner, @slug, @slug)', { owner, slug });
    return { id, slug, owner };
}

beforeAll(async () => {
    a = await account('Alice'); b = await account('Bob');
    tokenA = (await sessions.create({ userId: a, userName: 'Alice' })).token;
    tokenB = (await sessions.create({ userId: b, userName: 'Bob' })).token;
    const ctx = createWebAppContext({ gateway: new DisabledGateway(), config: { webapp: { enabled: true } }, deps: {
        voiceLive: { handleConnection(socket) { voiceSocket = socket; socket.send(JSON.stringify({ type: 'hello' })); } }
    } });
    server = http.createServer(express().use(createWebAppApp(ctx)));
    wss = attachWebAppWebSocket(server, ctx);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await db.closeConnection();
    fs.rmSync(temp, { recursive: true, force: true });
});

test('private notes, search snippets and guessed mutations stay in the authenticated account', async () => {
    const secret = await kg.createUserNote({ guildId: `dm:${b}`, userId: b, label: 'Bob secret', content: 'private nebula evidence' });
    const own = await api(`/api/app/spitball/notes?scope=${encodeURIComponent(`dm:${a}`)}&q=nebula`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain('private nebula');
    const foreign = await api(`/api/app/spitball/notes?scope=${encodeURIComponent(`dm:${b}`)}`);
    expect(foreign.status).toBe(403);
    for (const method of ['PATCH', 'DELETE']) {
        const result = await api(`/api/app/spitball/notes/${secret.id}?scope=${encodeURIComponent(`dm:${a}`)}`, { method,
            body: { scope: `dm:${a}`, userId: b, content: 'stolen' } });
        expect(result.status).toBe(404);
    }
    const unknown = await api(`/api/app/spitball/notes/99999999`, { method: 'PATCH', body: { scope: `dm:${a}`, content: 'stolen' } });
    expect(unknown.status).toBe(404);
    const p = await project(b);
    const denied = await api(`/api/app/projects/${p.slug}/assets?owner=${b}`);
    expect(denied.status).toBe(404);
    expect(JSON.stringify(denied.body)).not.toContain('private nebula');
});

test('a stale browser account/session header cannot write with the new cookie', async () => {
    const response = await api('/api/app/settings/profile', { user: tokenB, method: 'PATCH',
        headers: { 'X-Goobster-Account': a }, body: { changes: { nickname: 'wrong account' } } });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('SESSION_CHANGED');
    expect(response.headers.get('x-goobster-session-invalid')).toBe('1');
    expect((await api('/api/app/me')).headers.get('cache-control')).toBe('no-store');
    expect((await api('/api/app/settings/legacy-lab', { method: 'POST' })).status).toBe(403);
});

test('two simultaneous settings writes with one revision have exactly one winner', async () => {
    const revision = await settings.getRevision(a, 'appearance');
    const results = await Promise.allSettled(['light', 'dark'].map(theme => settings.updateSection({
        userId: a, section: 'appearance', expectedRevision: revision, changes: { theme }
    })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason.code).toBe('SETTINGS_CONFLICT');
    expect(await settings.getRevision(a, 'appearance')).toBe(revision + 1);
});

test('stale and concurrent note edits preserve the winner and return a conflict', async () => {
    const note = await kg.createUserNote({ guildId: `dm:${a}`, userId: a, label: 'Shared editing fixture', content: 'original' });
    const writes = await Promise.allSettled(['first', 'second'].map(content => kg.updateUserNote({
        guildId: `dm:${a}`, userId: a, nodeId: note.id, content, expectedRevision: note.revision
    })));
    expect(writes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find(r => r.status === 'rejected').reason.code).toBe('EDIT_CONFLICT');
    await expect(kg.updateUserNote({ guildId: `dm:${a}`, userId: a, nodeId: note.id, content: 'stale', expectedRevision: note.revision }))
        .rejects.toMatchObject({ status: 409, code: 'EDIT_CONFLICT' });
});

test('asset head and plan edits detect conflicts, and membership is checked after the write lock', async () => {
    const p = await project();
    await db.run('INSERT INTO project_members (projectId, userId, invitedBy) VALUES (@id, @user, @inviter)', { id: p.id, user: b, inviter: a });
    const first = await assets.save({ userId: a, project: p.slug, slug: 'brief', name: 'Brief', kind: 'note', source: 'original' });
    const writes = await Promise.allSettled([a, b].map(userId => assets.save({ userId, owner: a, project: p.slug,
        slug: 'brief', name: 'Brief', kind: 'note', source: userId, expectedRevision: first.revision })));
    expect(writes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find(r => r.status === 'rejected').reason.code).toBe('EDIT_CONFLICT');
    await expect(assets.rollback({ userId: a, project: p.slug, asset: 'brief', version: 1, expectedRevision: first.revision }))
        .rejects.toMatchObject({ code: 'EDIT_CONFLICT' });
    const mission = await missions.create({ userId: a, project: p.slug, title: 'Plan', objective: 'Compare evidence', successCriteria: ['Citations checked'] });
    const edits = await Promise.allSettled(['one', 'two'].map(title => missions.updateDraft({
        userId: a, project: p.slug, missionId: mission.id, title, expectedRevision: mission.planRevision
    })));
    expect(edits.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(edits.find(r => r.status === 'rejected').reason.code).toBe('EDIT_CONFLICT');
    // Pause immediately after the initial access check, revoke, then resume.
    const real = assets._requireProject.bind(assets);
    const spy = jest.spyOn(assets, '_requireProject').mockImplementationOnce(async (...args) => {
        const row = await real(...args);
        await projects.removeMember({ userId: a, project: p.slug, memberId: b });
        return row;
    });
    try {
        await expect(assets.save({ userId: b, owner: a, project: p.slug, name: 'queued', kind: 'note', source: 'blocked' }))
            .rejects.toMatchObject({ code: 'NO_SUCH_PROJECT' });
    } finally { spy.mockRestore(); }
    expect(await db.get('SELECT id FROM project_assets WHERE projectId = @id AND slug = @slug', { id: p.id, slug: 'queued' })).toBeUndefined();
});

test('an authorization failure drops already-queued private stream frames', async () => {
    let resolve;
    const check = new Promise(done => { resolve = done; });
    const write = jest.fn(); const close = jest.fn();
    const channel = authorizedChannel({ authorize: () => check, write, close });
    channel.send('private response');
    resolve(false);
    await channel.end();
    expect(write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(true);
});

test('SSE and WebSocket sessions stop after database revocation, including idle connections', async () => {
    const token = (await sessions.create({ userId: a })).token;
    const response = await fetch(`${base}/api/app/events`, { headers: { cookie: `goobster_web_session=${token}` } });
    const reader = response.body.getReader();
    expect(Buffer.from((await reader.read()).value).toString()).toContain('hello');
    await sessions.destroy(token);
    let text = '';
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += Buffer.from(chunk.value).toString(); }
    expect(text).toContain('session-revoked');
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/app/voice/live', { headers: { cookie: `goobster_web_session=${tokenB}` } });
    await once(socket, 'message');
    const closed = once(socket, 'close');
    await db.run('UPDATE app_accounts SET sessionVersion = sessionVersion + 1 WHERE principalId = @id', { id: b });
    voiceSocket.send(JSON.stringify({ type: 'private', text: 'must not arrive' }));
    const received = [];
    socket.on('message', data => received.push(data.toString()));
    await closed;
    expect(received.join('')).not.toContain('must not arrive');
    tokenB = (await sessions.create({ userId: b })).token;
});

test('invited accounts refuse the weak sandbox escape hatch before spawning', async () => {
    const sandbox = new SandboxService({ enabled: true, requireStrongIsolation: false, maxConcurrent: 1, runsPerWindow: 10 });
    jest.spyOn(sandbox, '_resolveIsolation').mockReturnValue('none');
    const spawn = jest.spyOn(sandbox, '_spawn');
    await expect(sandbox.run({ userId: a, language: 'python', code: 'print(1)' }))
        .rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE' });
    expect(spawn).not.toHaveBeenCalled();
});

test('admission gives another account a slot, bounds queues and cancels waiting work', async () => {
    const resource = 'fair-test';
    const first = await admission.acquire({ resource, actorId: a, limit: 2 });
    const other = await admission.acquire({ resource, actorId: b, limit: 2 });
    const controller = new AbortController();
    const pending = admission.acquire({ resource, actorId: a, limit: 2, waitMs: 2000, maxQueuedPerActor: 1, signal: controller.signal });
    // Wait for the actual persisted queue claim, not a timing assumption.
    while (!(await db.get("SELECT id FROM execution_admissions WHERE resource = @resource AND state = 'queued'", { resource }))) {
        await new Promise(resolve => setImmediate(resolve));
    }
    await expect(admission.acquire({ resource, actorId: a, limit: 2, maxQueuedPerActor: 1 })).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await first.release(); await other.release();
});

test('two processes share the cap; a crashed lease expires without an old owner renewing it', async () => {
    const env = { ...process.env, GOOBSTER_PG_TEST_ISOLATE: '0' };
    if (db.engine === 'postgres') {
        const { rows } = await db.rawQuery('SELECT current_schema() AS name');
        const url = new URL(env.GOOBSTER_DB_URL);
        url.searchParams.set('options', `-c search_path=${rows[0].name},public`);
        env.GOOBSTER_DB_URL = url.toString();
    }
    const child = fork(path.join(__dirname, 'fixtures/admissionWorker.js'), { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
        expect((await once(child, 'message'))[0]).toEqual({ ready: true });
        const claimed = once(child, 'message');
        child.send({ action: 'claim', options: { resource: 'process-test', actorId: a, limit: 1, leaseMs: 1000 } });
        const id = (await claimed)[0].claimed;
        expect(id).toBeTruthy();
        await expect(admission.acquire({ resource: 'process-test', actorId: b })).rejects.toMatchObject({ code: 'BUSY' });
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        // Deterministic crash-expiry boundary without sleeping a lease duration.
        await db.run('UPDATE execution_admissions SET expiresAt = @expired WHERE id = @id', { id, expired: Date.now() - 1 });
        const replacement = await admission.acquire({ resource: 'process-test', actorId: b });
        expect(replacement.id).not.toBe(id);
        await replacement.release();
    } finally { child.kill(); }
});

test('disabled accounts cannot enter queues and erasure reaches admission records', async () => {
    const id = await account('Temporary');
    const lease = await admission.acquire({ resource: 'privacy-test', actorId: id, scopeId: `dm:${id}` });
    expect((await privacy.buildUserReport({ userId: id, guildId: `dm:${id}` })).executionAdmissions).toHaveLength(1);
    await db.run("UPDATE app_accounts SET status = 'disabled' WHERE principalId = @id", { id });
    await expect(lease.renew()).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    await expect(admission.acquire({ resource: 'another-test', actorId: id })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    await privacy.forgetUser({ userId: id });
    expect((await privacy.auditUser({ userId: id })).byTable.execution_admissions).toBe(0);
});

test('per-session connection caps share the database and release on close', async () => {
    const { reserveConnection } = require('@goobster/core/web/liveAuthorization');
    const policy = require('@goobster/core/config/admissionConfig');
    const previous = policy.streamPerSession;
    policy.streamPerSession = 1;
    let first, second;
    try {
        first = await reserveConnection({ userId: a, id: 'cap-fixture' });
        await expect(reserveConnection({ userId: a, id: 'cap-fixture' })).rejects.toMatchObject({ code: 'BUSY' });
        second = await reserveConnection({ userId: a, id: 'different-session' });
        await first.release();
        first = await reserveConnection({ userId: a, id: 'cap-fixture' });
    } finally {
        policy.streamPerSession = previous;
        await first?.release(); await second?.release();
    }
});

test('a stale mirrored discussion membership cannot retain project access or list metadata', async () => {
    const parlor = require('@goobster/core/services/parlorService');
    const p = await project();
    const id = await db.insert('INSERT INTO parlor_conversations (ownerId, projectId, title) VALUES (@owner, @project, @title)', {
        owner: a, project: p.id, title: 'Project private canary'
    });
    await db.run('INSERT INTO parlor_members (conversationId, userId, invitedBy) VALUES (@id, @user, @owner)', { id, user: b, owner: a });
    await expect(parlor.requireConversationAccess(b, id)).rejects.toMatchObject({ status: 404 });
    expect((await parlor.listConversations(b)).some(row => row.id === id)).toBe(false);
});

test('an unavailable authorization store closes a stream without flushing content', async () => {
    const write = jest.fn(); const close = jest.fn();
    const channel = authorizedChannel({ authorize: async () => { throw new Error('database unavailable'); }, write, close });
    channel.send('private response');
    await channel.end();
    expect(write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(true);
});

test('queued model admission announces waiting and does not repeat the work', async () => {
    const resource = 'queue-progress-test';
    const first = await admission.acquire({ resource, actorId: a });
    let started = 0;
    let waiting;
    const announced = new Promise(resolve => { waiting = resolve; });
    const onWaiting = jest.fn(value => { if (value) waiting(); });
    const pending = admission.run({ resource, actorId: b, waitMs: 2000, onWaiting }, async () => { started++; return 'done'; });
    await announced;
    expect(started).toBe(0);
    await first.release();
    expect(await pending).toBe('done');
    expect(onWaiting.mock.calls).toEqual([[true], [false]]);
    expect(started).toBe(1);
});

test('portal event subscriptions cannot receive another account\'s invalidation payload', async () => {
    const token = (await sessions.create({ userId: a })).token;
    const response = await fetch(`${base}/api/app/events`, { headers: { cookie: `goobster_web_session=${token}` } });
    const reader = response.body.getReader();
    await reader.read(); // authorized hello
    const events = require('@goobster/core/services/eventBusService');
    events.publish('project-changed', { userId: b, slug: 'foreign-project-canary' });
    events.publish('project-changed', { userId: a, slug: 'own-project-canary' });
    let text = '';
    while (!text.includes('own-project-canary')) text += Buffer.from((await reader.read()).value).toString();
    await sessions.destroy(token);
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += Buffer.from(chunk.value).toString(); }
    expect(text).not.toContain('foreign-project-canary');
});
