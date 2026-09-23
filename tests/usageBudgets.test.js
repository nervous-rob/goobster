const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-budgets-'));
process.env.GOOBSTER_DB_PATH = path.join(temp, 'db.sqlite');
const db = require('@goobster/core/db');
const budgets = require('@goobster/core/services/usageBudgetService');
const admission = require('@goobster/core/services/resourceAdmissionService');
const identity = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const state = require('@goobster/core/services/instanceStateService');
const usage = require('@goobster/core/services/usageTracker');
const workContext = require('@goobster/core/utils/workContext');
const cost = require('@goobster/core/services/costReportService');
const privacy = require('@goobster/core/services/privacyService');
const sessions = require('@goobster/core/services/webSessionService');
const native = require('@goobster/core/services/nativeAuthService');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const { DisabledGateway } = require('@goobster/core/gateway/disabledGateway');
const A = '100000000000000701';
const B = '100000000000000702';
const windowStart = '2000-01-01 00:00:00';
const hold = (extra = {}) => budgets.reserve({ payer: A, actor: A, work: { kind: 'chat', id: 'turn-1' }, estimatedTokens: 10, cap: 100, windowStart, ...extra });
const row = id => db.get('SELECT * FROM usage_reservations WHERE id = @id', { id });
const options = (extra = {}) => ({ estimatedTokens: 10, admissionOptions: {
    resource: 'budget-test-model', actorId: A, limit: 1, perActor: 1, waitMs: 0, leaseMs: 60000, ...extra
} });
let server, base, tokenA, tokenB;
async function api(route, { token = tokenA, method = 'GET', body } = {}) {
    const response = await fetch(base + route, { method, headers: { cookie: `goobster_web_session=${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
    identityConfig.requireAccount = false;
    for (const id of [A, B]) {
        await identity.ensureLegacyPrincipal({ discordId: id });
        await identity.grantAccount({ principalId: id, entitlement: 'migration', role: id === A ? 'operator' : 'member' });
    }
    tokenA = (await sessions.create({ userId: A })).token;
    tokenB = (await sessions.create({ userId: B })).token;
    const ctx = createWebAppContext({ gateway: new DisabledGateway(), config: { webapp: { enabled: true } } });
    server = http.createServer(express().use(createWebAppApp(ctx)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
    identityConfig.requireAccount = false;
    await state.remove('limits');
    for (const table of ['usage_reservations', 'execution_admissions', 'work_failures', 'operator_audit']) await db.run(`DELETE FROM ${table}`);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    await db.closeConnection();
    fs.rmSync(temp, { recursive: true, force: true });
});

test('twenty concurrent reservations hold exactly ten; another payer has its own cap', async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => hold()));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'BUDGET_EXCEEDED')).toBe(true);
    expect(await budgets.usedInWindow(A, windowStart)).toBe(100);
    await expect(hold({ payer: B, estimatedTokens: 100 })).resolves.toEqual(expect.any(Number));
});

test('an unset cap skips counting, and duplicate idempotency keys never buy a second hold', async () => {
    const count = jest.spyOn(budgets, 'usedInWindow');
    const id = await hold({ cap: null, estimatedTokens: 1000000, idempotencyKey: 'one-provider-call' });
    expect(count).not.toHaveBeenCalled();
    await expect(hold({ cap: null, idempotencyKey: 'one-provider-call' })).rejects.toMatchObject({ code: 'BUDGET_DUPLICATE' });
    await budgets.settle(id, { actualTokens: 5 });
    await expect(hold({ cap: null, idempotencyKey: 'one-provider-call' })).rejects.toMatchObject({ code: 'BUDGET_DUPLICATE' });
    expect((await db.get('SELECT COUNT(*) AS n FROM usage_reservations')).n).toBe(1);
});

test('settlement switches the window to actuals and is terminal; release spends nothing', async () => {
    const id = await hold();
    await budgets.settle(id, { actualTokens: 3 });
    await budgets.settle(id, { actualTokens: 99 });
    await budgets.release(id);
    const released = await hold(); await budgets.release(released);
    expect(await budgets.usedInWindow(A, windowStart)).toBe(3);
    expect(await row(id)).toMatchObject({ status: 'settled', actualTokens: 3, reconcile: 0 });
});

test.each(['BUSY', 'CANCELLED'])('admission %s releases its reservation without calling the provider', async code => {
    jest.spyOn(admission, 'run').mockRejectedValue(new admission.AdmissionError(code, code));
    const provider = jest.fn();
    await expect(budgets.run(options(), provider)).rejects.toMatchObject({ code });
    expect(provider).not.toHaveBeenCalled();
    expect(await db.get('SELECT status FROM usage_reservations')).toEqual({ status: 'released' });
});

test('an actual admission timeout releases its hold', async () => {
    const lease = await admission.acquire({ resource: 'budget-test-model', actorId: B });
    const provider = jest.fn();
    try { await expect(budgets.run(options({ waitMs: 20 }), provider)).rejects.toMatchObject({ code: 'BUSY' }); }
    finally { await lease.release(); }
    expect(await db.get('SELECT status FROM usage_reservations')).toEqual({ status: 'released' });
    expect(provider).not.toHaveBeenCalled();
});

test('uncertain provider outcomes settle the estimate, flag reconciliation, and are never retried', async () => {
    const provider = jest.fn(async () => { throw new Error('timeout after send'); });
    await expect(budgets.run(options(), provider)).rejects.toThrow('timeout after send');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await db.get('SELECT * FROM usage_reservations')).toMatchObject({ status: 'settled', actualTokens: 10, reconcile: 1 });
});

test('usage is captured per call, streaming settles only at completion, and the cost join gets actuals', async () => {
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const run = workContext.run({ kind: 'chat', id: 'stream-1', actor: B, payer: A }, () => budgets.run(options(), async () => {
        started(); await finished;
        await usage.log({ provider: 'test', model: 'fixture', operation: 'chat', inputTokens: 2, outputTokens: 3, userId: B });
        return 'complete';
    }));
    await ready;
    expect(await db.get('SELECT * FROM usage_reservations')).toMatchObject({ status: 'held', actor: B, payer: A });
    finish(); await expect(run).resolves.toBe('complete');
    const settled = await db.get('SELECT * FROM usage_reservations');
    expect(settled).toMatchObject({ status: 'settled', actualTokens: 5, reconcile: 0 });
    expect(settled.admissionId).toBeTruthy();
    const report = await cost.workCosts({ payer: A });
    expect(JSON.stringify(report)).toContain('stream-1');
    expect(report.find(r => r.workId === 'stream-1').actualTokens).toBe(5);
});

test('a missing provider usage payload is reconciled rather than treated as zero', async () => {
    await budgets.run(options(), async () => usage.log({ provider: 'test', operation: 'chat', inputTokens: 0, outputTokens: 0, usageKnown: false }));
    expect(await db.get('SELECT * FROM usage_reservations')).toMatchObject({ actualTokens: 10, reconcile: 1 });
});

test('expired crashed holds release, settled/released rows prune after 90 days, live holds remain', async () => {
    const expired = await hold({ expiresAt: '2001-01-01 00:00:00' });
    const live = await hold();
    const old = await hold(); await budgets.settle(old, { actualTokens: 1 });
    await db.run('UPDATE usage_reservations SET createdAt = @at WHERE id = @id', { id: old, at: '2001-01-01 00:00:00' });
    expect(await budgets.prune()).toEqual({ released: 1, removed: 1 });
    expect((await row(expired)).status).toBe('released');
    expect((await row(live)).status).toBe('held');
    expect(await row(old)).toBeUndefined();
});

test('foreground refuses with reset details and a reserve failure; background waits then continues', async () => {
    await budgets.setPolicy({ dailyTokens: 10 });
    const id = await hold({ cap: null });
    await expect(budgets.run(options(), jest.fn())).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', status: 429,
        details: { dailyTokens: 10, resetsAt: expect.any(String) } });
    expect(await db.get('SELECT * FROM work_failures')).toMatchObject({ kind: 'chat', phase: 'reserve', code: 'BUDGET_EXCEEDED', actor: A });
    let waiting;
    const ready = new Promise(resolve => { waiting = resolve; });
    const onWaiting = jest.fn((isWaiting, detail) => { if (isWaiting) waiting(detail); });
    const provider = jest.fn(async () => 'resumed');
    const run = budgets.run({ ...options({ waitMs: 2000, onWaiting }), background: true }, provider);
    expect(await ready).toMatchObject({ reason: 'budget', resetsAt: expect.any(String) });
    expect(provider).not.toHaveBeenCalled();
    expect((await api('/api/app/me')).body.limits.waitingRequests).toBe(1);
    expect(await db.get("SELECT COUNT(*) AS n FROM execution_admissions WHERE resource = 'budget-test-model' AND state = 'running'")).toEqual({ n: 0 });
    await budgets.release(id);
    await expect(run).resolves.toBe('resumed');
    expect(provider).toHaveBeenCalledTimes(1);
});

test('background waits are cancellable and bounded per account', async () => {
    await budgets.setPolicy({ dailyTokens: 1 });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const started = [];
    const waits = controllers.map(controller => new Promise(resolve => started.push(resolve)));
    const runs = controllers.map((controller, i) => budgets.run({ ...options({ waitMs: 3000, signal: controller.signal,
        onWaiting: waiting => { if (waiting) started[i](); } }), background: true }, jest.fn()).catch(error => error));
    try {
        await Promise.all(waits);
        await expect(budgets.run({ ...options({ waitMs: 100 }), background: true }, jest.fn())).rejects.toMatchObject({ code: 'BUSY' });
    } finally { controllers.forEach(c => c.abort()); await Promise.all(runs); }
    expect((await Promise.all(runs)).every(error => error.code === 'CANCELLED')).toBe(true);
    expect(await db.all('SELECT * FROM usage_reservations')).toHaveLength(0);
});

test('a forked process sees the same payer total', async () => {
    await hold({ estimatedTokens: 100 });
    const env = { ...process.env, GOOBSTER_PG_TEST_ISOLATE: '0' };
    if (db.engine === 'postgres') {
        const storage = await db.describeStorage();
        const url = new URL(env.GOOBSTER_DB_URL);
        url.searchParams.set('options', `-c search_path=${storage.schema},public`);
        env.GOOBSTER_DB_URL = url.toString();
    }
    const child = fork(path.join(__dirname, 'fixtures/budgetWorker.js'), { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
        expect((await once(child, 'message'))[0]).toEqual({ ready: true });
        const result = once(child, 'message');
        child.send({ payer: A, estimatedTokens: 1, cap: 100, windowStart });
        expect((await result)[0]).toEqual({ error: 'BUDGET_EXCEEDED' });
    } finally { const done = once(child, 'exit'); child.kill(); await done; }
});

test('operator limit edits audit once; members cannot edit, and /me exposes only own usage', async () => {
    await hold(); await hold({ payer: B, estimatedTokens: 50 });
    expect((await api('/api/app/admin/limits', { token: tokenB })).status).toBe(403);
    expect((await api('/api/app/admin/limits', { token: tokenB, method: 'PATCH', body: { dailyTokens: 99 } })).status).toBe(403);
    expect((await api('/api/app/admin/limits', { method: 'PATCH', body: { dailyTokens: 1000 } })).status).toBe(200);
    expect(await db.all('SELECT action FROM operator_audit')).toEqual([{ action: 'limits.change' }]);
    expect((await api('/api/app/me')).body.limits).toMatchObject({ dailyTokens: 1000, usedTokens: 10 });
    expect((await api('/api/app/me', { token: tokenB })).body.limits.usedTokens).toBe(50);
    const admin = await api('/api/app/admin/limits');
    expect(admin.body.accounts.find(a => a.principalId === B).usedTokens).toBe(50);
    expect((await api('/api/app/admin/limits', { method: 'PATCH', body: { dailyTokens: -1 } })).status).toBe(400);
    expect(await db.all('SELECT action FROM operator_audit')).toHaveLength(1);
});

test('account grants, invitations and verified signup refuse a missing cap atomically; a shared cap cannot be cleared', async () => {
    identityConfig.requireAccount = true;
    identityConfig.nativeLogin = true;
    const person = await identity.createNativePrincipal();
    await expect(identity.grantAccount({ principalId: person.id, entitlement: 'migration' })).rejects.toMatchObject({ code: 'DAILY_CAP_REQUIRED' });
    const invite = await native.createInvite({ issuedBy: A });
    const password = 'a sufficiently long test passphrase';
    await expect(native.register({ token: invite.token, loginName: 'budget-invite', password })).rejects.toMatchObject({ code: 'DAILY_CAP_REQUIRED' });
    expect((await native.inspectInvite(invite.token)).role).toBe('member');
    await expect(native._completeSignup({ id: 999 }, () => new Error('invalid'))).rejects.toMatchObject({ code: 'DAILY_CAP_REQUIRED' });
    expect((await api('/api/app/admin/accounts', { method: 'POST', body: { principalId: person.id } })).status).toBe(409);
    await budgets.setPolicy({ dailyTokens: 10000 });
    await expect(identity.grantAccount({ principalId: person.id, entitlement: 'migration' })).resolves.toMatchObject({ created: true });
    await expect(budgets.setPolicy({ dailyTokens: null })).rejects.toMatchObject({ code: 'DAILY_CAP_REQUIRED' });
});

test('erasing the collaborator preserves owner totals; erasing the payer deletes reservations and lock', async () => {
    const owner = '100000000000000711', actor = '100000000000000712';
    await hold({ payer: owner, actor });
    await privacy.forgetUser({ userId: actor });
    expect(await budgets.usedInWindow(owner, windowStart)).toBe(10);
    expect(await db.get('SELECT actor FROM usage_reservations WHERE payer = @owner', { owner })).toEqual({ actor: null });
    await privacy.forgetUser({ userId: owner });
    expect(await db.all('SELECT * FROM usage_reservations WHERE payer = @owner', { owner })).toHaveLength(0);
    expect(await db.get('SELECT * FROM admission_locks WHERE resource = @resource', { resource: `budget:${owner}` })).toBeUndefined();
});

test('the real router reserves for chat and generateText, captures usage, and refuses before provider dispatch', async () => {
    const ai = require('@goobster/core/services/aiService');
    const provider = require('@goobster/core/services/ollamaService');
    const chat = jest.spyOn(provider, 'chat').mockImplementation(async () => {
        await usage.log({ provider: 'ollama', operation: 'chat', inputTokens: 4, outputTokens: 6 });
        return { content: 'ok', toolCalls: [] };
    });
    const generate = jest.spyOn(provider, 'generateText').mockImplementation(async () => {
        await usage.log({ provider: 'ollama', operation: 'chat', inputTokens: 3, outputTokens: 2 });
        return 'title';
    });
    await workContext.run({ kind: 'chat', id: 'router-turn', actor: A }, async () => {
        await ai.chat([{ role: 'user', content: 'a private marker' }], { provider: 'ollama', max_tokens: 10 });
        await ai.generateText('another private marker', { provider: 'ollama', max_tokens: 10 });
    });
    const rows = await db.all('SELECT * FROM usage_reservations ORDER BY id');
    expect(rows.map(r => r.actualTokens)).toEqual([10, 5]);
    expect(rows.every(r => r.payer === A && r.workId === 'router-turn' && r.reconcile === 0)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('private marker');
    expect(rows[0].estimatedTokens).toBeGreaterThan(10);
    await budgets.setPolicy({ dailyTokens: 1 });
    await expect(ai.chat('no more', { provider: 'ollama', usageContext: { userId: A } })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(chat).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
});

test('an exhausted foreground portal turn returns HTTP 429 and reset details without starting work', async () => {
    await budgets.setPolicy({ dailyTokens: 10 }); await hold();
    const response = await api('/api/app/chat', { method: 'POST', body: { message: 'hello' } });
    expect(response.status).toBe(429);
    expect(response.body.error).toMatchObject({ code: 'BUDGET_EXCEEDED', details: { dailyTokens: 10, resetsAt: expect.any(String) } });
    expect(await db.all('SELECT * FROM web_live_turns')).toHaveLength(0);
});

test('background token waits also respect the installation bound', async () => {
    await budgets.setPolicy({ dailyTokens: 1 });
    for (let n = 0; n < 64; n++) await db.run(`INSERT INTO execution_admissions
        (id, resource, actorId, state, createdAt, startedAt, expiresAt)
        VALUES (@id, 'budget-wait', @actor, 'running', @now, @now, @expires)`, {
        id: `slot-${n}`, actor: `other-${n}`, now: Date.now(), expires: Date.now() + 60000
    });
    await expect(budgets.run({ ...options({ waitMs: 100 }), background: true }, jest.fn())).rejects.toMatchObject({ code: 'BUSY' });
    expect(await db.all('SELECT * FROM usage_reservations')).toHaveLength(0);
});

test('two simultaneous first-account grants cannot both pass without a cap', async () => {
    const saved = await db.all('SELECT principalId, entitlement, role, loginName FROM app_accounts');
    const people = await Promise.all([identity.createNativePrincipal(), identity.createNativePrincipal()]);
    await db.run('DELETE FROM app_accounts');
    identityConfig.requireAccount = true;
    try {
        const results = await Promise.allSettled(people.map(p => identity.grantAccount({ principalId: p.id, entitlement: 'invite' })));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.find(r => r.status === 'rejected').reason.code).toBe('DAILY_CAP_REQUIRED');
        expect(Number((await db.get('SELECT COUNT(*) AS n FROM app_accounts')).n)).toBe(1);
    } finally {
        identityConfig.requireAccount = false;
        await db.run('DELETE FROM app_accounts');
        for (const account of saved) await identity.grantAccount(account);
    }
});

test('different payers reserve concurrently; Postgres never waits on another payer lock', async () => {
    if (db.engine !== 'postgres') {
        // SQLite necessarily serializes all writes, but totals remain independent.
        expect(await Promise.all([hold({ payer: A }), hold({ payer: B })])).toHaveLength(2);
        return;
    }
    let unlock, locked;
    const gate = new Promise(resolve => { unlock = resolve; });
    const ready = new Promise(resolve => { locked = resolve; });
    const blocker = db.transaction(async tx => {
        await tx.run('INSERT INTO admission_locks (resource) VALUES (@resource) ON CONFLICT DO NOTHING', { resource: `budget:${A}` });
        await tx.run('UPDATE admission_locks SET resource = resource WHERE resource = @resource', { resource: `budget:${A}` });
        locked(); await gate;
    });
    await ready;
    try { await expect(hold({ payer: B })).resolves.toEqual(expect.any(Number)); }
    finally { unlock(); await blocker; }
});

test('provider normalization settles cached Anthropic input once and includes Gemini thinking', async () => {
    const anthropic = require('@goobster/core/services/anthropicService');
    const gemini = require('@goobster/core/services/geminiService');
    await budgets.run(options(), () => anthropic._logUsage(anthropic._normalizeUsage({
        input_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, output_tokens: 3
    }), 'fixture'));
    await budgets.run(options(), () => gemini._logUsage({ promptTokenCount: 4, candidatesTokenCount: 6, thoughtsTokenCount: 9 }, 'fixture'));
    const rows = await db.all('SELECT actualTokens, reconcile FROM usage_reservations ORDER BY id');
    expect(rows).toEqual([{ actualTokens: 17, reconcile: 0 }, { actualTokens: 19, reconcile: 0 }]);
});

test('a project expedition replaces the initiating chat context and charges the owner', async () => {
    const { SpitballExpeditionRunner } = require('@goobster/core/services/spitballExpeditionRunner');
    const projectId = await db.insert(`INSERT INTO observatory_projects (userId, slug, name) VALUES (@user, 'budget-project', 'Budget project')`, { user: A });
    const runner = new SpitballExpeditionRunner({ service: {
        claimForRun: async () => true,
        getById: async () => ({ id: 900, userId: B, projectId })
    } });
    jest.spyOn(runner, '_runCycles').mockImplementation(async () => {
        expect(workContext.current()).toEqual({ kind: 'expedition', id: '900', actor: B, payer: A });
        await budgets.run(options(), async () => usage.log({ provider: 'test', operation: 'chat', inputTokens: 3, outputTokens: 4 }));
    });
    await workContext.run({ kind: 'chat', id: 'launch-turn', actor: B }, () => runner._runLoop(900));
    expect(await db.get('SELECT * FROM usage_reservations')).toMatchObject({ payer: A, actor: B, workKind: 'expedition', workId: '900', actualTokens: 7 });
});
