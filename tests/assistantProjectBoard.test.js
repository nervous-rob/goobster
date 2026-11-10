/**
 * The project Needs-you board read over the canonical gates (DA-4b;
 * documentation/assistant_home.md, "Project boards").
 *
 * The properties under test: the board, Home and the Inbox show one
 * request (the same reference and the same decision card); a decision made
 * on the board goes through the same dispatcher and resolves it
 * everywhere; a decision made in the Plan does too; the project still says
 * what is open, so the board is never behind the plan; a request is only
 * its owner's to decide, and everyone else sees who it is waiting on;
 * reading the board changes nothing; assistant plan steps that wait on a
 * person are listed; and without the delegated assistant the board is the
 * plans' own list.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-project-board-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const gates = require('@goobster/core/services/assistantGateService');
const home = require('@goobster/core/services/assistantHomeService');
const inbox = require('@goobster/core/services/inboxService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const policies = require('@goobster/core/services/attentionPolicyService');
const missions = require('@goobster/core/services/projectMissionService');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const eventBusService = require('@goobster/core/services/eventBusService');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const { useState } = require('./helpers/featureFixtures');

const A = '780000000000000001';
const B = '780000000000000002';

const TABLES = [
    'assistant_run_operations', 'assistant_runs', 'assistant_initiatives', 'assistant_source_cursors',
    'assistant_update_receipts', 'assistant_updates', 'assistant_responsibility_revisions', 'assistant_responsibilities',
    'attention_policies', 'inbox_items', 'project_mission_approval_receipts', 'project_mission_events',
    'project_mission_evidence', 'project_mission_steps', 'project_missions', 'project_members', 'observatory_projects',
    'web_sessions', 'web_rate_events', 'usage_reservations', 'auth_identities', 'app_accounts', 'principals'
];

const requireAccount = identityConfig.requireAccount;

afterAll(async () => {
    initiatives.stopListening();
    useState();
    identityConfig.requireAccount = requireAccount;
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    initiatives.stopListening();
    identityConfig.requireAccount = false;
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`, {});
    for (const [id, name] of [[A, 'Ada'], [B, 'Bo']]) {
        await identityService.ensureLegacyPrincipal({ discordId: id, displayName: name });
    }
});

const caught = async (promise) => promise.then(() => null, error => error);
const needsYou = async (userId) => (await inbox.list({ userId, view: 'needs_you' })).items;
const counts = async () => ({
    updates: (await db.get('SELECT COUNT(*) AS n FROM assistant_updates', {})).n,
    receipts: (await db.get('SELECT COUNT(*) AS n FROM assistant_update_receipts', {})).n,
    inbox: (await db.get('SELECT COUNT(*) AS n FROM inbox_items', {})).n
});

/** A's project "lab" with B as a member and a drafted plan. */
async function drafted({ steps = [{ kind: 'human', title: 'Pick a framework' }] } = {}) {
    const pid = await db.insert("INSERT INTO observatory_projects (userId, slug, name) VALUES (@u, 'lab', 'Lab')", { u: A });
    await db.run("INSERT INTO project_members (projectId, userId, userName, invitedBy) VALUES (@pid, @u, 'Bo', @owner)", { pid, u: B, owner: A });
    const args = { userId: A, project: 'lab' };
    const mission = await missions.create({
        ...args, title: 'Ship the API', objective: 'Ship a first version of the API.', successCriteria: ['It serves requests'], steps
    });
    return { pid, args, mission };
}

async function approveAsHuman(args) {
    const receipt = await missions.mintApprovalReceipt({ ...args, origin: 'portal' });
    return missions.approve({ ...args, receiptId: receipt.id, nonce: receipt.nonce });
}

const board = (userId, extra = {}) => gates.projectBoard({ userId, setup: false, ...extra });
const cardOf = (result, id) => result.cards.find(card => card.id === id);

describe('one request on the board, on Home and in the Inbox', () => {
    test('the board card is the canonical gate: same reference, same decision, and reading it changes nothing', async () => {
        const { mission } = await drafted();
        // The plan says the gate is open before anything has adopted it.
        const early = await board(A, { project: 'lab' });
        expect(early.canonical).toBe(true);
        expect(cardOf(early, `approve:${mission.id}`)).toMatchObject({ column: 'approve', mine: true, waitingOn: null, gate: null, decision: null });
        expect(await counts()).toEqual({ updates: 0, receipts: 0, inbox: 0 });

        await gates.adoptProjectGates({ userId: A });
        const before = await counts();
        const [item] = await needsYou(A);
        const view = await home.project({ userId: A });
        const card = cardOf(await board(A, { project: 'lab' }), `approve:${mission.id}`);
        expect(card.gate).toMatchObject({ ref: item.decision.ref, inboxItemId: item.id, unseen: true, snoozedUntil: null });
        expect(card.decision).toEqual(item.decision);
        expect(view.needsYou[0].decision).toEqual(card.decision);
        expect(card.decision).toMatchObject({ kind: 'project_approve', state: 'open', options: [expect.objectContaining({ id: 'approve' })] });
        // The cross-project board shows the same card.
        expect(cardOf(await board(A), `approve:${mission.id}`).gate.ref).toBe(card.gate.ref);
        // A read: nothing adopted, filed or acknowledged.
        expect(await counts()).toEqual(before);
    });

    test('approving on the board is the same decision, and it is resolved everywhere', async () => {
        const { args, mission } = await drafted();
        await gates.adoptProjectGates({ userId: A });
        const mint = jest.spyOn(missions, 'mintApprovalReceipt');
        const card = cardOf(await board(A, { project: 'lab' }), `approve:${mission.id}`);
        const result = await gates.decide({
            userId: A, ref: card.gate.ref, option: 'approve', occurrence: card.decision.occurrence, revision: card.decision.revision, surface: 'project'
        });
        expect(result.decided).toMatchObject({ kind: 'project_approve', option: 'approve' });
        // A human receipt, minted on a human surface, bound to the revision shown.
        expect(mint).toHaveBeenCalledTimes(1);
        expect((await missions.get(args)).status).toBe('APPROVED');

        // The approval is gone from the board, Home and the Inbox; the next gate (start) took its place on all three.
        const after = await board(A, { project: 'lab' });
        expect(cardOf(after, `approve:${mission.id}`)).toBeUndefined();
        const start = cardOf(after, `start:${mission.id}`);
        const items = await needsYou(A);
        expect(items).toHaveLength(1);
        expect(start.gate.ref).toBe(items[0].decision.ref);
        expect(start.decision).toEqual(items[0].decision);
        expect((await home.project({ userId: A })).counts.needsAction).toBe(1);
        expect(await db.get("SELECT gateResolvedAt IS NOT NULL AS resolved FROM assistant_updates WHERE identityKey = @key", { key: `project_gate:approve:${mission.id}` }))
            .toMatchObject({ resolved: expect.anything() });

        // The card the person was looking at before is stale now: it decides nothing.
        expect(await caught(gates.decide({
            userId: A, ref: card.gate.ref, option: 'approve', occurrence: card.decision.occurrence, revision: card.decision.revision, surface: 'project'
        }))).toMatchObject({ status: 409, code: 'STALE_GATE' });
    });

    test('approving in the Plan resolves the same request: the board follows at once, Home and the Inbox at the next adoption', async () => {
        const { args, mission } = await drafted();
        await gates.adoptProjectGates({ userId: A });
        const stale = cardOf(await board(A, { project: 'lab' }), `approve:${mission.id}`);
        await approveAsHuman(args);
        // The project says what is open: the approval is already off the board.
        const now = await board(A, { project: 'lab' });
        expect(cardOf(now, `approve:${mission.id}`)).toBeUndefined();
        // The start gate has not been adopted yet: it is listed, without a decision to press here.
        expect(cardOf(now, `start:${mission.id}`)).toMatchObject({ mine: true, gate: null, decision: null });
        // And the old card cannot be pressed anywhere.
        expect(await caught(gates.decide({
            userId: A, ref: stale.gate.ref, option: 'approve', occurrence: stale.decision.occurrence, revision: stale.decision.revision, surface: 'home'
        }))).toMatchObject({ status: 409, code: 'STALE_GATE' });
        await gates.adoptProjectGates({ userId: A });
        const items = await needsYou(A);
        expect(items.map(item => item.decision?.options[0].id)).toEqual(['start']);
        expect(cardOf(await board(A, { project: 'lab' }), `start:${mission.id}`).gate.ref).toBe(items[0].decision.ref);
    });

    test('a snoozed request leaves Needs you and stays on its project board, marked', async () => {
        const { mission } = await drafted();
        await gates.adoptProjectGates({ userId: A });
        const card = cardOf(await board(A), `approve:${mission.id}`);
        const until = new Date(Date.now() + 3600_000).toISOString();
        await require('@goobster/core/services/assistantUpdateService').snooze({ userId: A, id: Number(card.gate.ref), until });
        expect(await needsYou(A)).toEqual([]);
        expect(cardOf(await board(A), `approve:${mission.id}`).gate.snoozedUntil).toBeTruthy();
    });
});

describe('whose request it is', () => {
    test('a member sees the owner\'s request as waiting on the owner, with nothing to press, and cannot decide it', async () => {
        const { mission } = await drafted();
        await gates.adoptProjectGates({});
        const mine = cardOf(await board(A, { project: 'lab' }), `approve:${mission.id}`);
        const theirs = cardOf(await board(B, { project: 'lab', owner: A }), `approve:${mission.id}`);
        expect(theirs).toMatchObject({ column: 'approve', mine: false, waitingOn: 'owner', gate: null, decision: null });
        expect((await board(B, { project: 'lab', owner: A })).text).toContain('waiting on the project owner');
        // Nothing was filed for the member, and the owner's reference does not exist for them.
        expect(await needsYou(B)).toEqual([]);
        expect(await gates.card({ userId: B, ref: mine.gate.ref })).toBeNull();
        expect(await caught(gates.decide({
            userId: B, ref: mine.gate.ref, option: 'approve', occurrence: mine.decision.occurrence, revision: mine.decision.revision, surface: 'project'
        }))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
        expect((await missions.get({ userId: A, project: 'lab' })).status).toBe('DRAFT');
    });

    test('a project the person cannot reach has no board', async () => {
        await drafted();
        await db.run('DELETE FROM project_members', {});
        expect(await caught(board(B, { project: 'lab', owner: A }))).toMatchObject({ status: 404 });
        expect((await board(B)).cards).toEqual([]);
    });
});

describe('assistant plan steps that wait on a person', () => {
    const agentPlan = async () => {
        const made = await drafted({ steps: [{ kind: 'agent', title: 'Write the comparison report' }] });
        await approveAsHuman(made.args);
        const mission = await missions.start(made.args);
        return { ...made, mission, stepId: mission.steps[0].id };
    };
    async function delegate(userId, pid) {
        await policies.enroll({ userId, initiative: 'assist' });
        const { responsibility } = await responsibilities.create({
            userId,
            body: {
                title: 'Carry the plan forward', projectId: pid,
                operations: [
                    { operation: 'read', resource: { kind: 'project', ids: [String(pid)] } },
                    { operation: 'plan.step.execute', resource: { kind: 'project', ids: [String(pid)] } }
                ]
            }
        });
        return (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
    }

    test('a ready step nobody carries out is the owner\'s to delegate or do; a proposed one is its proposer\'s to start', async () => {
        const { pid, mission, stepId } = await agentPlan();
        const id = `agent:${mission.id}:${stepId}`;
        // Nobody delegated: the owner is told, a member is not nagged.
        expect(cardOf(await board(A, { project: 'lab' }), id)).toMatchObject({
            column: 'assistant', state: 'undelegated', mine: true, title: 'Write the comparison report', initiativeId: null, gate: null, decision: null
        });
        expect(cardOf(await board(B, { project: 'lab', owner: A }), id)).toBeUndefined();

        // B delegates plan steps here: the step is proposed to B and waits for B to start it.
        await delegate(B, pid);
        const [proposed] = await db.all('SELECT id, revision FROM assistant_initiatives', {});
        expect(cardOf(await board(B, { project: 'lab', owner: A }), id)).toMatchObject({ state: 'proposed', initiativeId: proposed.id, mine: true });
        // B's work is private to B: the owner still sees a step none of their own responsibilities carries out.
        expect(cardOf(await board(A, { project: 'lab' }), id)).toMatchObject({ state: 'undelegated' });

        // Started: it is in progress, not waiting on anyone.
        await initiatives.act({ userId: B, id: proposed.id, action: 'queue', expectedRevision: proposed.revision });
        expect(cardOf(await board(B, { project: 'lab', owner: A }), id)).toBeUndefined();

        // Parked on its responsibility: that waits on B again.
        await db.run("UPDATE assistant_initiatives SET status = 'WAITING', waitReason = 'responsibility', stopCode = 'REPLAN_REQUIRED' WHERE id = @id", { id: proposed.id });
        expect(cardOf(await board(B, { project: 'lab', owner: A }), id)).toMatchObject({ state: 'waiting', initiativeId: proposed.id });
    });

    test('a step is not listed before a person approved and started its plan, or once it is done', async () => {
        const made = await drafted({ steps: [{ kind: 'agent', title: 'Write the comparison report' }] });
        expect((await board(A, { project: 'lab' })).cards.filter(card => card.column === 'assistant')).toEqual([]);
        await approveAsHuman(made.args);
        expect((await board(A, { project: 'lab' })).cards.filter(card => card.column === 'assistant')).toEqual([]);
        const mission = await missions.start(made.args);
        expect((await board(A, { project: 'lab' })).cards.filter(card => card.column === 'assistant')).toHaveLength(1);
        await missions.completeStep({ ...made.args, stepId: mission.steps[0].id });
        expect((await board(A, { project: 'lab' })).cards.filter(card => card.column === 'assistant')).toEqual([]);
    });
});

describe('the routes', () => {
    let server;
    let port;

    function request({ method = 'GET', reqPath, cookie = null, body = null }) {
        const payload = body ? JSON.stringify(body) : null;
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, method, path: reqPath,
                headers: {
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                    ...(cookie ? { cookie } : {})
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(data); } catch { /* non-JSON */ }
                    resolve({ status: res.statusCode, headers: res.headers, json });
                });
            });
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    async function session(userId, name) {
        const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
        const cookie = (res.headers['set-cookie'] || []).find(entry => entry.startsWith('goobster_web_session='));
        return cookie.split(';')[0];
    }

    beforeAll((done) => {
        const ctx = createWebAppContext({
            client: { user: { id: '9', username: 'Goobster' }, guilds: { cache: new Map() } },
            config: { clientId: '123', webapp: { enabled: true, devMode: true } },
            logger: { error: () => {}, warn: () => {}, info: () => {} }
        });
        ctx.gateway.sendDm = async () => ({ ok: true });
        const app = express();
        app.use(createWebAppApp(ctx));
        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            done();
        });
    });

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    test('the board route returns the canonical board, its decision posts with surface "project", and the Now panel reads the same thing', async () => {
        const { mission } = await drafted();
        await gates.adoptProjectGates({ userId: A });
        const ada = await session(A, 'Ada');
        const bo = await session(B, 'Bo');
        const id = `approve:${mission.id}`;

        const listed = await request({ reqPath: '/api/app/projects/needs-you?project=lab', cookie: ada });
        expect(listed.status).toBe(200);
        expect(listed.json.canonical).toBe(true);
        const card = listed.json.cards.find(entry => entry.id === id);
        expect(card).toMatchObject({ mine: true, gate: { ref: expect.any(String) }, decision: { kind: 'project_approve', state: 'open' } });
        // Home carries the same card.
        const homeView = await request({ reqPath: '/api/app/home', cookie: ada });
        expect(homeView.json.assistant.needsYou[0].decision).toEqual(card.decision);

        const theirs = await request({ reqPath: `/api/app/projects/needs-you?project=lab&owner=${A}`, cookie: bo });
        expect(theirs.json.cards.find(entry => entry.id === id)).toMatchObject({ mine: false, waitingOn: 'owner', gate: null, decision: null });
        const now = await request({ reqPath: `/api/app/projects/lab/now?owner=${A}`, cookie: bo });
        expect(now.json.needsYou.cards[0]).toMatchObject({ id, waitingOn: 'owner' });
        expect((await request({ reqPath: '/api/app/projects/lab/now', cookie: ada })).json.needsYou.cards[0]).toMatchObject({ id, waitingOn: null });

        const body = { option: 'approve', occurrence: card.decision.occurrence, revision: card.decision.revision, surface: 'project' };
        const url = `/api/app/assistant/gates/${card.gate.ref}/decide`;
        expect((await request({ method: 'POST', reqPath: url, cookie: bo, body })).status).toBe(404);
        expect((await missions.get({ userId: A, project: 'lab' })).status).toBe('DRAFT');
        const decided = await request({ method: 'POST', reqPath: url, cookie: ada, body });
        expect(decided.status).toBe(200);
        expect(decided.json.decided).toMatchObject({ kind: 'project_approve', option: 'approve' });
        expect((await missions.get({ userId: A, project: 'lab' })).status).toBe('APPROVED');
        const after = await request({ reqPath: '/api/app/projects/needs-you?project=lab', cookie: ada });
        expect(after.json.cards.find(entry => entry.id === id)).toBeUndefined();
    });

    test('with the delegated assistant off the route serves the plans\' own list', async () => {
        const { mission } = await drafted();
        const ada = await session(A, 'Ada');
        useState({ inactive: ['assistant'] });
        const listed = await request({ reqPath: '/api/app/projects/needs-you?project=lab', cookie: ada });
        expect(listed.status).toBe(200);
        expect(listed.json.cards.map(entry => entry.id)).toEqual([`approve:${mission.id}`]);
        expect(listed.json.cards[0].decision).toBeUndefined();
    });
});

describe('without the delegated assistant', () => {
    test('the board is the plans\' own list', async () => {
        const { mission } = await drafted();
        useState({ inactive: ['assistant'] });
        const plain = await board(A, { project: 'lab' });
        expect(plain.canonical).toBe(false);
        expect(plain.cards.map(card => card.id)).toEqual([`approve:${mission.id}`]);
        expect(plain.cards[0].gate).toBeUndefined();
    });
});
