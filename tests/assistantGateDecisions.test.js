/**
 * Deciding a request where it is shown (DA-7a; documentation/assistant_home.md).
 *
 * The properties under test: Home and the Inbox carry the same decision card
 * and both reach the owning domain service through one dispatcher; a card
 * that is settled, reopened or changed is refused with the current card and
 * nothing is decided; only the person a request is addressed to (or an
 * active operator, for a request to join) can decide it; a mission plan is
 * approved through a human receipt bound to the revision shown; a request
 * with no descriptor stays decided where it lives; and the gate service
 * never writes an outcome itself.
 *
 * Deciding in place is behind the pilot gate (owner decision 9): until the
 * host records the pilot decision only the owner is offered a card or can
 * decide through one, on Home and in the Inbox alike, and everyone else
 * keeps the request where it lives. Most of this file runs with the pilot
 * open to everyone, because it is about what a card does; "until the pilot
 * decision is recorded" runs with it unset.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-gate-decisions-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const gates = require('@goobster/core/services/assistantGateService');
const { AssistantGateService } = require('@goobster/core/services/assistantGateService');
const confirmations = require('@goobster/core/services/assistantConfirmationService');
const access = require('@goobster/core/services/assistantAccessService');
const instanceState = require('@goobster/core/services/instanceStateService');
const home = require('@goobster/core/services/assistantHomeService');
const updates = require('@goobster/core/services/assistantUpdateService');
const inbox = require('@goobster/core/services/inboxService');
const friends = require('@goobster/core/services/friendService');
const accessRequests = require('@goobster/core/services/accessRequestService');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const usageBudgetService = require('@goobster/core/services/usageBudgetService');
const missions = require('@goobster/core/services/projectMissionService');
const eventBusService = require('@goobster/core/services/eventBusService');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const { useState } = require('./helpers/featureFixtures');

const A = '750000000000000001';
const B = '750000000000000002';
const C = '750000000000000003';

const TABLES = [
    'assistant_confirmation_receipts', 'assistant_update_receipts', 'assistant_updates', 'inbox_items', 'friendships', 'access_requests', 'operator_audit',
    'project_mission_approval_receipts', 'project_mission_events', 'project_mission_steps', 'project_missions',
    'observatory_projects', 'web_sessions', 'web_rate_events', 'usage_reservations', 'auth_identities', 'app_accounts',
    'principals'
];

const requireAccount = identityConfig.requireAccount;

afterAll(async () => {
    useState();
    identityConfig.requireAccount = requireAccount;
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    identityConfig.requireAccount = false;
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`, {});
    for (const [id, name] of [[A, 'Ada'], [B, 'Bo'], [C, 'Cy']]) {
        await identityService.ensureLegacyPrincipal({ discordId: id, displayName: name });
    }
    // The pilot is open: these people are not the owner, and the cards are for everyone.
    await instanceState.remove(access.KEY_PILOT);
    await access.recordDecision({ scope: 'everyone' });
});

const needsYou = async (userId) => (await inbox.list({ userId, view: 'needs_you' })).items;
const caught = async (promise) => promise.then(() => null, error => error);

/** B asks A to be friends; returns A's Inbox item with its decision card. */
async function friendRequest(from = B, to = A) {
    const { request } = await friends.request({ userId: from, targetId: to });
    const [item] = await needsYou(to);
    return { request, item, card: item.decision };
}

const decideCard = (card, option, extra = {}) => gates.decide({
    userId: A, ref: card.ref, option, occurrence: card.occurrence, revision: card.revision, surface: 'inbox', ...extra
});

describe('one card on Home and in the Inbox', () => {
    test('a friend request carries the same decision on both, and nothing is decided by reading it', async () => {
        const { request, item, card } = await friendRequest();
        expect(card).toEqual({
            ref: `inbox-${item.id}`,
            kind: 'friend_request',
            state: 'open',
            title: 'Bo wants to be friends',
            detail: expect.stringContaining('Declining is not announced'),
            outcome: null,
            occurrence: 1,
            revision: request.createdAt,
            options: [
                { id: 'accept', label: 'Accept', effect: 'You and Bo become friends.', danger: false },
                { id: 'decline', label: 'Decline', effect: 'The request closes. They are not told.', danger: false }
            ]
        });
        const view = await home.project({ userId: A });
        expect(view.needsYou).toHaveLength(1);
        expect(view.needsYou[0]).toMatchObject({ inboxItemId: item.id, request: 'friend_request' });
        expect(view.needsYou[0].decision).toEqual(card);
        expect(await gates.card({ userId: A, ref: card.ref })).toEqual(card);
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('pending');
    });

    test.each(['home', 'inbox', 'chat'])('a decision from %s reaches the same domain operation', async (surface) => {
        const respond = jest.spyOn(friends, 'respond');
        const { request, card } = await friendRequest();
        const extra = { surface, userName: 'Ada' };
        if (surface === 'chat') {
            // In chat the person's press is proved by a receipt for the card as shown (ADR 0023).
            await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
            extra.receipt = (await confirmations.mint({
                userId: A, subject: 'gate', id: card.ref, action: 'decide', occurrence: card.occurrence, revision: card.revision, surface: 'chat'
            })).receipt;
        }
        const result = await decideCard(card, 'accept', extra);
        expect(respond).toHaveBeenCalledTimes(1);
        expect(respond).toHaveBeenCalledWith(expect.objectContaining({ userId: A, requestId: String(request.id), accept: true }));
        expect(result.decided).toEqual({ ref: card.ref, kind: 'friend_request', option: 'accept', message: 'You and Bo are friends now.' });
        expect(result.current).toMatchObject({ state: 'resolved', outcome: 'You accepted this request.', options: [] });
        // Resolved everywhere at once: it is one request.
        expect(await needsYou(A)).toEqual([]);
        const view = await home.project({ userId: A });
        expect(view.counts.needsAction).toBe(0);
        expect(view.needsYou).toEqual([]);
        // The item stays in history without a decision to take.
        const [kept] = (await inbox.list({ userId: A })).items.filter(entry => entry.source?.type === 'friend_request');
        expect(kept).toMatchObject({ needsAction: false, decision: null, friend: { status: 'accepted' } });
    });

    test('declining is the same route with the other option', async () => {
        const { request, card } = await friendRequest();
        const result = await decideCard(card, 'decline');
        expect(result.decided.message).toBe('Declined - they are not told.');
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('declined');
        // Declining is silent towards the requester.
        expect((await inbox.list({ userId: B })).items).toEqual([]);
    });
});

describe('a stale card', () => {
    test('a request that was already answered is refused with its outcome, and is not answered twice', async () => {
        const { request, card } = await friendRequest();
        await friends.respond({ userId: A, requestId: request.id, accept: false });
        const respond = jest.spyOn(friends, 'respond');
        const error = await caught(decideCard(card, 'accept'));
        expect(error).toMatchObject({ status: 409, code: 'STALE_GATE' });
        expect(error.message).toContain('You declined this request.');
        expect(error.details.current).toMatchObject({ ref: card.ref, state: 'resolved', outcome: 'You declined this request.', options: [] });
        expect(respond).not.toHaveBeenCalled();
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('declined');
    });

    test('a request that was withdrawn and asked again is a different request: the old card decides nothing', async () => {
        const { request, card } = await friendRequest();
        await friends.cancel({ userId: B, requestId: request.id });
        await db.run("UPDATE friendships SET status = 'pending', createdAt = '2031-01-01 00:00:00' WHERE id = @id", { id: request.id });
        const error = await caught(decideCard(card, 'accept'));
        expect(error).toMatchObject({ status: 409, code: 'STALE_GATE' });
        expect(error.details.current).toMatchObject({ state: 'open', revision: '2031-01-01 00:00:00' });
        expect(error.details.current.options.map(option => option.id)).toEqual(['accept', 'decline']);
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('pending');
        // The current card, as returned, does decide it.
        await decideCard(error.details.current, 'accept');
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('accepted');
    });

    test('when they ask again, only the new notice is the request: the earlier one asks for nothing', async () => {
        const { request, item: earlier, card: earlierCard } = await friendRequest();
        // The first ask was a minute ago (the notice is keyed on when it was asked).
        await db.run("UPDATE friendships SET createdAt = '2026-01-01 00:00:00' WHERE id = @id", { id: request.id });
        await db.run('UPDATE inbox_items SET dedupeKey = @key WHERE id = @id',
            { id: earlier.id, key: `friend_request:${request.id}:2026-01-01 00:00:00` });
        await friends.cancel({ userId: B, requestId: request.id });
        expect(await needsYou(A)).toEqual([]);

        const again = await friends.request({ userId: B, targetId: A });
        expect(again.request.id).toBe(request.id);
        const waiting = await needsYou(A);
        expect(waiting).toHaveLength(1);
        expect(waiting[0].id).not.toBe(earlier.id);
        expect(waiting[0]).toMatchObject({ needsAction: true, friend: { actionable: true }, decision: { state: 'open' } });
        const view = await home.project({ userId: A });
        expect(view.needsYou).toHaveLength(1);
        expect(view.counts.needsAction).toBe(1);

        // The earlier notice stays in the Inbox as a record, with nothing to press.
        const all = (await inbox.list({ userId: A })).items;
        expect(all.find(entry => entry.id === earlier.id)).toMatchObject({ needsAction: false, decision: null, friend: { actionable: false } });
        expect(await gates.card({ userId: A, ref: earlierCard.ref })).toMatchObject({
            state: 'resolved', options: [], outcome: 'This is an earlier notice. They asked again since: answer the newer request.'
        });
        const refused = await caught(decideCard({ ...earlierCard, revision: waiting[0].decision.revision }, 'accept'));
        expect(refused).toMatchObject({ status: 409, code: 'STALE_GATE' });
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('pending');

        // The new notice decides it, once.
        await decideCard(waiting[0].decision, 'accept');
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('accepted');
        expect(await needsYou(A)).toEqual([]);
    });

    test('an old "accepted your request" note does not become a request when the roles are reversed', async () => {
        // A asked B, B accepted (A holds the acceptance note), they parted, and now B asks A.
        const first = await friends.request({ userId: A, targetId: B });
        await friends.respond({ userId: B, requestId: first.request.id, accept: true });
        await friends.remove({ userId: A, friendId: B });
        await db.run("UPDATE friendships SET createdAt = '2026-01-01 00:00:00' WHERE id = @id", { id: first.request.id });
        await friends.request({ userId: B, targetId: A });
        const waiting = await needsYou(A);
        expect(waiting).toHaveLength(1);
        expect(waiting[0]).toMatchObject({ kind: 'invite', title: 'Bo wants to be friends' });
        const note = (await inbox.list({ userId: A })).items.find(entry => /accepted your friend request/.test(entry.title));
        expect(note).toMatchObject({ needsAction: false, decision: null });
    });

    test('a domain refusal that means "changed under you" is reported the same way', async () => {
        const { card } = await friendRequest();
        jest.spyOn(friends, 'respond').mockRejectedValue(Object.assign(new Error('already answered'), { status: 409, code: 'REQUEST_SETTLED' }));
        const error = await caught(decideCard(card, 'accept'));
        expect(error).toMatchObject({ status: 409, code: 'STALE_GATE' });
        expect(error.details.current).toMatchObject({ ref: card.ref });
    });

    test('any other domain refusal passes through unchanged and decides nothing', async () => {
        const { request, card } = await friendRequest();
        jest.spyOn(friends, 'respond').mockRejectedValue(Object.assign(new Error('You can have at most 1000 friends.'), { status: 400, code: 'TOO_MANY_FRIENDS' }));
        expect(await caught(decideCard(card, 'accept'))).toMatchObject({ status: 400, code: 'TOO_MANY_FRIENDS' });
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('pending');
    });
});

describe('who may decide', () => {
    test('only the person a request is addressed to; another person\'s reference does not exist', async () => {
        const { request, card } = await friendRequest();
        const args = { ref: card.ref, option: 'accept', occurrence: card.occurrence, revision: card.revision, surface: 'inbox' };
        expect(await caught(gates.decide({ userId: C, ...args }))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
        expect(await gates.card({ userId: C, ref: card.ref })).toBeNull();
        // The requester's own copy of the same request offers nothing.
        await inbox.deliver({ userId: B, kind: 'invite', title: 'You asked Ada', source: { type: 'friend_request', id: String(request.id) }, discord: false });
        const [mine] = (await inbox.list({ userId: B })).items;
        expect(mine.decision).toBeNull();
        expect(await caught(gates.decide({ userId: B, ...args, ref: `inbox-${mine.id}` }))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('pending');
    });

    test('a decision names its card and comes from a surface a person uses', async () => {
        const { request, card } = await friendRequest();
        const base = { userId: A, ref: card.ref, option: 'accept', occurrence: card.occurrence, revision: card.revision, surface: 'inbox' };
        for (const broken of [{ surface: 'tool' }, { surface: undefined }, { option: '' }, { occurrence: undefined }, { revision: '' }]) {
            expect(await caught(gates.decide({ ...base, ...broken }))).toMatchObject({ status: 400, code: 'INVALID_DECISION' });
        }
        expect(await caught(gates.decide({ ...base, option: 'befriend' }))).toMatchObject({ status: 400, code: 'INVALID_DECISION' });
        for (const ref of ['nope', 'inbox-999999', '999999', '']) {
            expect(await caught(gates.decide({ ...base, ref }))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
        }
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('pending');
    });

    test('no chat tool or run tool reaches decide(): a model call is never a confirmation', () => {
        const core = path.join(__dirname, '..', 'packages', 'core');
        const sources = [path.join(core, 'utils', 'toolsRegistry.js')];
        // Chat tools, and the tools a delegated run may call.
        for (const toolsDir of [path.join(core, 'utils', 'tools'), path.join(core, 'services', 'assistant', 'runTools')]) {
            expect(fs.existsSync(toolsDir)).toBe(true);
            for (const name of fs.readdirSync(toolsDir)) if (name.endsWith('.js')) sources.push(path.join(toolsDir, name));
        }
        const offenders = sources.filter((file) => {
            const text = fs.readFileSync(file, 'utf8');
            return text.includes('assistantGateService') && /\.decide\s*\(/.test(text);
        });
        expect(offenders).toEqual([]);
    });
});

describe('until the pilot decision is recorded', () => {
    const status = async (request) => (await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status;
    const makeOwner = (userId) => identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role: 'operator' });

    beforeEach(async () => {
        await instanceState.remove(access.KEY_PILOT);
    });

    test.each(['home', 'inbox'])('someone who is not the owner is offered no card and cannot decide from %s; the request stays where it lives', async (surface) => {
        const respond = jest.spyOn(friends, 'respond');
        const { request } = await friends.request({ userId: B, targetId: A });
        // Still a request waiting on them, on both surfaces, with the Inbox's own buttons.
        const [item] = await needsYou(A);
        expect(item).toMatchObject({ needsAction: true, decision: null, friend: { actionable: true, status: 'pending' } });
        const view = await home.project({ userId: A });
        expect(view.counts.needsAction).toBe(1);
        expect(view.needsYou[0]).toMatchObject({ inboxItemId: item.id, request: 'friend_request', decision: null });
        expect(await gates.card({ userId: A, ref: `inbox-${item.id}` })).toBeNull();

        // Naming the card they were never shown decides nothing.
        const refused = await caught(gates.decide({
            userId: A, ref: `inbox-${item.id}`, option: 'accept', occurrence: 1, revision: request.createdAt, surface
        }));
        expect(refused).toMatchObject({ status: 403, code: 'PILOT_ONLY', details: { capability: 'conversation' } });
        expect(respond).not.toHaveBeenCalled();
        expect(await status(request)).toBe('pending');

        // The Inbox's own operation is not the assistant's and still answers it.
        await friends.respond({ userId: A, requestId: request.id, accept: true });
        expect(await status(request)).toBe('accepted');
        expect(await needsYou(A)).toEqual([]);
    });

    test.each(['home', 'inbox'])('the owner is offered the card on both and decides from %s', async (surface) => {
        await makeOwner(A);
        const respond = jest.spyOn(friends, 'respond');
        const { request, item, card } = await friendRequest();
        expect(card).toMatchObject({ ref: `inbox-${item.id}`, kind: 'friend_request', state: 'open' });
        expect((await home.project({ userId: A })).needsYou[0].decision).toEqual(card);
        expect(await gates.card({ userId: A, ref: card.ref })).toEqual(card);

        const result = await decideCard(card, 'accept', { surface });
        expect(result.decided).toMatchObject({ kind: 'friend_request', option: 'accept' });
        expect(respond).toHaveBeenCalledTimes(1);
        expect(await status(request)).toBe('accepted');
    });

    test('the refusal is the same for any reference, so it says nothing about another person\'s requests', async () => {
        await makeOwner(A);
        const { card } = await friendRequest();
        const asC = (ref) => caught(gates.decide({ userId: C, ref, option: 'accept', occurrence: card.occurrence, revision: card.revision, surface: 'inbox' }));
        expect(await asC(card.ref)).toMatchObject({ status: 403, code: 'PILOT_ONLY' });
        expect(await asC('inbox-999999')).toMatchObject({ status: 403, code: 'PILOT_ONLY' });
        expect(await gates.card({ userId: C, ref: card.ref })).toBeNull();
    });

    test('a plan to approve is still a request for someone who is not the owner, decided in the project', async () => {
        await db.run("INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, 'garden', 'Garden')", { userId: A });
        const mission = await missions.create({
            userId: A, project: 'garden', owner: A, title: 'Plant the beds', objective: 'Get the beds planted before the first frost.',
            successCriteria: ['Every bed is planted'], steps: [{ kind: 'human', title: 'Buy seedlings' }]
        });
        await gates.adoptProjectGates({ userId: A });
        const [item] = await needsYou(A);
        expect(item).toMatchObject({ needsAction: true, decision: null, update: { gate: { kind: 'project_approve' }, gateOpen: true } });
        // Home and the Inbox keep the link to the project, where the plan is approved.
        expect(item.update.actions).toEqual([{ kind: 'open_project', id: `${A}/garden` }]);
        const [shown] = (await home.project({ userId: A })).needsYou;
        expect(shown).toMatchObject({ decision: null });

        const approve = jest.spyOn(missions, 'approve');
        expect(await caught(gates.decide({
            userId: A, ref: item.update.id, option: 'approve', occurrence: 1, revision: `plan:${mission.planRevision}`, surface: 'home'
        }))).toMatchObject({ status: 403, code: 'PILOT_ONLY' });
        expect(approve).not.toHaveBeenCalled();
        expect((await missions.get({ userId: A, project: 'garden', owner: A, missionId: mission.id })).status).toBe('DRAFT');
        expect(await db.all('SELECT id FROM project_mission_approval_receipts', {})).toEqual([]);
    });

    test('once the host opens the pilot the same request carries its card, and closing it takes the card away again', async () => {
        const { request } = await friends.request({ userId: B, targetId: A });
        expect((await needsYou(A))[0].decision).toBeNull();
        await access.recordDecision({ scope: 'everyone' });
        const [open] = await needsYou(A);
        expect(open.decision).toMatchObject({ kind: 'friend_request', state: 'open' });
        await access.recordDecision({ scope: 'owner' });
        expect((await needsYou(A))[0].decision).toBeNull();
        // A card shown while the pilot was open decides nothing once it is closed.
        expect(await caught(decideCard(open.decision, 'accept'))).toMatchObject({ status: 403, code: 'PILOT_ONLY' });
        expect(await status(request)).toBe('pending');
    });
});

describe('a request to join', () => {
    /** A is the host; C signed in without an account and asked to be let in. */
    async function asked() {
        identityConfig.requireAccount = true;
        await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
        await usageBudgetService.setPolicy({ dailyTokens: 10000 });
        const { request } = await accessRequests.request({ principalId: C });
        const [item] = await needsYou(A);
        return { request, item, card: item.decision };
    }

    test('the host approves it from the card: the account is granted, audited with the surface, and the person is told', async () => {
        const { request, item, card } = await asked();
        expect(card).toMatchObject({
            ref: `inbox-${item.id}`, kind: 'access_request', state: 'open', title: 'Cy is asking to join', occurrence: 1
        });
        expect(card.options.map(option => option.id)).toEqual(['approve', 'decline']);
        const result = await decideCard(card, 'approve', { surface: 'home' });
        expect(result.decided.message).toBe('Cy now has an account.');
        expect(result.current).toMatchObject({ state: 'resolved', outcome: 'Approved by Ada.' });
        expect(await identityService.getAccount(C)).toMatchObject({ role: 'member', status: 'active' });
        const audit = await db.all("SELECT action, actor, target, detailJson FROM operator_audit WHERE action LIKE 'access.%'", {});
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ action: 'access.approve', actor: A, target: C });
        expect(JSON.parse(audit[0].detailJson)).toMatchObject({ requestId: request.id, via: 'home' });
        expect((await inbox.list({ userId: C })).items.map(entry => entry.title)).toEqual([expect.stringContaining('You\'re in')]);
        expect(await needsYou(A)).toEqual([]);
    });

    test('a second host\'s card for a request the first already answered is refused with who answered', async () => {
        await identityService.grantAccount({ principalId: B, entitlement: 'bootstrap', role: 'operator' });
        const { card } = await asked();
        const [theirs] = await needsYou(B);
        await decideCard(card, 'decline');
        const error = await caught(gates.decide({
            userId: B, ref: theirs.decision.ref, option: 'approve', occurrence: theirs.decision.occurrence,
            revision: theirs.decision.revision, surface: 'inbox'
        }));
        expect(error).toMatchObject({ status: 409, code: 'STALE_GATE' });
        expect(error.details.current).toMatchObject({ state: 'resolved', outcome: 'Declined by Ada.' });
        expect(await identityService.getAccount(C)).toBeNull();
        expect(await db.all("SELECT id FROM operator_audit WHERE action LIKE 'access.%'", {})).toHaveLength(1);
    });

    test('someone who is no longer a host gets no card and cannot decide', async () => {
        const { card } = await asked();
        await db.run("UPDATE app_accounts SET role = 'member' WHERE principalId = @id", { id: A });
        const [item] = (await inbox.list({ userId: A })).items;
        expect(item.decision).toBeNull();
        expect(await caught(decideCard(card, 'approve'))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
        expect(await identityService.getAccount(C)).toBeNull();
    });

    test('a grant the cap gate refuses decides nothing and leaves the request open', async () => {
        const { request, card } = await asked();
        jest.spyOn(identityService, 'grantAccount').mockRejectedValue(
            Object.assign(new Error('Set a daily token cap in Host → Limits before opening a second account.'), { status: 409, code: 'DAILY_CAP_REQUIRED' })
        );
        const error = await caught(decideCard(card, 'approve'));
        expect(error).toMatchObject({ status: 409, code: 'DAILY_CAP_REQUIRED' });
        expect(error.message).toContain('the request stays open');
        expect((await accessRequests.get(request.id)).status).toBe('pending');
        expect((await needsYou(A))[0].decision).toMatchObject({ state: 'open' });
    });
});

describe('a mission plan', () => {
    const PROJECT = { userId: A, project: 'garden', owner: A };

    async function drafted() {
        await db.run("INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, 'garden', 'Garden')", { userId: A });
        const mission = await missions.create({
            ...PROJECT, title: 'Plant the beds', objective: 'Get the beds planted before the first frost.',
            successCriteria: ['Every bed is planted'], steps: [{ kind: 'human', title: 'Buy seedlings' }]
        });
        await gates.adoptProjectGates({ userId: A });
        const [item] = await needsYou(A);
        return { mission, item, card: item.decision };
    }

    test('is approved from the card through a human receipt bound to the revision shown, then started', async () => {
        const approve = jest.spyOn(missions, 'approve');
        const { mission, card } = await drafted();
        expect(card).toMatchObject({
            kind: 'project_approve', state: 'open', occurrence: 1, revision: `plan:${mission.planRevision}`,
            title: 'Garden: approve the plan for "Plant the beds"'
        });
        expect(card.detail).toContain(`revision ${mission.planRevision}`);
        expect(card.options).toEqual([expect.objectContaining({ id: 'approve', label: 'Approve plan' })]);
        expect((await home.project({ userId: A })).needsYou[0].decision).toEqual(card);

        const result = await decideCard(card, 'approve', { surface: 'home' });
        expect(result.decided).toMatchObject({ kind: 'project_approve', option: 'approve' });
        expect(approve).toHaveBeenCalledTimes(1);
        const approved = await missions.get({ ...PROJECT, missionId: mission.id });
        expect(approved).toMatchObject({ status: 'APPROVED', approvedBy: A, approvedRevision: mission.planRevision });
        // The receipt the domain requires was minted on a human surface and used once.
        const receipts = await db.all('SELECT origin, kind, planRevision, consumedAt FROM project_mission_approval_receipts', {});
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ origin: 'portal', kind: 'approve', planRevision: mission.planRevision });
        expect(receipts[0].consumedAt).toBeTruthy();
        // The adopted gate followed the project: this one closed, the next one opened.
        expect(result.current).toMatchObject({ state: 'resolved', outcome: 'The plan is approved and waiting to be started.' });
        const next = await needsYou(A);
        expect(next).toHaveLength(1);
        expect(next[0].decision).toMatchObject({ kind: 'project_approve', title: 'Garden: start "Plant the beds"' });
        expect(next[0].decision.options).toEqual([expect.objectContaining({ id: 'start', label: 'Start mission' })]);
        // The settled card cannot approve again.
        expect(await caught(decideCard(card, 'approve'))).toMatchObject({ status: 409, code: 'STALE_GATE' });

        const started = await decideCard(next[0].decision, 'start');
        expect(started.decided.message).toBe('Started "Plant the beds".');
        expect((await missions.get({ ...PROJECT, missionId: mission.id })).status).toBe('ACTIVE');
        // What is left is a question in the project, which has no card here.
        const after = await needsYou(A);
        expect(after.map(entry => entry.update.gate.kind)).toEqual(['project_answer']);
        expect(after[0].decision).toBeNull();
    });

    test('a plan that changed after the card was shown is not approved', async () => {
        const { mission, card } = await drafted();
        await missions.addStep({ ...PROJECT, kind: 'human', title: 'Rent a tiller' });
        const error = await caught(decideCard(card, 'approve'));
        expect(error).toMatchObject({ status: 409, code: 'STALE_GATE' });
        expect(error.details.current).toMatchObject({ state: 'open', revision: `plan:${mission.planRevision + 1}` });
        expect(error.details.current.detail).toContain('2 steps');
        expect((await missions.get({ ...PROJECT, missionId: mission.id })).status).toBe('DRAFT');
        expect(await db.all('SELECT id FROM project_mission_approval_receipts', {})).toEqual([]);
    });

    test('a gate that closed and opened again is a new occurrence: the earlier card is refused', async () => {
        const { mission, item, card } = await drafted();
        await updates.resolveGate({ audience: { userId: A }, identityKey: `project_gate:approve:${mission.id}` });
        await gates.adoptProjectGates({ userId: A });
        const [again] = await needsYou(A);
        expect(again.id).toBe(item.id);
        expect(again.decision).toMatchObject({ occurrence: 2, revision: card.revision });
        const error = await caught(decideCard(card, 'approve'));
        expect(error).toMatchObject({ status: 409, code: 'STALE_GATE' });
        expect(error.details.current).toMatchObject({ state: 'open', occurrence: 2 });
        expect((await missions.get({ ...PROJECT, missionId: mission.id })).status).toBe('DRAFT');
    });

    test('someone who cannot see the project has no card for its gate', async () => {
        const { card } = await drafted();
        expect(await gates.card({ userId: B, ref: card.ref })).toBeNull();
        expect(await caught(gates.decide({
            userId: B, ref: card.ref, option: 'approve', occurrence: card.occurrence, revision: card.revision, surface: 'home'
        }))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    });
});

describe('the registry', () => {
    test('lists the kinds that can be decided in place and refuses a second descriptor for one', () => {
        expect(gates.decisionKinds().sort()).toEqual(['access_request', 'friend_request', 'process_retirement', 'project_approve']);
        const fresh = new AssistantGateService();
        const descriptor = { describe: async () => null, decide: async () => ({}) };
        fresh.registerDecision('process_repair', descriptor);
        expect(() => fresh.registerDecision('process_repair', descriptor)).toThrow(/already has/);
        expect(() => fresh.registerDecision('Bad Kind', descriptor)).toThrow(TypeError);
        expect(() => fresh.registerDecision('other_kind', { describe: async () => null })).toThrow(TypeError);
    });

    test('a request with no descriptor has no card and stays decided where it lives', async () => {
        const { update } = await updates.publish({
            audience: { userId: A }, identityKey: 'repair:import', kind: 'question', title: 'Nightly import: review the repair',
            components: ['processes'], gate: { kind: 'process_repair', id: 'automation:5' }, deliver: true
        });
        const [item] = await needsYou(A);
        expect(item).toMatchObject({ needsAction: true, decision: null });
        expect(await gates.card({ userId: A, ref: update.id })).toBeNull();
        expect(await caught(gates.decide({ userId: A, ref: update.id, option: 'approve', occurrence: 1, revision: '1', surface: 'home' })))
            .toMatchObject({ status: 409, code: 'NOT_DECIDABLE_HERE' });
        expect((await db.get('SELECT gateResolvedAt FROM assistant_updates WHERE id = @id', { id: update.id })).gateResolvedAt).toBeNull();
    });

    test('a new kind is one descriptor: it is described, dispatched once and never resolved by the gate service', async () => {
        const fresh = new AssistantGateService();
        const calls = [];
        fresh.registerDecision('process_repair', {
            describe: async (gate) => ({
                state: 'open', title: 'Review the repair', detail: `For ${gate.id}`, revision: 'config:4',
                options: [{ id: 'apply', label: 'Apply repair', effect: 'Changes the source address.', danger: true }, { id: 'dismiss', label: 'Dismiss' }]
            }),
            decide: async (gate, viewer, option, context) => {
                calls.push({ gate: gate.id, viewer: viewer.userId, option, context });
                return { message: 'Applied.' };
            }
        });
        const { update } = await updates.publish({
            audience: { userId: A }, identityKey: 'repair:import', kind: 'question', title: 'Nightly import: review the repair',
            components: ['processes'], gate: { kind: 'process_repair', id: 'automation:5' }, deliver: true
        });
        const card = await fresh.card({ userId: A, ref: update.id });
        expect(card).toMatchObject({ ref: String(update.id), kind: 'process_repair', occurrence: 1, revision: 'config:4' });
        expect(card.options).toEqual([
            { id: 'apply', label: 'Apply repair', effect: 'Changes the source address.', danger: true },
            { id: 'dismiss', label: 'Dismiss', effect: null, danger: false }
        ]);
        const result = await fresh.decide({ userId: A, ref: update.id, option: 'apply', occurrence: 1, revision: 'config:4', surface: 'home' });
        expect(result.decided).toEqual({ ref: String(update.id), kind: 'process_repair', option: 'apply', message: 'Applied.' });
        expect(calls).toEqual([{
            gate: 'automation:5', viewer: A, option: 'apply',
            context: { occurrence: 1, revision: 'config:4', surface: 'home', gateway: null }
        }]);
        // The owning domain resolves the gate; deciding does not.
        expect((await db.get('SELECT gateResolvedAt FROM assistant_updates WHERE id = @id', { id: update.id })).gateResolvedAt).toBeNull();
        expect(await caught(fresh.decide({ userId: A, ref: update.id, option: 'apply', occurrence: 1, revision: 'config:3', surface: 'chat' })))
            .toMatchObject({ code: 'STALE_GATE' });
        expect(calls).toHaveLength(1);
    });

    test('with the feature off the Inbox keeps its own request and carries no card', async () => {
        const { item } = await friendRequest();
        useState({ inactive: ['assistant'] });
        const [same] = await needsYou(A);
        expect(same).toMatchObject({ id: item.id, needsAction: true, decision: null, friend: { actionable: true } });
        expect((await home.project({ userId: A })).needsYou[0]).toMatchObject({ request: 'friend_request', decision: null });
        expect(await gates.card({ userId: A, ref: `inbox-${item.id}` })).toBeNull();
        const respond = jest.spyOn(friends, 'respond');
        const refused = await caught(gates.decide({
            userId: A, ref: `inbox-${item.id}`, option: 'accept', occurrence: 1, revision: item.decision.revision, surface: 'chat'
        }));
        expect(refused).toMatchObject({ status: 404, code: 'FEATURE_UNAVAILABLE' });
        expect(respond).not.toHaveBeenCalled();
    });

    test('a card that cannot be described never breaks the Inbox', async () => {
        const { item } = await friendRequest();
        jest.spyOn(gates, '_card').mockRejectedValue(new Error('boom'));
        const [listed] = await needsYou(A);
        expect(listed).toMatchObject({ id: item.id, needsAction: true, decision: null, friend: { actionable: true } });
        expect((await home.project({ userId: A })).needsYou).toHaveLength(1);
    });
});

describe('POST /api/app/assistant/gates/:ref/decide', () => {
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

    test('the Inbox item and Home carry the card; the route decides as the session\'s person and refuses a stale card with the current one', async () => {
        const ada = await session(A, 'Ada');
        const cy = await session(C, 'Cy');
        const { request: asked } = await friends.request({ userId: B, targetId: A });

        const listed = await request({ reqPath: '/api/app/inbox?view=needs_you', cookie: ada });
        const card = listed.json.items[0].decision;
        expect(card).toMatchObject({ kind: 'friend_request', state: 'open' });
        const homeView = await request({ reqPath: '/api/app/home', cookie: ada });
        expect(homeView.json.assistant.needsYou[0].decision).toEqual(card);

        const body = { option: 'accept', occurrence: card.occurrence, revision: card.revision, surface: 'home' };
        const url = `/api/app/assistant/gates/${card.ref}/decide`;
        // Someone else's session cannot reach it, and a userId in the body is ignored.
        const other = await request({ method: 'POST', reqPath: url, cookie: cy, body: { ...body, userId: A } });
        expect(other.status).toBe(404);
        expect((await request({ method: 'POST', reqPath: url, body })).status).toBe(401);
        expect((await request({ method: 'POST', reqPath: url, cookie: ada, body: { ...body, surface: undefined } })).status).toBe(400);

        const decided = await request({ method: 'POST', reqPath: url, cookie: ada, body });
        expect(decided.status).toBe(200);
        expect(decided.json.decided).toEqual({ ref: card.ref, kind: 'friend_request', option: 'accept', message: 'You and Bo are friends now.' });
        expect(decided.json.current).toMatchObject({ state: 'resolved' });
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: asked.id })).status).toBe('accepted');

        const again = await request({ method: 'POST', reqPath: url, cookie: ada, body: { ...body, option: 'decline', surface: 'inbox' } });
        expect(again.status).toBe(409);
        expect(again.json.error).toMatchObject({ code: 'STALE_GATE', details: { current: { state: 'resolved', outcome: 'You accepted this request.' } } });
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: asked.id })).status).toBe('accepted');
    });

    test('until the pilot decision is recorded the route offers and decides for the owner only; the Inbox\'s own route still decides', async () => {
        await instanceState.remove(access.KEY_PILOT);
        await identityService.grantAccount({ principalId: C, entitlement: 'bootstrap', role: 'operator' });
        const ada = await session(A, 'Ada');
        const cy = await session(C, 'Cy');
        const { request: toAda } = await friends.request({ userId: B, targetId: A });
        const { request: toCy } = await friends.request({ userId: B, targetId: C });
        const status = async (id) => (await db.get('SELECT status FROM friendships WHERE id = @id', { id })).status;

        // Ada is not the owner: the request is there, on both surfaces, without a card.
        const listed = await request({ reqPath: '/api/app/inbox?view=needs_you', cookie: ada });
        expect(listed.json.items).toHaveLength(1);
        expect(listed.json.items[0]).toMatchObject({ needsAction: true, decision: null, friend: { actionable: true } });
        const adaHome = await request({ reqPath: '/api/app/home', cookie: ada });
        expect(adaHome.json.assistant.needsYou[0]).toMatchObject({ request: 'friend_request', decision: null });
        const ref = `inbox-${listed.json.items[0].id}`;
        expect((await request({ reqPath: `/api/app/assistant/gates/${ref}`, cookie: ada })).status).toBe(404);
        for (const surface of ['home', 'inbox']) {
            const refused = await request({
                method: 'POST', reqPath: `/api/app/assistant/gates/${ref}/decide`, cookie: ada,
                body: { option: 'accept', occurrence: 1, revision: toAda.createdAt, surface }
            });
            expect(refused.status).toBe(403);
            expect(refused.json.error).toMatchObject({ code: 'PILOT_ONLY', details: { capability: 'conversation' } });
        }
        expect(await status(toAda.id)).toBe('pending');
        const direct = await request({ method: 'POST', reqPath: `/api/app/friends/requests/${toAda.id}/accept`, cookie: ada, body: {} });
        expect(direct.status).toBe(200);
        expect(await status(toAda.id)).toBe('accepted');

        // Cy is the owner: the card is on both, and it decides.
        const cyInbox = await request({ reqPath: '/api/app/inbox?view=needs_you', cookie: cy });
        const card = cyInbox.json.items[0].decision;
        expect(card).toMatchObject({ kind: 'friend_request', state: 'open' });
        const cyHome = await request({ reqPath: '/api/app/home', cookie: cy });
        expect(cyHome.json.assistant.needsYou[0].decision).toEqual(card);
        const decided = await request({
            method: 'POST', reqPath: `/api/app/assistant/gates/${card.ref}/decide`, cookie: cy,
            body: { option: 'accept', occurrence: card.occurrence, revision: card.revision, surface: 'home' }
        });
        expect(decided.status).toBe(200);
        expect(await status(toCy.id)).toBe('accepted');
    });

    test('with the feature off the route is refused and the Inbox\'s own routes still decide', async () => {
        const ada = await session(A, 'Ada');
        const { request: asked } = await friends.request({ userId: B, targetId: A });
        const [item] = await needsYou(A);
        useState({ inactive: ['assistant'] });
        const refused = await request({
            method: 'POST', reqPath: `/api/app/assistant/gates/inbox-${item.id}/decide`, cookie: ada,
            body: { option: 'accept', occurrence: 1, revision: asked.createdAt, surface: 'inbox' }
        });
        expect(refused.status).toBe(404);
        expect(refused.json.error.code).toBe('FEATURE_UNAVAILABLE');
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: asked.id })).status).toBe('pending');
        const direct = await request({ method: 'POST', reqPath: `/api/app/friends/requests/${asked.id}/accept`, cookie: ada, body: {} });
        expect(direct.status).toBe(200);
    });
});
