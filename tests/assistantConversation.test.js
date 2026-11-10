/**
 * Delegating and steering by conversation (DA-7b, ADR 0023;
 * documentation/delegated_conversation.md).
 *
 * The property this suite exists for: no sequence of model tool calls can
 * activate, resume or widen a responsibility, in a chat turn, in a
 * delegated run or in an automation turn. A model can draft; only a person
 * confirms, with a single-use receipt bound to what they were shown.
 *
 * Also under test: a proposal is the narrowest draft and nothing is active
 * until confirmed; declining leaves no draft behind; "what are you working
 * on" and "why" are answered from the run and journal records, refusals
 * included; "stop that" cancels the named work and says what had already
 * changed; the tools refuse in incognito, in an unattended turn, in a
 * shared conversation and outside the pilot; and a decision pressed on a
 * chat card needs its own receipt.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-conversation-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const perplexity = require('@goobster/core/services/perplexityService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const modelCallScope = require('@goobster/core/utils/modelCallScope');
const { runAgentLoop } = require('@goobster/core/utils/chat/agentOrchestrator');
const { isIncognitoToolBlocked } = require('@goobster/core/utils/toolPrivacy');
const assistantTools = require('@goobster/core/utils/tools/assistant');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const initiatives = require('@goobster/core/services/assistantInitiativeService');
const runner = require('@goobster/core/services/assistantRunnerService');
const confirmations = require('@goobster/core/services/assistantConfirmationService');
const gates = require('@goobster/core/services/assistantGateService');
const access = require('@goobster/core/services/assistantAccessService');
const steward = require('@goobster/core/services/assistantStewardService');
const inbox = require('@goobster/core/services/inboxService');
const friends = require('@goobster/core/services/friendService');
const policies = require('@goobster/core/services/attentionPolicyService');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const instanceState = require('@goobster/core/services/instanceStateService');
const privacyService = require('@goobster/core/services/privacyService');
const eventBusService = require('@goobster/core/services/eventBusService');
const mcpProtocol = require('@goobster/core/mcp/protocol');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const { DisabledGateway } = require('@goobster/core/gateway');
const { useState } = require('./helpers/featureFixtures');

/** The installation's owner: the one account the pilot gate lets through. */
const A = '760000000000000001';
/** An ordinary account. */
const B = '760000000000000002';
const C = '760000000000000003';
const GUILD = '760000000000000900';

const KG_ADD = { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } };
const READ_WEB = { operation: 'read', resource: { kind: 'web' } };
const READ_NOTES = { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } };
const TOOLS = ['proposeResponsibility', 'describeDelegatedWork', 'controlDelegatedWork'];

const TABLES = [
    'assistant_confirmation_receipts', 'assistant_run_operations', 'assistant_runs', 'assistant_initiatives',
    'assistant_source_cursors', 'assistant_update_receipts', 'assistant_updates',
    'assistant_responsibility_revisions', 'assistant_responsibilities', 'attention_policies', 'attention_items',
    'inbox_items', 'friendships', 'usage_reservations', 'work_failures', 'web_sessions', 'web_rate_events',
    'auth_identities', 'app_accounts', 'principals'
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
    runner._reset();
    identityConfig.requireAccount = false;
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`, {});
    await instanceState.remove(access.KEY_PILOT);
    for (const [id, name] of [[A, 'Ada'], [B, 'Bo'], [C, 'Cy']]) {
        await identityService.ensureLegacyPrincipal({ discordId: id, displayName: name });
    }
    await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
    await policies.enroll({ userId: A, initiative: 'assist' });
});

/** The person's own portal conversation. */
const webChat = (userId = A, extra = {}) => ({
    user: { id: userId, username: 'person' }, guildId: null, channelId: `web:${userId}:study-1`,
    channel: { id: `web:${userId}:study-1` }, ...extra
});
const discordDm = (userId = A) => ({ user: { id: userId, username: 'person' }, guildId: null, channelId: '760000000000000555', channel: { id: '760000000000000555' } });
const guildChannel = (userId = A) => ({ user: { id: userId, username: 'person' }, guildId: GUILD, guild: { id: GUILD }, channelId: '760000000000000777', channel: { id: '760000000000000777' } });
const sharedTable = (userId = A) => ({ user: { id: userId, username: 'person' }, guildId: null, channelId: `web:parlor:${C}:9`, channel: { id: `web:parlor:${C}:9` } });

const tool = (name, args = {}, context = webChat()) => toolsRegistry.execute(name, { ...args, interactionContext: context });
const textOf = (result) => (result && typeof result === 'object' ? result._display : result);
const caught = async (promise) => promise.then(() => null, error => error);
const row = (id) => db.get('SELECT * FROM assistant_responsibilities WHERE id = @id', { id });
const allRows = () => db.all('SELECT * FROM assistant_responsibilities ORDER BY id', {});
const receiptRows = () => db.all('SELECT * FROM assistant_confirmation_receipts ORDER BY id', {});

/** A draft the model proposed for `userId` in their portal chat. */
async function proposed(body = {}, userId = A) {
    const result = await tool('proposeResponsibility', { title: 'Keep my garden notes current', operations: [KG_ADD], ...body }, webChat(userId));
    expect(result._card).toEqual({ kind: 'assistant-proposal', id: expect.any(Number) });
    return responsibilities.get({ userId, id: result._card.id });
}

/** What the person does when they press Confirm: a receipt for what is on their screen. */
const mint = (item, action = 'activate', extra = {}) => confirmations.mint({
    userId: item.ownerUserId, subject: 'responsibility', id: item.id, action, revision: item.revision, surface: 'chat', ...extra
});

async function confirm(item, action = 'activate') {
    const { receipt } = await mint(item, action);
    return (await responsibilities.act({ userId: item.ownerUserId, id: item.id, action, expectedRevision: item.revision, receipt })).responsibility;
}

/** What a responsibility may do, and whether it may do it now. */
const authority = (r) => JSON.stringify({ status: r.status, operations: r.operationsJson, scopes: r.scopesJson, rules: r.rulesJson, budgets: r.budgetsJson, expiresAt: r.expiresAt });

async function initiativeRow({ responsibilityId, userId = A, status = 'QUEUED', title = 'Check the frost dates', reason = 'The goal changed' }) {
    const id = await db.insert(
        `INSERT INTO assistant_initiatives
            (responsibilityId, responsibilityRevision, ownerUserId, actingUserId, sourceKind, sourceId, sourceRevision, dedupeKey, title, reason, status)
         VALUES (@responsibilityId, 1, @userId, @userId, 'attention_item', '41', 'r1', @dedupeKey, @title, @reason, @status)`,
        { responsibilityId, userId, title, reason, status, dedupeKey: `k-${crypto.randomUUID()}` }
    );
    return initiatives.get({ userId, id });
}

async function runRecord({ initiative, userId = A, status = 'RUNNING', operations = [] }) {
    const runId = await db.insert(
        `INSERT INTO assistant_runs (initiativeId, responsibilityId, responsibilityRevision, ownerUserId, actingUserId, payerUserId,
            status, rounds, tokensUsed, searches, resultTitle, resultSummary)
         VALUES (@initiativeId, @responsibilityId, 1, @userId, @userId, @userId, @status, 2, 1200, 1, 'Frost on the 14th', 'Two sources agree.')`,
        { initiativeId: initiative.id, responsibilityId: initiative.responsibilityId, userId, status }
    );
    let seq = 0;
    for (const op of operations) {
        await db.run(
            `INSERT INTO assistant_run_operations (runId, ownerUserId, tool, argsHash, seq, operation, resourceKind, effect, status, refusalCode, resultText)
             VALUES (@runId, @userId, @tool, @hash, 1, @operation, @resourceKind, @effect, @status, @refusalCode, @resultText)`,
            {
                runId, userId, tool: op.tool, hash: `h${++seq}`, operation: op.operation || null, resourceKind: op.resourceKind || null,
                effect: op.effect || 'read', status: op.status, refusalCode: op.refusalCode || null, resultText: op.resultText || null
            }
        );
    }
    return runId;
}

let callId = 0;
const call = (name, args = {}) => ({ id: `c${++callId}`, name, arguments: JSON.stringify(args) });
/** Script the model: each entry is one round's tool calls, or a final text. */
function script(...rounds) {
    const queue = [...rounds];
    return jest.spyOn(aiService, 'chat').mockImplementation(async () => {
        const next = queue.shift();
        if (next === undefined) return { content: 'Nothing more.', toolCalls: [] };
        return typeof next === 'string' ? { content: next, toolCalls: [] } : { content: '', toolCalls: next };
    });
}

/**
 * Everything that would turn authority on, start work or decide for the
 * person, tried from wherever it is called. Returns the error code of each
 * attempt (null when it went through).
 */
async function tryEverything({ draft, paused, review, active, candidate, card, receipts = {} }) {
    const code = async (attempt) => {
        const error = await caught(Promise.resolve().then(attempt));
        return error ? (error.code || error.message) : null;
    };
    return {
        createActive: await code(() => responsibilities.create({ userId: A, body: { title: 'Now', operations: [KG_ADD] }, activate: true })),
        createDraft: await code(() => responsibilities.create({ userId: A, body: { title: 'Unmarked', operations: [KG_ADD] } })),
        activate: await code(() => responsibilities.act({ userId: A, id: draft.id, action: 'activate', expectedRevision: draft.revision })),
        activateWithReceipt: await code(() => responsibilities.act({
            userId: A, id: draft.id, action: 'activate', expectedRevision: draft.revision, receipt: receipts.activate
        })),
        resumePaused: await code(() => responsibilities.act({ userId: A, id: paused.id, action: 'resume', expectedRevision: paused.revision })),
        resumeWithReceipt: await code(() => responsibilities.act({
            userId: A, id: paused.id, action: 'resume', expectedRevision: paused.revision, receipt: receipts.resume
        })),
        resumeReview: await code(() => responsibilities.act({ userId: A, id: review.id, action: 'resume', expectedRevision: review.revision })),
        widenDraft: await code(() => responsibilities.update({
            userId: A, id: draft.id, expectedRevision: draft.revision, body: { operations: [KG_ADD, READ_WEB] }
        })),
        widenPaused: await code(() => responsibilities.update({
            userId: A, id: paused.id, expectedRevision: paused.revision, body: { operations: [KG_ADD, READ_WEB], rules: { autoStart: true } }
        })),
        extend: await code(() => responsibilities.update({
            userId: A, id: active.id, expectedRevision: active.revision, body: { expiresAt: '2099-01-01T00:00:00Z' }
        })),
        keep: await code(() => responsibilities.keepProposal({ userId: A, id: draft.id, expectedRevision: draft.revision })),
        mintActivate: await code(() => mint(draft, 'activate')),
        mintResume: await code(() => mint(paused, 'resume')),
        redeem: await code(() => confirmations.redeem({
            userId: A, receipt: receipts.activate, subject: 'responsibility', id: draft.id, action: 'activate',
            revision: draft.revision, hash: confirmations.grantHash(draft)
        })),
        queue: await code(() => initiatives.act({ userId: A, id: candidate.id, action: 'queue', expectedRevision: candidate.revision })),
        decide: await code(() => gates.decide({
            userId: A, ref: card.ref, option: 'accept', occurrence: card.occurrence, revision: card.revision, surface: 'inbox'
        })),
        decideInChat: await code(() => gates.decide({
            userId: A, ref: card.ref, option: 'accept', occurrence: card.occurrence, revision: card.revision, surface: 'chat', receipt: receipts.decide
        })),
        mintDecide: await code(() => confirmations.mint({
            userId: A, subject: 'gate', id: card.ref, action: 'decide', occurrence: card.occurrence, revision: card.revision, surface: 'chat'
        }))
    };
}

/** A person with one grant in each state a model might try to move, and receipts they minted themselves. */
async function world() {
    const draft = await proposed({ title: 'Draft' });
    const paused = await (async () => {
        const live = await confirm(await proposed({ title: 'Paused' }));
        return (await responsibilities.act({ userId: A, id: live.id, action: 'pause', expectedRevision: live.revision })).responsibility;
    })();
    const review = await (async () => {
        const live = await confirm(await proposed({ title: 'Review' }));
        return (await responsibilities.requestReview({ id: live.id, expectedRevision: live.revision })).responsibility;
    })();
    const active = await confirm(await proposed({ title: 'Active' }));
    const candidate = await initiativeRow({ responsibilityId: active.id, status: 'CANDIDATE' });
    await friends.request({ userId: B, targetId: A });
    const [item] = (await inbox.list({ userId: A, view: 'needs_you' })).items.filter(entry => entry.decision?.kind === 'friend_request');
    const card = item.decision;
    // Real receipts, minted by the person: even holding one, a tool call cannot spend it.
    const receipts = {
        activate: (await mint(draft, 'activate')).receipt,
        resume: (await mint(paused, 'resume')).receipt,
        decide: (await confirmations.mint({
            userId: A, subject: 'gate', id: card.ref, action: 'decide', occurrence: card.occurrence, revision: card.revision, surface: 'chat'
        })).receipt
    };
    return { draft, paused, review, active, candidate, card, receipts };
}

const ALL_HUMAN_ONLY = Object.fromEntries([
    'createActive', 'createDraft', 'activate', 'activateWithReceipt', 'resumePaused', 'resumeWithReceipt', 'resumeReview',
    'widenDraft', 'widenPaused', 'extend', 'keep', 'mintActivate', 'mintResume', 'redeem', 'queue', 'decide', 'decideInChat', 'mintDecide'
].map(name => [name, 'HUMAN_ONLY']));

async function expectUntouched(state, before) {
    const after = new Map((await allRows()).map(r => [r.id, authority(r)]));
    for (const [id, was] of before) expect(after.get(id)).toBe(was);
    // Nothing new appeared with authority either.
    for (const r of await allRows()) {
        if (!before.has(r.id)) expect(r).toMatchObject({ status: 'DRAFT', proposedBy: 'model' });
    }
    expect((await initiatives.get({ userId: A, id: state.candidate.id })).status).toBe('CANDIDATE');
    expect((await db.get('SELECT status FROM friendships', {})).status).toBe('pending');
    // The person's receipts are still theirs to use.
    expect((await receiptRows()).filter(r => r.consumedAt)).toHaveLength(3);
}
const snapshot = async () => new Map((await allRows()).map(r => [r.id, authority(r)]));

describe('proposing a responsibility', () => {
    test('the model drafts it; nothing is active and the draft says where it came from', async () => {
        const result = await tool('proposeResponsibility', {
            title: 'Keep my garden notes current', outcome: 'Notes reflect the season', operations: [KG_ADD], stopCondition: 'When the season ends'
        });
        expect(result._card).toEqual({ kind: 'assistant-proposal', id: expect.any(Number) });
        expect(result._display).toContain('It is a DRAFT: it grants nothing and nothing is running.');
        expect(result._display).toContain('add generated notes: your knowledge');
        expect(result._display).toContain('Do not say it is active.');

        const item = await responsibilities.get({ userId: A, id: result._card.id });
        expect(item).toMatchObject({
            status: 'DRAFT', revision: 1, ownerUserId: A, authorizedBy: A, actingUserId: A, payerUserId: A,
            operations: [KG_ADD], rules: { stopCondition: 'When the season ends' }, activatedAt: null,
            proposedBy: 'model', proposal: { conversation: `web:${A}:study-1`, keptAt: null }
        });
        expect(await responsibilities.authorize({
            responsibilityId: item.id, revision: item.revision, operation: 'kg.generated.add',
            resource: { kind: 'knowledge', id: 'personal' }, actorUserId: A
        })).toMatchObject({ ok: false, code: 'RESPONSIBILITY_INACTIVE' });
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_initiatives', {})).toMatchObject({ n: 0 });
        expect(await receiptRows()).toEqual([]);
    });

    test('a draft the model writes goes through the person\'s validator: no unknown operation, no wildcard', async () => {
        const unknown = await tool('proposeResponsibility', { title: 'All of it', operations: [{ operation: 'everything', resource: { kind: 'web' } }] });
        expect(unknown).toContain('INVALID_OPERATION');
        const wildcard = await tool('proposeResponsibility', { title: 'Any project', operations: [{ operation: 'file.edit', resource: { kind: 'project' } }] });
        expect(wildcard).toContain('there is no wildcard');
        const foreign = await tool('proposeResponsibility', {
            title: 'Someone else', operations: [KG_ADD], ownerUserId: B, actingUserId: B, status: 'ACTIVE', activate: true, proposedBy: null
        });
        expect((await allRows()).map(r => [r.ownerUserId, r.actingUserId, r.status, r.proposedBy])).toEqual([[A, A, 'DRAFT', 'model']]);
        expect(foreign._card.kind).toBe('assistant-proposal');
    });

    test('starting work without asking is the person\'s own switch: a proposal cannot set it', async () => {
        const result = await tool('proposeResponsibility', { title: 'Quietly', operations: [KG_ADD], rules: { autoStart: true }, budgets: { modelTokens: 10 ** 9 } });
        expect(await row(result._card.id)).toMatchObject({ rulesJson: '{}', budgetsJson: '{}' });
    });

    test('where it takes requests from is the person\'s to say: a proposal cannot set it', async () => {
        const plain = await row((await proposed({ title: 'Plain' })).id);
        const result = await tool('proposeResponsibility', {
            title: 'Listening', operations: [KG_ADD], scopes: { sources: ['parlor', 'project_chat'] }, sources: ['parlor']
        });
        expect((await row(result._card.id)).scopesJson).toBe(plain.scopesJson);
        expect(plain.scopesJson).not.toMatch(/parlor|project_chat/);
    });

    test('how it reaches the person is theirs to say: a proposal cannot ask for a digest or a contact', async () => {
        const result = await tool('proposeResponsibility', {
            title: 'Loudly', operations: [KG_ADD], rules: { interruption: 'immediate' }, interruption: 'digest'
        });
        expect(await row(result._card.id)).toMatchObject({ rulesJson: '{}' });
    });

    test('the same proposal in the same conversation is one draft; a pile of unanswered ones is refused', async () => {
        const first = await proposed();
        const again = await tool('proposeResponsibility', { title: 'Keep my garden notes current', operations: [KG_ADD] });
        expect(again._card.id).toBe(first.id);
        expect(again._display).toContain('Already drafted');
        expect(await allRows()).toHaveLength(1);
        // Once that draft was settled, asking again later is a new one.
        await responsibilities.act({ userId: A, id: first.id, action: 'revoke', expectedRevision: first.revision });
        const later = await tool('proposeResponsibility', { title: 'Keep my garden notes current', operations: [KG_ADD] });
        expect(later._card.id).not.toBe(first.id);

        for (let n = 0; n < assistantTools.MAX_PENDING_PROPOSALS - 1; n += 1) await proposed({ title: `Proposal ${n}` });
        const tooMany = await tool('proposeResponsibility', { title: 'One more', operations: [KG_ADD] });
        expect(tooMany).toContain('already waiting');
        expect((await allRows()).filter(r => r.status === 'DRAFT')).toHaveLength(assistantTools.MAX_PENDING_PROPOSALS);
    });

    test('in a Discord DM it is drafted and the person is sent to the portal: there is no confirmation there', async () => {
        const result = await tool('proposeResponsibility', { title: 'From a DM', operations: [KG_ADD] }, discordDm());
        expect(typeof result).toBe('string');
        expect(result).toContain('It cannot be confirmed here.');
        expect(result).toContain('Responsibilities page of the portal');
        expect((await allRows())[0]).toMatchObject({ status: 'DRAFT', proposedBy: 'model', proposedConversation: '760000000000000555' });
    });

    test('declining leaves no draft behind; keeping leaves it as a draft', async () => {
        const declined = await proposed({ title: 'No thanks' });
        await mint(declined);
        expect(await caught(responsibilities.discardProposal({ userId: B, id: declined.id, expectedRevision: 1 }))).toMatchObject({ code: 'NOT_FOUND' });
        expect(await caught(responsibilities.discardProposal({ userId: A, id: declined.id, expectedRevision: 9 }))).toMatchObject({ code: 'REVISION_CONFLICT' });
        expect(await responsibilities.discardProposal({ userId: A, id: declined.id, expectedRevision: 1 })).toEqual({ discarded: true, id: declined.id });
        expect(await row(declined.id)).toBeUndefined();
        expect(await db.all('SELECT id FROM assistant_responsibility_revisions WHERE responsibilityId = @id', { id: declined.id })).toEqual([]);
        expect(await receiptRows()).toEqual([]);

        const kept = await proposed({ title: 'Later' });
        const { responsibility } = await responsibilities.keepProposal({ userId: A, id: kept.id, expectedRevision: 1 });
        expect(responsibility).toMatchObject({ status: 'DRAFT', revision: 1, proposal: { keptAt: expect.any(String) } });

        // Only a proposal that never ran is deleted; anything else is revoked instead.
        const live = await confirm(await proposed({ title: 'Ran' }));
        expect(await caught(responsibilities.discardProposal({ userId: A, id: live.id, expectedRevision: live.revision })))
            .toMatchObject({ code: 'INVALID_TRANSITION' });
        const { responsibility: own } = await responsibilities.create({ userId: A, body: { title: 'Mine', operations: [KG_ADD] } });
        expect(await caught(responsibilities.discardProposal({ userId: A, id: own.id, expectedRevision: 1 }))).toMatchObject({ code: 'INVALID_TRANSITION' });
        expect(await caught(responsibilities.keepProposal({ userId: A, id: own.id, expectedRevision: 1 }))).toMatchObject({ code: 'INVALID_TRANSITION' });
    });

    test('a proposal nobody answered is pruned after seven days; one that was kept, edited or activated is not', async () => {
        const ignored = await proposed({ title: 'Ignored' });
        const kept = await proposed({ title: 'Kept' });
        await responsibilities.keepProposal({ userId: A, id: kept.id, expectedRevision: 1 });
        const edited = await proposed({ title: 'Edited' });
        await responsibilities.update({ userId: A, id: edited.id, expectedRevision: 1, body: { title: 'Edited by me' } });
        const live = await confirm(await proposed({ title: 'Live' }));
        const { responsibility: own } = await responsibilities.create({ userId: A, body: { title: 'Mine', operations: [KG_ADD] } });
        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        await db.run('UPDATE assistant_responsibilities SET createdAt = @old', { old });

        expect(await responsibilities.pruneProposals({ days: 30 })).toBe(0);
        const result = await steward.sweep({ retention: true });
        expect(result.retention).toMatchObject({ proposals: 1, confirmations: 0 });
        expect((await allRows()).map(r => r.id).sort()).toEqual([kept.id, edited.id, live.id, own.id].sort());
        expect(await row(ignored.id)).toBeUndefined();
    });
});

describe('where the tools answer', () => {
    test.each(TOOLS)('%s refuses in an unattended turn and reads or writes nothing', async (name) => {
        const item = await confirm(await proposed());
        const list = jest.spyOn(responsibilities, 'list');
        const get = jest.spyOn(responsibilities, 'get');
        const before = await snapshot();
        const result = await tool(name, { title: 'x', operations: [KG_ADD], action: 'pause', id: item.id }, webChat(A, { isAutomation: true }));
        expect(result).toContain('This is an unattended turn');
        expect(list).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
    });

    test.each(TOOLS)('%s is blocked in incognito, by the registry and by the tool itself', async (name) => {
        const item = await confirm(await proposed());
        const incognito = webChat(A, { skipHistory: true });
        expect(isIncognitoToolBlocked(name, incognito)).toBe(true);
        const list = jest.spyOn(responsibilities, 'list');
        const get = jest.spyOn(responsibilities, 'get');
        const before = await snapshot();
        const args = { title: 'x', operations: [KG_ADD], action: 'pause', id: item.id, interactionContext: incognito };
        expect(await toolsRegistry.execute(name, args)).toBe('❌ Delegated work is not read or changed in incognito. Use a regular chat for this.');
        // A caller that skipped the registry meets the same answer.
        expect(await assistantTools[name].execute(args)).toBe('❌ Delegated work is not read or changed in incognito. Use a regular chat for this.');
        expect(list).not.toHaveBeenCalled();
        expect(get).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
    });

    test.each(TOOLS)('%s answers in a guild channel that delegation is private, and says nothing about it', async (name) => {
        const item = await confirm(await proposed({ title: 'A private matter' }));
        const before = await snapshot();
        for (const context of [guildChannel(), sharedTable()]) {
            const result = await tool(name, { title: 'x', operations: [KG_ADD], action: 'pause', id: item.id }, context);
            expect(result).toContain('Delegation is managed privately');
            expect(result).toContain('Responsibilities page of the portal');
            expect(result).not.toContain('A private matter');
        }
        expect(await snapshot()).toEqual(before);
    });

    test.each(TOOLS)('%s is the owner\'s alone until the pilot decision is recorded', async (name) => {
        await policies.enroll({ userId: B, initiative: 'assist' });
        const refused = await tool(name, { title: 'x', operations: [KG_ADD], action: 'pause', id: 1 }, webChat(B));
        expect(refused).toContain('PILOT_ONLY');
        expect(await allRows()).toEqual([]);

        await access.recordDecision({ scope: 'everyone' });
        const allowed = await tool(name, { title: 'x', operations: [KG_ADD], action: 'pause', id: 1 }, webChat(B));
        expect(textOf(allowed)).not.toContain('PILOT_ONLY');
    });

    test.each(TOOLS)('%s is refused when the feature is off', async (name) => {
        useState({ inactive: ['assistant'] });
        const result = await tool(name, { title: 'x', operations: [KG_ADD], action: 'pause', id: 1 });
        expect(result).toMatchObject({ ok: false, code: 'FEATURE_UNAVAILABLE', feature: 'assistant' });
        expect(await assistantTools[name].execute({ title: 'x', operations: [KG_ADD], interactionContext: webChat() }))
            .toBe('❌ Delegated work is not available on this installation.');
        expect(await allRows()).toEqual([]);
    });

    test('they are offered only to a person who could use them, and never to an unattended turn', async () => {
        const names = async (context, options) => (await toolsRegistry.offeredTo(await toolsRegistry.getDefinitions(undefined, options), context))
            .map(def => def.name).filter(name => TOOLS.includes(name));
        expect(await names(webChat(A), { isWeb: true })).toEqual(TOOLS);
        // A guild channel still gets them, so the answer there is "that is private".
        expect(await names(guildChannel(A), {})).toEqual(TOOLS);
        expect(await names(webChat(B), { isWeb: true })).toEqual([]);
        expect(await names(webChat(A, { skipHistory: true }), { isWeb: true })).toEqual([]);
        expect(await names(webChat(A, { isAutomation: true }), { isWeb: true, isAutomation: true })).toEqual([]);
        expect((await toolsRegistry.getDefinitions(undefined, { isAutomation: true })).map(def => def.name).filter(name => TOOLS.includes(name))).toEqual([]);
        await access.recordDecision({ scope: 'everyone' });
        expect(await names(webChat(B), { isWeb: true })).toEqual(TOOLS);
        useState({ inactive: ['assistant'] });
        expect(await names(webChat(A), { isWeb: true })).toEqual([]);
    });
});

describe('the human confirmation receipt', () => {
    test('is minted for what the person is shown, stores only a hash, and activates the draft once', async () => {
        const draft = await proposed();
        const minted = await mint(draft);
        expect(minted).toMatchObject({ surface: 'chat', shown: { id: draft.id, revision: 1, operations: [KG_ADD], status: 'DRAFT' } });
        expect(minted.receipt).toMatch(/^\d+\.[A-Za-z0-9_-]{40,}$/);
        const [stored] = await receiptRows();
        const secret = minted.receipt.split('.')[1];
        expect(stored).toMatchObject({
            userId: A, subjectKind: 'responsibility', subjectId: String(draft.id), action: 'activate', revision: '1',
            grantHash: confirmations.grantHash(draft), surface: 'chat', consumedAt: null,
            nonceHash: crypto.createHash('sha256').update(secret).digest('hex')
        });
        expect(JSON.stringify(stored)).not.toContain(secret);
        expect(new Date(`${stored.expiresAt.replace(' ', 'T')}Z`).getTime() - new Date(`${stored.createdAt.replace(' ', 'T')}Z`).getTime())
            .toBe(confirmations.RECEIPT_TTL_MS);

        const { responsibility } = await responsibilities.act({ userId: A, id: draft.id, action: 'activate', expectedRevision: 1, receipt: minted.receipt });
        expect(responsibility).toMatchObject({ status: 'ACTIVE', revision: 2, proposedBy: 'model' });
        expect((await receiptRows())[0].consumedAt).toBeTruthy();
    });

    test('a draft the model wrote is never activated or resumed without one', async () => {
        const draft = await proposed();
        expect(await caught(responsibilities.act({ userId: A, id: draft.id, action: 'activate', expectedRevision: 1 })))
            .toMatchObject({ code: 'HUMAN_CONFIRMATION_REQUIRED', status: 403 });
        expect(await row(draft.id)).toMatchObject({ status: 'DRAFT', revision: 1 });

        const live = await confirm(draft);
        const paused = (await responsibilities.act({ userId: A, id: live.id, action: 'pause', expectedRevision: live.revision })).responsibility;
        expect(await caught(responsibilities.act({ userId: A, id: paused.id, action: 'resume', expectedRevision: paused.revision })))
            .toMatchObject({ code: 'HUMAN_CONFIRMATION_REQUIRED' });
        expect(await row(paused.id)).toMatchObject({ status: 'PAUSED' });
        expect((await confirm(paused, 'resume')).status).toBe('ACTIVE');
        // Pausing, revoking and archiving only narrow: they never need one.
        const again = await responsibilities.get({ userId: A, id: draft.id });
        expect((await responsibilities.act({ userId: A, id: again.id, action: 'revoke', expectedRevision: again.revision })).responsibility.status).toBe('REVOKED');
    });

    test('it is spent once: a second use, and one of two at the same moment, is refused', async () => {
        const first = await proposed({ title: 'One' });
        const { receipt } = await mint(first);
        await responsibilities.act({ userId: A, id: first.id, action: 'activate', expectedRevision: 1, receipt });
        const paused = (await responsibilities.act({ userId: A, id: first.id, action: 'pause', expectedRevision: 2 })).responsibility;
        expect(await caught(responsibilities.act({ userId: A, id: paused.id, action: 'resume', expectedRevision: paused.revision, receipt })))
            .toMatchObject({ code: 'CONFIRMATION_INVALID', status: 403 });

        const second = await proposed({ title: 'Two' });
        const racing = (await mint(second)).receipt;
        const results = await Promise.all([1, 2].map(() => caught(responsibilities.act({
            userId: A, id: second.id, action: 'activate', expectedRevision: 1, receipt: racing
        }))));
        expect(results.filter(result => result === null)).toHaveLength(1);
        expect(['CONFIRMATION_INVALID', 'REVISION_CONFLICT']).toContain(results.find(Boolean).code);
        expect(await row(second.id)).toMatchObject({ status: 'ACTIVE', revision: 2 });
        expect((await receiptRows()).filter(r => r.subjectId === String(second.id) && r.consumedAt)).toHaveLength(1);
    });

    test('it is bound to the person, the responsibility, the action, the revision and the grant shown', async () => {
        await access.recordDecision({ scope: 'everyone' });
        await policies.enroll({ userId: B, initiative: 'assist' });
        const draft = await proposed({ title: 'Mine' });
        const other = await proposed({ title: 'Another of mine' });
        const theirs = await proposed({ title: 'Theirs' }, B);
        const activate = (target, receipt, extra = {}) => caught(responsibilities.act({
            userId: target.ownerUserId, id: target.id, action: 'activate', expectedRevision: target.revision, receipt, ...extra
        }));
        const refused = { code: 'CONFIRMATION_INVALID', status: 403 };

        // Another person's receipt, for their own draft or for mine.
        expect(await activate(draft, (await mint(theirs)).receipt)).toMatchObject(refused);
        expect(await caught(mint({ ...draft, ownerUserId: B }))).toMatchObject({ code: 'NOT_FOUND' });
        // A receipt for a different responsibility.
        expect(await activate(draft, (await mint(other)).receipt)).toMatchObject(refused);
        // A made-up or mangled one.
        const real = (await mint(draft)).receipt;
        for (const forged of ['1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', `${real}x`, real.split('.')[0], 'true', { id: 1 }, 12345]) {
            expect(await activate(draft, forged)).toMatchObject(refused);
        }
        // The wrong action: a receipt to resume does not activate (and is not minted for a draft).
        expect(await caught(mint(draft, 'resume'))).toMatchObject({ code: 'INVALID_TRANSITION' });
        await db.run("UPDATE assistant_confirmation_receipts SET action = 'resume' WHERE id = @id", { id: Number(real.split('.')[0]) });
        expect(await activate(draft, real)).toMatchObject(refused);

        // The grant changed after it was shown: a new revision, and the old receipt is for the old one.
        const shown = (await mint(draft)).receipt;
        const { responsibility: edited } = await responsibilities.update({
            userId: A, id: draft.id, expectedRevision: 1, body: { operations: [KG_ADD, READ_WEB] }
        });
        expect(await activate(edited, shown)).toMatchObject(refused);
        expect(await caught(mint(draft))).toMatchObject({ code: 'REVISION_CONFLICT', details: { revision: 2 } });
        // The grant changed underneath without a new revision: the hash no longer matches.
        const fresh = (await mint(edited)).receipt;
        await db.run('UPDATE assistant_responsibilities SET operationsJson = @ops WHERE id = @id', {
            id: draft.id, ops: JSON.stringify([KG_ADD, READ_WEB, READ_NOTES])
        });
        expect(await activate(edited, fresh)).toMatchObject(refused);
        // Where it takes requests from is part of the grant too.
        const again = (await mint(edited)).receipt;
        await db.run('UPDATE assistant_responsibilities SET scopesJson = @scopes WHERE id = @id', {
            id: draft.id, scopes: JSON.stringify({ sources: ['parlor'] })
        });
        expect(await activate(edited, again)).toMatchObject(refused);

        expect((await allRows()).map(r => r.status)).toEqual(['DRAFT', 'DRAFT', 'DRAFT']);
        expect((await receiptRows()).filter(r => r.consumedAt)).toEqual([]);
    });

    test('it expires after fifteen minutes', async () => {
        const draft = await proposed();
        const stale = await mint(draft, 'activate', { now: new Date(Date.now() - confirmations.RECEIPT_TTL_MS - 60 * 1000) });
        expect(await caught(responsibilities.act({ userId: A, id: draft.id, action: 'activate', expectedRevision: 1, receipt: stale.receipt })))
            .toMatchObject({ code: 'CONFIRMATION_INVALID' });
        expect(await row(draft.id)).toMatchObject({ status: 'DRAFT' });
    });

    test('an action that fails for another reason leaves the receipt unspent', async () => {
        await policies.disable(A);
        const draft = await proposed();
        const { receipt } = await mint(draft);
        expect(await caught(responsibilities.act({ userId: A, id: draft.id, action: 'activate', expectedRevision: 1, receipt })))
            .toMatchObject({ code: 'ATTENTION_NOT_ENROLLED' });
        expect((await receiptRows())[0].consumedAt).toBeNull();
        await policies.enroll({ userId: A, initiative: 'assist' });
        expect((await responsibilities.act({ userId: A, id: draft.id, action: 'activate', expectedRevision: 1, receipt })).responsibility.status).toBe('ACTIVE');
    });

    test('a receipt supplied for the person\'s own draft is checked too; without one the service keeps its contract', async () => {
        const { responsibility: own } = await responsibilities.create({ userId: A, body: { title: 'Mine', operations: [KG_ADD] } });
        expect(own).toMatchObject({ proposedBy: null, proposal: null });
        expect(responsibilities.needsReceipt(own, 'activate')).toBe(false);
        expect(await caught(responsibilities.act({ userId: A, id: own.id, action: 'activate', expectedRevision: 1, receipt: '9.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })))
            .toMatchObject({ code: 'CONFIRMATION_INVALID' });
        const minted = await mint(own, 'activate', { surface: 'portal' });
        expect((await responsibilities.act({ userId: A, id: own.id, action: 'activate', expectedRevision: 1, receipt: minted.receipt })).responsibility.status).toBe('ACTIVE');
        const { responsibility: plain } = await responsibilities.create({ userId: A, body: { title: 'Plain', operations: [KG_ADD] } });
        expect((await responsibilities.act({ userId: A, id: plain.id, action: 'activate', expectedRevision: 1 })).responsibility.status).toBe('ACTIVE');
    });

    test('confirming from a conversation is the owner\'s alone until the pilot decision is recorded', async () => {
        await policies.enroll({ userId: B, initiative: 'assist' });
        const { responsibility: own } = await responsibilities.create({ userId: B, body: { title: 'Mine', operations: [KG_ADD] } });
        expect(await caught(mint(own))).toMatchObject({ code: 'PILOT_ONLY', status: 403 });
        // The Responsibilities page is not part of the pilot.
        expect((await mint(own, 'activate', { surface: 'portal' })).receipt).toBeTruthy();

        await access.recordDecision({ scope: 'everyone' });
        const draft = await proposed({}, B);
        const { receipt } = await mint(draft);
        await access.recordDecision({ scope: 'owner' });
        // The pilot closed again: what was drafted by conversation stays a draft, on any surface.
        expect(await caught(mint(draft, 'activate', { surface: 'portal' }))).toMatchObject({ code: 'PILOT_ONLY' });
        expect(await caught(responsibilities.act({ userId: B, id: draft.id, action: 'activate', expectedRevision: 1, receipt })))
            .toMatchObject({ code: 'PILOT_ONLY', status: 403 });
        expect(await row(draft.id)).toMatchObject({ status: 'DRAFT' });
    });

    test('with the feature off none is minted', async () => {
        const draft = await proposed();
        useState({ inactive: ['assistant'] });
        expect(await caught(mint(draft))).toMatchObject({ code: 'FEATURE_UNAVAILABLE', status: 404 });
    });

    test('spent and expired receipts are deleted after thirty days, and with the person', async () => {
        const draft = await proposed();
        await mint(draft, 'activate', { now: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) });
        await mint(draft);
        expect(await confirmations.prune({})).toBe(1);
        expect(await receiptRows()).toHaveLength(1);

        const report = await privacyService.buildUserReport({ userId: A });
        expect(JSON.stringify(report)).toContain('"confirmationReceipts":1');
        const exported = await require('@goobster/core/services/accountExportData').snapshot(A);
        expect(exported.assistant_confirmation_receipts).toHaveLength(1);
        expect(exported.assistant_confirmation_receipts[0]).not.toHaveProperty('nonceHash');
        const counts = await privacyService.forgetUser({ userId: A });
        expect(counts.assistantConfirmationReceipts).toBe(1);
        expect(await receiptRows()).toEqual([]);
        expect((await privacyService.auditUser({ userId: A })).byTable.assistant_confirmation_receipts).toBe(0);
    });
});

describe('no model tool call turns authority on', () => {
    test('every way a model\'s tool call is dispatched marks it as one', async () => {
        const seen = [];
        const probe = async () => { seen.push(modelCallScope.current()?.origin || null); return 'ok'; };

        // The chat tool registry: a chat turn, an automation turn, a voice turn and a plan step all call it.
        jest.spyOn(assistantTools.describeDelegatedWork, 'execute').mockImplementation(probe);
        await tool('describeDelegatedWork', {}, webChat());
        await tool('describeDelegatedWork', {}, webChat(A, { isAutomation: true }));
        await tool('describeDelegatedWork', {}, guildChannel());
        // The agent loop, with the registry and with an executor of its own (a delegated run, a persona).
        script([call('describeDelegatedWork')], 'done', [call('anything')], 'done');
        await runAgentLoop({ messages: [{ role: 'user', content: 'hi' }], functionDefs: [assistantTools.describeDelegatedWork.definition], interactionContext: webChat() });
        await runAgentLoop({
            messages: [{ role: 'user', content: 'hi' }], functionDefs: [{ name: 'anything', description: 'x', parameters: { type: 'object', properties: {} } }],
            interactionContext: webChat(), executeTool: probe
        });
        // The MCP server.
        await mcpProtocol.handleMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_docs', arguments: {} } },
            { serverInfo: { name: 't', version: '1' }, listTools: () => [], callTool: async () => { await probe(); return { content: [] }; } }
        );

        expect(seen).toEqual([
            'registry:describeDelegatedWork', 'registry:describeDelegatedWork', 'registry:describeDelegatedWork',
            'registry:describeDelegatedWork', 'loop:anything', 'mcp:search_docs'
        ]);
        expect(modelCallScope.active()).toBe(false);
    });

    test('inside a tool call, nothing activates, resumes, widens, queues, decides or mints: even holding a real receipt', async () => {
        const state = await world();
        const before = await snapshot();
        const attempts = await modelCallScope.run('test', () => tryEverything(state));
        expect(attempts).toEqual(ALL_HUMAN_ONLY);
        await expectUntouched({ ...state }, before).catch(() => { throw new Error('authority moved inside a tool call'); });

        // The same calls made by the person go through: the refusal was the tool call, not the arguments.
        const outside = await tryEverything(state);
        expect(outside).toMatchObject({
            activateWithReceipt: null, resumeWithReceipt: null, queue: null, decide: null, mintDecide: 'STALE_GATE', widenDraft: 'REVISION_CONFLICT'
        });
    });

    test('what a tool call may do is narrow: pause, revoke, cancel, reject', async () => {
        const state = await world();
        const review = await initiativeRow({ responsibilityId: state.active.id, status: 'REVIEW' });
        const done = await modelCallScope.run('test', async () => ({
            pause: (await responsibilities.act({ userId: A, id: state.active.id, action: 'pause', expectedRevision: state.active.revision })).responsibility.status,
            revoke: (await responsibilities.act({ userId: A, id: state.paused.id, action: 'revoke', expectedRevision: state.paused.revision })).responsibility.status,
            cancel: (await initiatives.act({ userId: A, id: state.candidate.id, action: 'cancel', expectedRevision: state.candidate.revision })).initiative.status,
            reject: (await initiatives.act({ userId: A, id: review.id, action: 'reject', expectedRevision: review.revision })).initiative.status,
            accept: (await caught(initiatives.act({ userId: A, id: review.id, action: 'accept', expectedRevision: review.revision + 1 })))?.code,
            discard: await responsibilities.discardProposal({ userId: A, id: state.draft.id, expectedRevision: state.draft.revision })
        }));
        expect(done).toEqual({
            pause: 'PAUSED', revoke: 'REVOKED', cancel: 'CANCELLED', reject: 'CANCELLED', accept: 'HUMAN_ONLY',
            discard: { discarded: true, id: state.draft.id }
        });
    });

    test.each([
        ['a chat turn', () => webChat()],
        ['an automation turn', () => webChat(A, { isAutomation: true })],
        ['a turn in a guild channel', () => guildChannel()]
    ])('in %s, a model that calls every delegation tool with every argument it can invent moves nothing', async (_label, context) => {
        const state = await world();
        const before = await snapshot();
        const ids = [state.draft.id, state.paused.id, state.review.id, state.active.id, state.candidate.id];
        const inventions = [];
        let attempt = 0;
        for (const id of ids) {
            for (const action of ['activate', 'resume', 'queue', 'retry', 'accept', 'edit', 'widen', 'confirm', 'keep', 'approve']) {
                inventions.push(call('controlDelegatedWork', {
                    attempt: ++attempt, action, id, receipt: state.receipts.activate, expectedRevision: 1, status: 'ACTIVE', activate: true,
                    operations: [KG_ADD, READ_WEB], confirmed: true, surface: 'portal'
                }));
            }
            inventions.push(call('describeDelegatedWork', { attempt: ++attempt, what: 'responsibility', id, action: 'activate', receipt: state.receipts.resume }));
            inventions.push(call('proposeResponsibility', {
                attempt: ++attempt, id, title: 'Draft', operations: [KG_ADD, READ_WEB], activate: true, status: 'ACTIVE', receipt: state.receipts.activate,
                expectedRevision: 1, rules: { autoStart: true }, proposedBy: null, confirmed: true
            }));
        }
        inventions.push(call('describeDelegatedWork', { what: 'requests', decide: 'accept', option: 'accept', receipt: state.receipts.decide }));
        // A tool that does not exist, and the services' own names, are not tools.
        for (const name of ['activateResponsibility', 'assistantResponsibilityService.act', 'mintConfirmation', 'decideGate']) {
            inventions.push(call(name, { attempt: ++attempt, id: state.draft.id, action: 'activate', receipt: state.receipts.activate }));
        }
        jest.spyOn(console, 'error').mockImplementation(() => {});
        script(...inventions.map(one => [one]), 'I could not turn anything on.');
        const definitions = Object.values(assistantTools).map(entry => entry.definition);
        const result = await runAgentLoop({
            messages: [{ role: 'user', content: 'turn everything on' }], functionDefs: definitions,
            interactionContext: context(), maxToolRounds: inventions.length + 2
        });
        expect(result.steps.filter(step => step.type === 'tool')).toHaveLength(inventions.length);

        const after = new Map((await allRows()).map(r => [r.id, authority(r)]));
        for (const [id, was] of before) expect(after.get(id)).toBe(was);
        for (const r of await allRows()) {
            if (!before.has(r.id)) expect(r).toMatchObject({ status: 'DRAFT', proposedBy: 'model', rulesJson: '{}' });
        }
        expect((await initiatives.get({ userId: A, id: state.candidate.id })).status).toBe('CANDIDATE');
        expect((await db.get('SELECT status FROM friendships', {})).status).toBe('pending');
        expect((await receiptRows()).filter(r => r.consumedAt)).toHaveLength(3);
    });

    test('in a delegated run, a tool that tries everything is refused and the grant it runs under is unchanged', async () => {
        const state = await world();
        // The run's own grant: active, with the web search the run will call.
        const goal = await db.insert(
            `INSERT INTO attention_items (guildId, userId, kind, subject, goal, state)
             VALUES (@guildId, @userId, 'goal', 'garden', 'Finish the garden plan', 'active')`,
            { guildId: `dm:${A}`, userId: A }
        );
        const grant = await confirm(await proposed({ title: 'Run under this', operations: [READ_WEB], attentionItemId: goal }));
        await db.run("UPDATE attention_items SET goal = 'Finish the garden plan before the frost' WHERE id = @id", { id: goal });
        const [id] = (await initiatives.reconcileResponsibility(grant.id)).proposed;
        const pending = await initiatives.get({ userId: A, id });
        await initiatives.act({ userId: A, id, action: 'queue', expectedRevision: pending.revision });
        const before = await snapshot();

        let attempts = null;
        let origin = null;
        jest.spyOn(perplexity, 'search').mockImplementation(async () => {
            origin = modelCallScope.current()?.origin;
            attempts = await tryEverything(state);
            return 'results';
        });
        script([call('searchWeb', { query: 'frost' })], [call('finish', { outcome: 'no_change', title: 'Nothing changed' })]);
        const result = await runner.tick({ wait: true });
        expect(result.results[0]).toMatchObject({ status: 'COMPLETED' });

        expect(origin).toBe('loop:searchWeb');
        expect(attempts).toEqual(ALL_HUMAN_ONLY);
        const after = await snapshot();
        for (const [rowId, was] of before) expect(after.get(rowId)).toBe(was);
        expect(after.size).toBe(before.size);
        expect((await initiatives.get({ userId: A, id: state.candidate.id })).status).toBe('CANDIDATE');
        expect((await db.get('SELECT status FROM friendships', {})).status).toBe('pending');
    });

    test('no tool source names the confirmation service or an activating call', () => {
        const core = path.join(__dirname, '..', 'packages', 'core');
        const sources = [];
        for (const dir of [path.join(core, 'utils', 'tools'), path.join(core, 'services', 'assistant', 'runTools')]) {
            for (const name of fs.readdirSync(dir)) if (name.endsWith('.js')) sources.push(path.join(dir, name));
        }
        expect(sources.length).toBeGreaterThan(10);
        const offenders = sources.filter((file) => {
            const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
            return /assistantConfirmationService|keepProposal|\.mint\s*\(|\.redeem\s*\(/.test(text)
                || /action:\s*['"](activate|resume|queue|retry|accept)['"]/.test(text)
                || /activate:\s*true/.test(text);
        });
        expect(offenders.map(file => path.basename(file))).toEqual([]);
    });
});

describe('what are you working on, and why', () => {
    test('the overview is the person\'s own records; another person\'s do not exist', async () => {
        const active = await confirm(await proposed({ title: 'Garden notes' }));
        const open = await initiativeRow({ responsibilityId: active.id, status: 'RUNNING' });
        await access.recordDecision({ scope: 'everyone' });
        await policies.enroll({ userId: B, initiative: 'assist' });
        const theirs = await confirm(await proposed({ title: 'Secret plans of Bo' }, B));

        const overview = await tool('describeDelegatedWork');
        expect(overview).toContain(`#${active.id} "Garden notes" - active (proposed in a conversation); may add generated notes: your knowledge`);
        expect(overview).toContain(`#${open.id} "Check the frost dates" - running`);
        expect(overview).not.toContain('Secret plans of Bo');
        expect(await tool('describeDelegatedWork', { what: 'responsibility', id: theirs.id })).toContain('NOT_FOUND');
        const theirWork = await initiativeRow({ responsibilityId: theirs.id, userId: B });
        expect(await tool('describeDelegatedWork', { what: 'work', id: theirWork.id })).toContain('NOT_FOUND');
        expect(await tool('describeDelegatedWork', {}, webChat(C))).toBe('The person has no responsibilities. Nothing is delegated and nothing is running.');
    });

    test('"why" is answered from the initiative and the run journal, refusals included, without what the run read', async () => {
        const active = await confirm(await proposed({ title: 'Garden notes' }));
        const work = await initiativeRow({ responsibilityId: active.id, status: 'FAILED', reason: 'The goal "garden" changed' });
        await db.run("UPDATE assistant_initiatives SET stopCode = 'PROVIDER_ERROR' WHERE id = @id", { id: work.id });
        await runRecord({
            initiative: work, status: 'FAILED',
            operations: [
                { tool: 'lookupNotes', operation: 'read', resourceKind: 'knowledge', status: 'SUCCEEDED', resultText: 'PRIVATE NOTE TEXT' },
                { tool: 'searchWeb', operation: 'read', resourceKind: 'web', status: 'REFUSED', refusalCode: 'OPERATION_OUT_OF_SCOPE' },
                { tool: 'addNote', operation: 'kg.generated.add', resourceKind: 'knowledge', effect: 'write', status: 'SUCCEEDED', resultText: 'PRIVATE NOTE TEXT' }
            ]
        });
        const why = await tool('describeDelegatedWork', { what: 'work', id: work.id });
        expect(why).toContain('Why it exists: The goal "garden" changed (source: attention_item 41, attempt 1).');
        expect(why).toContain('stop code PROVIDER_ERROR');
        expect(why).toContain('Run: failed; 2 round(s), 1200 tokens, 1 search(es).');
        expect(why).toContain('- lookupNotes (read on knowledge): succeeded');
        expect(why).toContain('- searchWeb (read on web): refused - refused: OPERATION_OUT_OF_SCOPE');
        expect(why).toContain('- addNote (kg.generated.add on knowledge): succeeded');
        expect(why).not.toContain('PRIVATE NOTE TEXT');

        const idle = await initiativeRow({ responsibilityId: active.id, status: 'CANDIDATE' });
        expect(await tool('describeDelegatedWork', { what: 'work', id: idle.id })).toContain('It has not run: there is no run record.');
        const one = await tool('describeDelegatedWork', { what: 'responsibility', id: active.id });
        expect(one).toContain('Each piece of work waits for the person to start it.');
        expect(one).toContain(`#${work.id} "Check the frost dates" - failed`);
    });

    test('what is waiting on the person is listed, with their decision cards in the portal and never a decision', async () => {
        expect(await tool('describeDelegatedWork', { what: 'requests' })).toBe('Nothing is waiting on the person right now.');
        await friends.request({ userId: B, targetId: A });
        const [item] = (await inbox.list({ userId: A, view: 'needs_you' })).items;
        const result = await tool('describeDelegatedWork', { what: 'requests' });
        expect(result._card).toEqual({ kind: 'assistant-requests', refs: [item.decision.ref] });
        expect(result._display).toContain('Bo wants to be friends');
        expect(result._display).toContain('you cannot decide for them');
        const inDm = await tool('describeDelegatedWork', { what: 'requests' }, discordDm());
        expect(typeof inDm).toBe('string');
        expect(inDm).toContain('They decide these on Home or in the Inbox.');
        expect((await db.get('SELECT status FROM friendships', {})).status).toBe('pending');
    });
});

describe('stop that', () => {
    test('cancels the named work and says what its run had already changed', async () => {
        const active = await confirm(await proposed({ title: 'Garden notes' }));
        const work = await initiativeRow({ responsibilityId: active.id, status: 'RUNNING' });
        await runRecord({
            initiative: work,
            operations: [
                { tool: 'lookupNotes', operation: 'read', resourceKind: 'knowledge', status: 'SUCCEEDED' },
                { tool: 'addNote', operation: 'kg.generated.add', resourceKind: 'knowledge', effect: 'write', status: 'SUCCEEDED' },
                { tool: 'addNote', operation: 'kg.generated.add', resourceKind: 'knowledge', effect: 'write', status: 'DISPATCHED' }
            ]
        });
        const result = await tool('controlDelegatedWork', { action: 'cancel', id: work.id });
        expect(result).toContain(`Cancelled work #${work.id} "Check the frost dates" (it was running).`);
        expect(result).toContain('had already made 1 change(s), which stay as they are');
        expect(result).toContain('- addNote (kg.generated.add on knowledge)');
        expect(await initiatives.get({ userId: A, id: work.id })).toMatchObject({ status: 'CANCELLED', stopCode: 'CANCELLED_BY_OWNER', leased: false });

        expect(await tool('controlDelegatedWork', { action: 'cancel', id: work.id })).toContain('is already cancelled; there is nothing to cancel');
        const idle = await initiativeRow({ responsibilityId: active.id, status: 'CANDIDATE' });
        expect(await tool('controlDelegatedWork', { action: 'cancel', id: idle.id })).toContain('It had not started, so nothing was changed.');
    });

    test('pauses a responsibility; resuming it is the person\'s, with a receipt', async () => {
        const active = await confirm(await proposed({ title: 'Garden notes' }));
        const result = await tool('controlDelegatedWork', { action: 'pause', id: active.id });
        expect(result).toContain(`Paused responsibility #${active.id} "Garden notes".`);
        expect(result).toContain('Only the person can resume it');
        expect(await row(active.id)).toMatchObject({ status: 'PAUSED' });

        expect(await tool('controlDelegatedWork', { action: 'resume', id: active.id })).toContain('action must be cancel or pause');
        expect(await tool('controlDelegatedWork', { action: 'pause', id: active.id })).toContain('is paused, not active');
        expect(await row(active.id)).toMatchObject({ status: 'PAUSED' });
        expect((await confirm(await responsibilities.get({ userId: A, id: active.id }), 'resume')).status).toBe('ACTIVE');
    });

    test('it stops only the speaker\'s own work', async () => {
        await access.recordDecision({ scope: 'everyone' });
        await policies.enroll({ userId: B, initiative: 'assist' });
        const theirs = await confirm(await proposed({ title: 'Theirs' }, B));
        const theirWork = await initiativeRow({ responsibilityId: theirs.id, userId: B, status: 'RUNNING' });
        expect(await tool('controlDelegatedWork', { action: 'pause', id: theirs.id })).toContain('NOT_FOUND');
        expect(await tool('controlDelegatedWork', { action: 'cancel', id: theirWork.id })).toContain('NOT_FOUND');
        expect(await row(theirs.id)).toMatchObject({ status: 'ACTIVE' });
        expect((await initiatives.get({ userId: B, id: theirWork.id })).status).toBe('RUNNING');
    });
});

describe('a decision pressed on a chat card', () => {
    async function card() {
        const { request } = await friends.request({ userId: B, targetId: A });
        const [item] = (await inbox.list({ userId: A, view: 'needs_you' })).items;
        return { request, card: item.decision };
    }
    const decide = (shown, extra = {}) => caught(gates.decide({
        userId: A, ref: shown.ref, option: 'accept', occurrence: shown.occurrence, revision: shown.revision, surface: 'chat', ...extra
    }));
    const gateReceipt = async (shown, userId = A) => (await confirmations.mint({
        userId, subject: 'gate', id: shown.ref, action: 'decide', occurrence: shown.occurrence, revision: shown.revision, surface: 'chat'
    })).receipt;
    const status = async (request) => (await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status;

    test('needs the receipt minted for that card, once; Home and the Inbox are unchanged', async () => {
        const { request, card: shown } = await card();
        expect(await decide(shown)).toMatchObject({ code: 'HUMAN_CONFIRMATION_REQUIRED', status: 403 });
        expect(await decide(shown, { receipt: '1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toMatchObject({ code: 'CONFIRMATION_INVALID' });
        expect(await status(request)).toBe('pending');

        const receipt = await gateReceipt(shown);
        expect((await receiptRows())[0]).toMatchObject({
            subjectKind: 'gate', subjectId: shown.ref, action: 'decide', surface: 'chat',
            revision: `${shown.occurrence}:${shown.revision}`, grantHash: confirmations.cardHash(shown)
        });
        expect(await decide(shown, { receipt })).toBeNull();
        expect(await status(request)).toBe('accepted');
        expect((await receiptRows())[0].consumedAt).toBeTruthy();

        // Another request: the spent receipt, and a receipt for the first card, decide nothing.
        await db.run('DELETE FROM friendships', {});
        await db.run('DELETE FROM inbox_items', {});
        const next = await card();
        expect(await decide(next.card, { receipt })).toMatchObject({ code: 'CONFIRMATION_INVALID' });
        expect(await status(next.request)).toBe('pending');
        // The Inbox and Home decide it as before, with no receipt.
        expect(await caught(gates.decide({
            userId: A, ref: next.card.ref, option: 'decline', occurrence: next.card.occurrence, revision: next.card.revision, surface: 'inbox'
        }))).toBeNull();
        expect(await status(next.request)).toBe('declined');
    });

    test('a receipt is not minted for a card that is stale, someone else\'s, or not in a conversation', async () => {
        const { card: shown } = await card();
        expect(await caught(confirmations.mint({
            userId: A, subject: 'gate', id: shown.ref, action: 'decide', occurrence: shown.occurrence, revision: 'earlier', surface: 'chat'
        }))).toMatchObject({ code: 'STALE_GATE', status: 409, details: { current: { ref: shown.ref, state: 'open' } } });
        expect(await caught(gateReceipt(shown, C))).toMatchObject({ code: 'PILOT_ONLY' });
        await access.recordDecision({ scope: 'everyone' });
        expect(await caught(gateReceipt(shown, C))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
        expect(await caught(confirmations.mint({
            userId: A, subject: 'gate', id: shown.ref, action: 'decide', occurrence: shown.occurrence, revision: shown.revision, surface: 'portal'
        }))).toMatchObject({ code: 'INVALID_CONFIRMATION' });
        expect(await caught(confirmations.mint({
            userId: A, subject: 'gate', id: shown.ref, action: 'activate', occurrence: shown.occurrence, revision: shown.revision, surface: 'chat'
        }))).toMatchObject({ code: 'INVALID_CONFIRMATION' });
        expect(await receiptRows()).toEqual([]);
    });

    test('deciding from a card is the owner\'s alone until the pilot decision is recorded, in a conversation as on Home and in the Inbox', async () => {
        const { request } = await friends.request({ userId: A, targetId: B });
        // B is not the owner: the request waits on them with no card to press.
        const [item] = (await inbox.list({ userId: B, view: 'needs_you' })).items;
        expect(item).toMatchObject({ needsAction: true, decision: null, friend: { actionable: true } });
        const asB = (extra) => caught(gates.decide({
            userId: B, ref: `inbox-${item.id}`, option: 'accept', occurrence: 1, revision: request.createdAt, ...extra
        }));
        for (const extra of [{ surface: 'chat', receipt: 'x' }, { surface: 'home' }, { surface: 'inbox' }]) {
            expect(await asB(extra)).toMatchObject({ code: 'PILOT_ONLY', status: 403 });
        }
        expect(await status(request)).toBe('pending');
        // Once the host opens the pilot the card is theirs; a conversation still needs its receipt.
        await access.recordDecision({ scope: 'everyone' });
        const shown = (await inbox.list({ userId: B, view: 'needs_you' })).items[0].decision;
        const decideAsB = (extra) => caught(gates.decide({
            userId: B, ref: shown.ref, option: 'accept', occurrence: shown.occurrence, revision: shown.revision, ...extra
        }));
        expect(await decideAsB({ surface: 'chat' })).toMatchObject({ code: 'HUMAN_CONFIRMATION_REQUIRED' });
        expect(await decideAsB({ surface: 'inbox' })).toBeNull();
        expect(await status(request)).toBe('accepted');
    });
});

describe('the portal API', () => {
    let server;
    let base;
    beforeAll(async () => {
        const app = require('express')();
        app.use(createWebAppApp(createWebAppContext({ gateway: new DisabledGateway(), config: { webapp: { enabled: true, devMode: true } } })));
        server = require('node:http').createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => {
        await new Promise(resolve => server.close(resolve));
    });

    async function cookie(userId) {
        const login = await fetch(`${base}/api/app/auth/dev-session`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, name: userId })
        });
        expect(login.status).toBe(200);
        return login.headers.get('set-cookie').split(';')[0];
    }
    const send = async (method, url, session, body) => {
        const res = await fetch(`${base}${url}`, {
            method,
            headers: { ...(session ? { Cookie: session } : {}), 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const root = '/api/app/assistant/responsibilities';
    const confirmUrl = '/api/app/assistant/confirmations';

    test('a proposal is confirmed by its owner\'s session: mint, then the action route spends it', async () => {
        const own = await cookie(A);
        const other = await cookie(B);
        const draft = await proposed();
        const url = `${root}/${draft.id}`;
        const want = { subject: 'responsibility', id: draft.id, action: 'activate', revision: 1, surface: 'chat' };

        expect((await send('POST', confirmUrl, null, want)).status).toBe(401);
        expect((await send('POST', confirmUrl, other, want)).status).toBe(403);
        await access.recordDecision({ scope: 'everyone' });
        expect(await send('POST', confirmUrl, other, { ...want, userId: A })).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
        expect(await send('POST', confirmUrl, own, { ...want, revision: 4 })).toMatchObject({ status: 409, body: { error: { code: 'REVISION_CONFLICT' } } });
        expect(await send('POST', confirmUrl, own, { ...want, surface: 'model' })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_CONFIRMATION' } } });

        // The list marks it, so the page knows to ask for a confirmation.
        const listed = await send('GET', root, own);
        expect(listed.body.responsibilities[0]).toMatchObject({ id: draft.id, proposedBy: 'model', proposal: { conversation: `web:${A}:study-1`, keptAt: null } });

        const none = await send('POST', `${url}/actions`, own, { action: 'activate', expectedRevision: 1 });
        expect(none).toMatchObject({ status: 403, body: { error: { code: 'HUMAN_CONFIRMATION_REQUIRED' } } });
        const minted = await send('POST', confirmUrl, own, want);
        expect(minted).toMatchObject({ status: 200, body: { surface: 'chat', shown: { id: draft.id, operations: [KG_ADD], revision: 1 } } });
        // The other person's session cannot spend it.
        expect((await send('POST', `${url}/actions`, other, { action: 'activate', expectedRevision: 1, receipt: minted.body.receipt })).status).toBe(404);
        const activated = await send('POST', `${url}/actions`, own, { action: 'activate', expectedRevision: 1, receipt: minted.body.receipt });
        expect(activated).toMatchObject({ status: 200, body: { responsibility: { status: 'ACTIVE', revision: 2 } } });
        const replay = await send('POST', `${url}/actions`, own, { action: 'activate', expectedRevision: 2, receipt: minted.body.receipt });
        expect(replay.status).toBe(409);

        // Pausing needs nothing; resuming needs a new receipt.
        expect((await send('POST', `${url}/actions`, own, { action: 'pause', expectedRevision: 2 })).status).toBe(200);
        expect((await send('POST', `${url}/actions`, own, { action: 'resume', expectedRevision: 3, receipt: minted.body.receipt })).body.error.code).toBe('CONFIRMATION_INVALID');
        const again = await send('POST', confirmUrl, own, { ...want, action: 'resume', revision: 3, surface: 'portal' });
        expect((await send('POST', `${url}/actions`, own, { action: 'resume', expectedRevision: 3, receipt: again.body.receipt })).body.responsibility.status).toBe('ACTIVE');
    });

    test('every activation and resume through the route is confirmed, whoever wrote the draft; create is always a draft', async () => {
        const own = await cookie(A);
        const immediate = await send('POST', root, own, { title: 'Now', operations: [KG_ADD], activate: true });
        expect(immediate).toMatchObject({ status: 403, body: { error: { code: 'HUMAN_CONFIRMATION_REQUIRED' } } });
        expect(await allRows()).toEqual([]);

        const created = await send('POST', root, own, { title: 'Mine', operations: [KG_ADD], proposedBy: 'model' });
        expect(created.body.responsibility).toMatchObject({ status: 'DRAFT', proposedBy: null });
        const url = `${root}/${created.body.responsibility.id}`;
        expect((await send('POST', `${url}/actions`, own, { action: 'activate', expectedRevision: 1 })).body.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
        const minted = await send('POST', confirmUrl, own, { subject: 'responsibility', id: created.body.responsibility.id, action: 'activate', revision: 1, surface: 'portal' });
        expect((await send('POST', `${url}/actions`, own, { action: 'activate', expectedRevision: 1, receipt: minted.body.receipt })).body.responsibility.status).toBe('ACTIVE');
        expect((await send('POST', `${url}/proposal`, own, { action: 'discard', expectedRevision: 2 })).body.error.code).toBe('INVALID_TRANSITION');
    });

    test('keep and discard answer a proposal without turning it on', async () => {
        const own = await cookie(A);
        const other = await cookie(B);
        const kept = await proposed({ title: 'Later' });
        expect((await send('POST', `${root}/${kept.id}/proposal`, other, { action: 'keep', expectedRevision: 1 })).status).toBe(404);
        expect((await send('POST', `${root}/${kept.id}/proposal`, own, { action: 'activate', expectedRevision: 1 })).body.error.code).toBe('INVALID_ACTION');
        const keep = await send('POST', `${root}/${kept.id}/proposal`, own, { action: 'keep', expectedRevision: 1 });
        expect(keep.body.responsibility).toMatchObject({ status: 'DRAFT', proposal: { keptAt: expect.any(String) } });

        const declined = await proposed({ title: 'No' });
        expect((await send('POST', `${root}/${declined.id}/proposal`, own, { action: 'discard', expectedRevision: 1 })).body).toEqual({ discarded: true, id: declined.id });
        expect((await send('GET', `${root}/${declined.id}`, own)).status).toBe(404);
    });

    test('a chat card reads its request and decides it with the receipt minted for it', async () => {
        const own = await cookie(A);
        const other = await cookie(C);
        const { request } = await friends.request({ userId: B, targetId: A });
        const [item] = (await inbox.list({ userId: A, view: 'needs_you' })).items;
        const ref = item.decision.ref;

        const read = await send('GET', `/api/app/assistant/gates/${ref}`, own);
        expect(read).toMatchObject({ status: 200, body: { card: item.decision } });
        expect((await send('GET', `/api/app/assistant/gates/${ref}`, other)).status).toBe(404);

        const body = { option: 'accept', occurrence: read.body.card.occurrence, revision: read.body.card.revision, surface: 'chat' };
        expect(await send('POST', `/api/app/assistant/gates/${ref}/decide`, own, body))
            .toMatchObject({ status: 403, body: { error: { code: 'HUMAN_CONFIRMATION_REQUIRED' } } });
        const minted = await send('POST', confirmUrl, own, {
            subject: 'gate', id: ref, action: 'decide', occurrence: body.occurrence, revision: body.revision, surface: 'chat'
        });
        expect(minted).toMatchObject({ status: 200, body: { shown: item.decision } });
        const decided = await send('POST', `/api/app/assistant/gates/${ref}/decide`, own, { ...body, receipt: minted.body.receipt });
        expect(decided).toMatchObject({ status: 200, body: { decided: { option: 'accept' }, current: { state: 'resolved' } } });
        expect((await db.get('SELECT status FROM friendships WHERE id = @id', { id: request.id })).status).toBe('accepted');
        expect((await send('GET', `/api/app/assistant/gates/${ref}`, own)).body.card).toMatchObject({ state: 'resolved', options: [] });
    });
});
