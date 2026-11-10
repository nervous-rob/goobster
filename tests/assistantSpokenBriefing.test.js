/**
 * The spoken briefing (DA-7c; documentation/delegated_conversation.md,
 * "Hearing a briefing").
 *
 * The properties this suite exists for: a spoken briefing reports the same
 * counts as Home, and hearing it acknowledges nothing. Also under test:
 * it names what is waiting on the person and at most three findings; a
 * section Home could not read is said to be unknown, never zero; it is
 * words only; it is heard only in the person's own voice session (never a
 * Discord voice channel, a shared table, a written turn, incognito, an
 * unattended turn, or an account outside the pilot); and it travels the
 * existing voice paths: the portal's spoken chat turn and the Discord
 * voice session's turn loop.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-briefing-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// The turns below are scripted. No provider is configured, so nothing in
// the chat pipeline (memory, titles, search) can reach one either.
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY', 'ELEVENLABS_API_KEY'];
const savedKeys = Object.fromEntries(PROVIDER_KEYS.map(name => [name, process.env[name]]));
for (const name of PROVIDER_KEYS) delete process.env[name];

// A voice session plays its cues through a real audio player; not here.
jest.mock('@goobster/core/services/voice/notificationSounds', () => ({
    playResponseCue: jest.fn().mockResolvedValue(true),
    playToolCue: jest.fn().mockResolvedValue(true),
    playErrorCue: jest.fn().mockResolvedValue(true)
}));

const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const { isIncognitoToolBlocked } = require('@goobster/core/utils/toolPrivacy');
const assistantTools = require('@goobster/core/utils/tools/assistant');
const briefing = require('@goobster/core/services/assistant/spokenBriefing');
const home = require('@goobster/core/services/assistantHomeService');
const updates = require('@goobster/core/services/assistantUpdateService');
const inbox = require('@goobster/core/services/inboxService');
const friends = require('@goobster/core/services/friendService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const access = require('@goobster/core/services/assistantAccessService');
const steward = require('@goobster/core/services/assistantStewardService');
const policies = require('@goobster/core/services/attentionPolicyService');
const identityService = require('@goobster/core/services/identityService');
const identityConfig = require('@goobster/core/config/identityConfig');
const instanceState = require('@goobster/core/services/instanceStateService');
const eventBusService = require('@goobster/core/services/eventBusService');
const voiceSessionService = require('@goobster/core/services/voice/voiceSessionService');
const { VOICE_TOOL_NAMES } = require('@goobster/core/services/voice/voiceTurnShared');
const { createWebAppApp, createWebAppContext } = require('@goobster/core/web/appApi');
const { DisabledGateway } = require('@goobster/core/gateway');
const { useState } = require('./helpers/featureFixtures');

/** The installation's owner: the one account the pilot gate lets through. */
const A = '770000000000000001';
/** An ordinary account. */
const B = '770000000000000002';
const GUILD = '770000000000000900';
const TOOL = 'spokenBriefing';
const KG_ADD = { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } };

const TABLES = [
    'assistant_update_receipts', 'assistant_updates', 'assistant_process_observations', 'assistant_initiatives',
    'assistant_responsibility_revisions', 'assistant_responsibilities', 'attention_policies', 'inbox_items',
    'friendships', 'web_sessions', 'web_rate_events', 'auth_identities', 'app_accounts', 'principals'
];

const requireAccount = identityConfig.requireAccount;
let lastSession = null;

afterAll(async () => {
    useState();
    identityConfig.requireAccount = requireAccount;
    for (const name of PROVIDER_KEYS) if (savedKeys[name] !== undefined) process.env[name] = savedKeys[name];
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

beforeEach(async () => {
    useState();
    jest.restoreAllMocks();
    identityConfig.requireAccount = false;
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`, {});
    await instanceState.remove(access.KEY_PILOT);
    await instanceState.remove(steward.HEARTBEAT_KEY);
    for (const [id, name] of [[A, 'Ada'], [B, 'Bo']]) {
        await identityService.ensureLegacyPrincipal({ discordId: id, displayName: name });
    }
    await identityService.grantAccount({ principalId: A, entitlement: 'bootstrap', role: 'operator' });
});

afterEach(() => {
    // A voice turn schedules its next silence window; none may outlive the test.
    if (lastSession) voiceSessionService._cancelTurnTimer(lastSession);
    lastSession = null;
});

/** A turn of the person's own voice chat in the portal. */
const voiceChat = (userId = A, extra = {}) => ({
    user: { id: userId, username: 'person' }, guildId: null, channelId: `web:${userId}:study-1`,
    channel: { id: `web:${userId}:study-1` }, spoken: true, ...extra
});
/** The same conversation, typed. */
const writtenChat = (userId = A) => voiceChat(userId, { spoken: false });
/** What a Discord voice session hands its tools (voiceTurnShared.buildToolContext). */
const guildVoice = (userId = A) => ({
    user: { id: userId, username: 'person' }, member: { user: { id: userId } }, guildId: GUILD, guild: { id: GUILD },
    channelId: '770000000000000777', channel: { id: '770000000000000777' }, isVoiceInteraction: true
});
/** A voice turn at somebody else's shared table. */
const sharedTable = (userId = A) => ({
    user: { id: userId, username: 'person' }, guildId: null, channelId: `web:parlor:${B}:9`, channel: { id: `web:parlor:${B}:9` }, spoken: true
});

const tool = (context = voiceChat()) => toolsRegistry.execute(TOOL, { interactionContext: context });
const utc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const beat = (date = new Date()) => instanceState.set(steward.HEARTBEAT_KEY, { at: date.toISOString() });

async function active(userId = A, title = 'Keep my garden notes current') {
    await policies.enroll({ userId, initiative: 'assist' });
    const { responsibility } = await responsibilities.create({ userId, body: { title, operations: [KG_ADD] } });
    return (await responsibilities.act({ userId, id: responsibility.id, action: 'activate', expectedRevision: responsibility.revision })).responsibility;
}

const finding = (overrides = {}) => updates.publish({
    audience: { userId: A }, identityKey: 'finding:frost', kind: 'finding', title: 'Frost expected Thursday',
    summary: 'Cover the seedlings. The forecast changed overnight.', components: ['research', 'knowledge'], deliver: true, ...overrides
});

const gate = (overrides = {}) => finding({
    identityKey: 'repair:import', kind: 'question', title: 'Nightly import: review the repair', summary: null,
    components: ['processes'], gate: { kind: 'process_repair', id: 'automation:5' }, ...overrides
});

/**
 * A full Home: one request and one friend request waiting, four findings,
 * one piece of work running and one process failing.
 */
async function busyHome() {
    const grant = await active();
    await beat();
    await gate();
    await friends.request({ userId: B, userName: 'Bo', targetId: A });
    const titles = ['Frost expected Thursday', 'Seed order arrived', 'Compost is ready', 'Rain gauge replaced'];
    for (const [index, title] of titles.entries()) {
        await finding({ identityKey: `finding:${index}`, title, summary: `Detail ${index + 1} of the finding. A second sentence.` });
    }
    await db.run(
        `INSERT INTO assistant_initiatives
            (responsibilityId, responsibilityRevision, ownerUserId, actingUserId, sourceKind, sourceId, sourceRevision,
             dedupeKey, title, status, leaseToken, leaseExpiresAt)
         VALUES (@rid, @rev, @owner, @owner, 'project_plan', '1', 'a', 'k1', 'Advance the plan', 'RUNNING', 't', @later)`,
        { rid: grant.id, rev: grant.revision, owner: A, later: utc(new Date(Date.now() + 5 * 60000)) }
    );
    await db.run(
        `INSERT INTO assistant_process_observations (ownerUserId, processKind, processId, occurrenceKey, phase, outcome, observedAt)
         VALUES (@owner, 'automation', '5', 'fire:2', 'outcome', 'failed', @at)`,
        { owner: A, at: utc(new Date()) }
    );
    return { grant, titles };
}

/** Everything a person's review state is made of. Delivery is not part of it. */
async function reviewState() {
    return JSON.stringify({
        updates: await db.all('SELECT id, materialRevision, gateResolvedAt, envelopeRevision, inboxItemId, updatedAt FROM assistant_updates ORDER BY id', {}),
        receipts: await db.all('SELECT updateId, userId, acknowledgedRevision, snoozedUntil FROM assistant_update_receipts WHERE acknowledgedRevision > 0 OR snoozedUntil IS NOT NULL ORDER BY updateId, userId', {}),
        inbox: await db.all('SELECT id, userId, title, readAt, archivedAt FROM inbox_items ORDER BY id', {}),
        friendships: await db.all('SELECT * FROM friendships ORDER BY 1', {}),
        responsibilities: await db.all('SELECT id, status, revision FROM assistant_responsibilities ORDER BY id', {}),
        initiatives: await db.all('SELECT id, status, revision FROM assistant_initiatives ORDER BY id', {})
    });
}

/** What Home shows, without the moment it was read. */
const shown = (view) => ({
    availability: view.availability, counts: view.counts, components: view.components,
    needsYou: view.needsYou, brief: view.brief, responsibilities: view.responsibilities
});

describe('the briefing says what Home shows', () => {
    test('the same counts as Home, the titles under Needs you, and the three newest findings', async () => {
        const { titles } = await busyHome();
        const view = await home.project({ userId: A });
        expect(view.counts).toEqual({ unseen: 5, needsAction: 2, running: 1 });
        expect(view.components.find(c => c.id === 'processes').blocked).toBe(1);

        const spoken = await briefing.brief({ userId: A });
        expect(spoken.counts).toEqual({ ...view.counts, blocked: 1 });
        expect(spoken.text).toContain('I am looking after one responsibility.');
        expect(spoken.text).toContain('Two things need you.');
        expect(spoken.text).toContain('You have five updates you have not reviewed.');
        expect(spoken.text).toContain('One piece of work is running.');
        expect(spoken.text).toContain('One of your processes is failing or blocked.');

        // Needs you: exactly the titles Home previews, in Home's order.
        expect(spoken.needsYou).toEqual(view.needsYou.map(item => item.title));
        expect(spoken.needsYou).toHaveLength(2);
        expect(spoken.needsYou).toContain('Nightly import: review the repair');
        for (const title of spoken.needsYou) expect(spoken.text).toContain(title);

        // Findings: Home's first three, each with its first sentence; the fourth is left on Home.
        expect(view.brief.map(item => item.title)).toEqual([...titles].reverse());
        expect(spoken.findings.map(item => item.title)).toEqual(view.brief.slice(0, 3).map(item => item.title));
        expect(spoken.text).toContain('The newest findings: Rain gauge replaced. Detail 4 of the finding.');
        expect(spoken.text).not.toContain('A second sentence');
        expect(spoken.text).not.toContain('Frost expected Thursday');
        expect(spoken.text).toContain('There are more on Home.');
        // Fresh, so nothing is said about freshness.
        expect(spoken.text).not.toContain('last checked');
    });

    test('through the tool it is the same briefing, with the instruction to say it as given', async () => {
        await busyHome();
        const expected = (await briefing.brief({ userId: A })).text;
        const result = await tool();
        expect(typeof result).toBe('string');
        expect(result).toContain(expected);
        expect(result).toContain('keep every number and every title exactly');
        expect(result).toContain('marked nothing as seen and decided nothing');
    });

    test('hearing it acknowledges nothing: Home and the Inbox are the same afterwards', async () => {
        await busyHome();
        // One finding with no Inbox envelope, so it has never been delivered at all.
        const { update: quiet } = await finding({ identityKey: 'finding:quiet', title: 'Greenhouse vent sticks', summary: null, deliver: false });
        const acknowledge = jest.spyOn(updates, 'acknowledge');
        const acknowledgeInbox = jest.spyOn(updates, 'acknowledgeInboxRevision');
        const snooze = jest.spyOn(updates, 'snooze');
        const before = await reviewState();
        const homeBefore = shown(await home.project({ userId: A }));
        const inboxBefore = await inbox.list({ userId: A, view: 'needs_you' });

        const first = await tool();
        const second = await tool();
        expect(second).toBe(first);
        expect(first).toContain('Greenhouse vent sticks');

        expect(await reviewState()).toBe(before);
        expect(shown(await home.project({ userId: A }))).toEqual(homeBefore);
        const inboxAfter = await inbox.list({ userId: A, view: 'needs_you' });
        expect(inboxAfter.needsYou).toBe(inboxBefore.needsYou);
        expect(inboxAfter.items.map(item => [item.id, item.read])).toEqual(inboxBefore.items.map(item => [item.id, item.read]));
        expect(acknowledge).not.toHaveBeenCalled();
        expect(acknowledgeInbox).not.toHaveBeenCalled();
        expect(snooze).not.toHaveBeenCalled();
        expect(await db.get('SELECT COUNT(*) AS n FROM assistant_update_receipts WHERE acknowledgedRevision > 0', {})).toMatchObject({ n: 0 });

        // It was delivered, and only that: the finding is still unseen.
        expect(await db.get('SELECT acknowledgedRevision, deliveredRevision FROM assistant_update_receipts WHERE updateId = @id AND userId = @userId', { id: quiet.id, userId: A }))
            .toMatchObject({ acknowledgedRevision: 0, deliveredRevision: 1 });
        const listed = (await updates.list({ userId: A })).updates.find(update => update.id === quiet.id);
        expect(listed).toMatchObject({ unseen: true, deliveredRevision: 1, acknowledgedRevision: 0 });
        // What it did not say, it did not deliver.
        const unsaid = (await home.project({ userId: A })).brief[3];
        expect(first).not.toContain(unsaid.title);
    });

    test('a briefing that cannot record delivery is still the briefing', async () => {
        await busyHome();
        jest.spyOn(updates, 'markDelivered').mockRejectedValue(new Error('database is busy'));
        expect(await tool()).toContain('Two things need you.');
    });

    test('a section Home could not read is said to be unknown, never zero', async () => {
        await busyHome();
        jest.spyOn(updates, 'summary').mockRejectedValue(new Error('no such table'));
        let spoken = await briefing.brief({ userId: A });
        expect(spoken.counts.unseen).toBeNull();
        expect(spoken.partial).toContain('updates');
        expect(spoken.text).toContain('I could not read your updates just now.');
        expect(spoken.text).not.toContain('nothing new');
        expect(spoken.text).toContain('Some of this could not be read just now');
        // What could be read is still said.
        expect(spoken.text).toContain('Two things need you.');

        jest.restoreAllMocks();
        jest.spyOn(inbox, 'list').mockRejectedValue(new Error('locked'));
        spoken = await briefing.brief({ userId: A });
        expect(spoken.counts.needsAction).toBeNull();
        expect(spoken.needsYou).toEqual([]);
        expect(spoken.text).toContain('I could not read what is waiting on you just now.');
        expect(spoken.text).not.toContain('Nothing is waiting on you');
    });

    test('more requests than Home previews are counted, and the rest are left to the Inbox', async () => {
        await active();
        await beat();
        for (let n = 1; n <= 7; n += 1) await gate({ identityKey: `repair:${n}`, title: `Repair number ${n}`, gate: { kind: 'process_repair', id: `automation:${n}` } });
        const view = await home.project({ userId: A });
        const spoken = await briefing.brief({ userId: A });
        expect(view.counts.needsAction).toBe(7);
        expect(spoken.text).toContain('Seven things need you.');
        expect(spoken.needsYou).toHaveLength(view.needsYou.length);
        expect(spoken.needsYou).toHaveLength(briefing.MAX_NEEDS_YOU);
        expect(spoken.text).toContain('And two more in your Inbox.');
        // A request is not repeated as a finding.
        expect(spoken.findings).toEqual([]);
        expect(spoken.text).not.toContain('newest finding');
    });

    test('each state of Home has its own words', async () => {
        // Nobody enrolled: Attention is off.
        expect((await briefing.brief({ userId: A })).text)
            .toBe('Attention is off, so nothing is delegated and no new work starts. Nothing is waiting on you. There is nothing new that you have not reviewed.');
        await policies.enroll({ userId: A, initiative: 'assist' });
        expect((await briefing.brief({ userId: A })).text).toContain('Nothing is delegated yet.');

        const grant = await active();
        // The steward has not passed yet: freshness is unknown, and said.
        expect((await briefing.brief({ userId: A })).text)
            .toBe('I am looking after one responsibility. Nothing is waiting on you. There is nothing new that you have not reviewed. '
                + 'Nothing is running right now. This has not been checked yet since the installation started.');
        const now = new Date();
        await beat(new Date(now.getTime() - 40 * 60000));
        expect((await briefing.brief({ userId: A, now })).text).toContain('This was last checked 40 minutes ago, so it may be out of date.');
        await beat(new Date(now.getTime() - 26 * 3600000));
        expect((await briefing.brief({ userId: A, now })).text).toContain('This was last checked 26 hours ago');
        await beat(now);
        expect((await briefing.brief({ userId: A, now })).text).not.toContain('checked');

        await responsibilities.act({ userId: A, id: grant.id, action: 'pause', expectedRevision: grant.revision });
        const paused = (await briefing.brief({ userId: A })).text;
        expect(paused).toContain('One responsibility is paused or waiting for review, and nothing is running.');
        expect(paused).not.toContain('Nothing is running right now.');
    });

    test('compose is a function of the projection alone', () => {
        const projection = {
            availability: 'ready', hostPaused: true, freshness: { state: 'current', lastPassAt: null },
            responsibilities: { counts: { active: 2, paused: 0, needsReview: 0, draft: 0 }, items: [] },
            counts: { unseen: 14, needsAction: 1, running: 0 },
            components: [{ id: 'processes', blocked: 3 }],
            needsYou: [{ title: 'Approve the plan', update: { id: 4, revision: 2 } }],
            brief: [{ id: 9, revision: 3, title: 'A finding', summary: 'A finding' }],
            partial: []
        };
        const spoken = briefing.compose(projection);
        expect(spoken.text).toBe('The host has stopped all delegated work for now. Nothing is lost, and it continues when they resume it. '
            + 'One thing needs you. It is: Approve the plan. You have 14 updates you have not reviewed. The newest finding: A finding. '
            + 'Three of your processes are failing or blocked.');
        expect(spoken.mentioned).toEqual([{ id: 4, revision: 2 }, { id: 9, revision: 3 }]);
        expect(briefing.compose(projection).text).toBe(spoken.text);

        // The feature off: the Inbox's own requests are still counted, and nothing else is claimed.
        const off = briefing.compose({
            availability: 'unavailable', freshness: { state: 'unknown', lastPassAt: null }, responsibilities: { counts: null, items: [] },
            counts: { unseen: null, needsAction: 0, running: null }, components: [], needsYou: [], brief: [], partial: []
        });
        expect(off.text).toBe('Delegated work is turned off on this installation. Nothing is waiting on you.');
        const unread = briefing.compose({
            availability: 'unknown', freshness: { state: 'unknown', lastPassAt: null }, responsibilities: { counts: null, items: [] },
            counts: { unseen: null, needsAction: null, running: null }, components: [], needsYou: [], brief: [], partial: ['responsibilities', 'updates']
        });
        expect(unread.text).toContain('I could not read the state of your responsibilities just now.');
        expect(unread.text).toContain('I could not read what is running just now.');
        expect(unread.text).not.toMatch(/\b(no|nothing|zero)\b/i);
    });

    test('it is words only: no link, markup or line break reaches the voice', async () => {
        await active();
        await beat();
        await finding({
            identityKey: 'finding:markup',
            title: '**Frost** on [the allotment](https://example.com/plots/41) `tonight`\nsee https://example.com/forecast?day=4',
            summary: `# Cover up\n- ${'the seedlings and the beans '.repeat(20)}`
        });
        const spoken = await briefing.brief({ userId: A });
        expect(spoken.findings[0].title).toBe('Frost on the allotment tonight see');
        expect(spoken.text).toContain('The newest finding: Frost on the allotment tonight see. Cover up');
        expect(spoken.text).not.toMatch(/https?:|example\.com|[*`#\n[\]]/);
        // A long summary is cut at a word, not read out whole.
        expect(spoken.text.length).toBeLessThan(600);
    });
});

describe('who may hear it', () => {
    /** Reads that would show the tool looked before refusing. */
    const spies = () => [jest.spyOn(home, 'project'), jest.spyOn(inbox, 'list'), jest.spyOn(updates, 'list'), jest.spyOn(updates, 'markDelivered')];
    const untouched = (watching) => { for (const spy of watching) expect(spy).not.toHaveBeenCalled(); };

    test('a Discord voice channel is shared: it is refused there before anything is read, and says nothing', async () => {
        await busyHome();
        const before = await reviewState();
        const delivered = () => db.all('SELECT updateId, deliveredRevision FROM assistant_update_receipts WHERE userId = @userId ORDER BY updateId', { userId: A });
        const deliveredBefore = await delivered();
        const watching = spies();
        for (const context of [guildVoice(), sharedTable()]) {
            const result = await tool(context);
            expect(result).toContain('A briefing is private.');
            expect(result).toContain('their own voice chat in the portal');
            expect(result).not.toMatch(/Nightly import|Rain gauge|need you|updates you have not/);
        }
        untouched(watching);
        expect(await reviewState()).toBe(before);
        // Not even delivery is recorded: only the Inbox envelopes filed at publication.
        expect(await delivered()).toEqual(deliveredBefore);
    });

    test('it is for a spoken turn: a written one is sent to the tool that answers in writing', async () => {
        await busyHome();
        const watching = spies();
        const result = await tool(writtenChat());
        expect(result).toContain('this turn is written');
        expect(result).toContain('describeDelegatedWork');
        untouched(watching);
    });

    test('incognito and unattended turns hear nothing', async () => {
        await busyHome();
        const watching = spies();
        const incognito = voiceChat(A, { skipHistory: true });
        expect(isIncognitoToolBlocked(TOOL, incognito)).toBe(true);
        expect(await tool(incognito)).toBe('❌ Delegated work is not read or changed in incognito. Use a regular chat for this.');
        // A caller that skipped the registry meets the same answer.
        expect(await assistantTools[TOOL].execute({ interactionContext: incognito }))
            .toBe('❌ Delegated work is not read or changed in incognito. Use a regular chat for this.');
        expect(await tool(voiceChat(A, { isAutomation: true }))).toContain('This is an unattended turn');
        expect(await tool({ spoken: true })).toContain('needs a known person');
        untouched(watching);
    });

    test('it is the owner\'s alone until the pilot decision is recorded', async () => {
        await active(B);
        await finding({ audience: { userId: B }, identityKey: 'finding:b', title: 'Bo\'s finding' });
        const watching = spies();
        const refused = await tool(voiceChat(B));
        expect(refused).toContain('PILOT_ONLY');
        expect(refused).not.toContain('Bo\'s finding');
        untouched(watching);

        await access.recordDecision({ scope: 'everyone' });
        const allowed = await tool(voiceChat(B));
        expect(allowed).toContain('Bo\'s finding');
        // And it is that person's Home, nobody else's.
        await busyHome();
        expect(await tool(voiceChat(B))).not.toMatch(/Nightly import|Rain gauge/);
        expect(await tool(voiceChat(A))).not.toContain('Bo\'s finding');
    });

    test('with the feature off it is refused, and it is not offered', async () => {
        await busyHome();
        useState({ inactive: ['assistant'] });
        expect(await tool()).toMatchObject({ ok: false, code: 'FEATURE_UNAVAILABLE', feature: 'assistant' });
        expect(await assistantTools[TOOL].execute({ interactionContext: voiceChat() })).toBe('❌ Delegated work is not available on this installation.');
        expect((await toolsRegistry.getDefinitions(undefined, { isWeb: true })).map(def => def.name)).not.toContain(TOOL);
    });

    test('it is offered only on a spoken turn, to a person who could hear it', async () => {
        const offered = async (context, options) => (await toolsRegistry.offeredTo(await toolsRegistry.getDefinitions(undefined, options), context))
            .map(def => def.name).includes(TOOL);
        expect(await offered(voiceChat(A), { isWeb: true })).toBe(true);
        expect(await offered(writtenChat(A), { isWeb: true })).toBe(false);
        // A voice channel still gets it, so the answer there is "that is private".
        expect(await offered(guildVoice(A), {})).toBe(true);
        expect(await offered(voiceChat(B), { isWeb: true })).toBe(false);
        expect(await offered(guildVoice(B), {})).toBe(false);
        expect(await offered(voiceChat(A, { skipHistory: true }), { isWeb: true })).toBe(false);
        expect(await offered(voiceChat(A, { isAutomation: true }), { isWeb: true, isAutomation: true })).toBe(false);
        expect((await toolsRegistry.getDefinitions(undefined, { isAutomation: true })).map(def => def.name)).not.toContain(TOOL);
        await access.recordDecision({ scope: 'everyone' });
        expect(await offered(voiceChat(B), { isWeb: true })).toBe(true);
        expect(assistantTools.TOOL_NAMES).toContain(TOOL);
    });

    test('the tool takes no arguments: nothing a model passes changes whose Home it reads', async () => {
        await busyHome();
        const plain = await tool();
        const forged = await toolsRegistry.execute(TOOL, { userId: B, acknowledge: true, markReviewed: true, limit: 50, interactionContext: voiceChat() });
        expect(forged).toBe(plain);
        expect(assistantTools[TOOL].definition.parameters.properties).toEqual({});
    });
});

describe('the Discord voice session', () => {
    /** A /voicechat session in a guild's voice channel, mid-turn (voiceToolCalls.test.js). */
    function session(userId, text) {
        lastSession = {
            guildId: GUILD,
            voiceChannel: { name: 'General', guild: { id: GUILD } },
            textChannel: { id: '770000000000000778', send: jest.fn().mockResolvedValue(undefined) },
            connection: {},
            ttsService: { textToSpeech: jest.fn().mockResolvedValue(undefined) },
            client: { user: { id: 'bot', username: 'Goobster' } },
            mode: 'open', lastBotSpokeAt: 0, botNames: ['goobster'], history: [],
            turnBuffer: [{ speakerName: 'Ada', text, at: Date.now(), userId, member: { user: { id: userId, username: 'ada', bot: false }, displayName: 'Ada' } }],
            turnTimer: null, responding: false, staleDiscards: 0, activeCaptures: new Set(), speakers: new Map(), stopped: false
        };
        return lastSession;
    }

    test('asked for a briefing in a voice channel, the tool refuses and nothing private is spoken or posted', async () => {
        await busyHome();
        const before = await reviewState();
        jest.spyOn(aiService, 'supportsNativeWebSearch').mockReturnValue(false);
        jest.spyOn(aiService, 'generateText').mockResolvedValue('');
        const chat = jest.spyOn(aiService, 'chat')
            .mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'b1', name: TOOL, arguments: '{}' }] })
            .mockImplementationOnce(async (messages) => ({ content: messages.find(m => m.role === 'tool').content.includes('A briefing is private') ? 'I only brief you in private.' : 'LEAK', toolCalls: [] }));
        const project = jest.spyOn(home, 'project');

        const voice = session(A, 'Goobster, brief me');
        await voiceSessionService._respondToTurn(voice);

        // The owner's turn was offered the tool; what came back was the refusal.
        expect(chat.mock.calls[0][1].functions.map(f => f.name)).toContain(TOOL);
        const answer = chat.mock.calls[1][0].find(m => m.role === 'tool').content;
        expect(answer).toContain('A briefing is private.');
        expect(answer).not.toMatch(/Nightly import|Rain gauge|need you/);
        expect(project).not.toHaveBeenCalled();
        expect(voice.ttsService.textToSpeech).toHaveBeenCalledWith('I only brief you in private.', voice.voiceChannel, voice.connection, { voiceId: null });
        const posted = voice.textChannel.send.mock.calls.map(([payload]) => payload.content).join('\n');
        expect(posted).toContain('I only brief you in private.');
        expect(posted).not.toMatch(/Nightly import|Rain gauge/);
        expect(await reviewState()).toBe(before);
    });

    test('a speaker outside the pilot is not offered it at all', async () => {
        jest.spyOn(aiService, 'supportsNativeWebSearch').mockReturnValue(false);
        jest.spyOn(aiService, 'generateText').mockResolvedValue('');
        const chat = jest.spyOn(aiService, 'chat').mockResolvedValue({ content: 'Hello.', toolCalls: [] });
        await voiceSessionService._respondToTurn(session(B, 'Goobster, brief me'));
        const offered = chat.mock.calls[0][1].functions.map(f => f.name);
        expect(offered).not.toContain(TOOL);
        expect(offered).toContain('performSearch');
        expect(VOICE_TOOL_NAMES).toContain(TOOL);
    });
});

describe('the portal voice chat', () => {
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
    const homeOf = async (session) => (await (await fetch(`${base}/api/app/home`, { headers: { Cookie: session } })).json()).assistant;
    /** One chat turn through the route the voice chat posts to; resolves when its stream ends. */
    async function say(session, message, spoken) {
        const res = await fetch(`${base}/api/app/chat`, {
            method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, spoken })
        });
        expect(res.status).toBe(200);
        const body = await res.text();
        await settled();
        return body;
    }
    /**
     * A finished turn kicks the person's queue without awaiting it. Wait for
     * that to end, so nothing of the turn is still querying when the suite
     * closes its database.
     */
    async function settled() {
        const webChat = require('../packages/core/services/webChatService');
        for (let quiet = 0, tries = 0; quiet < 3 && tries < 200; tries++) {
            await new Promise(resolve => setTimeout(resolve, 20));
            quiet = webChat._kicking.size === 0 ? quiet + 1 : 0;
        }
    }
    /** The model asks for the briefing if it was offered it, then says what the tool gave it. */
    function scripted() {
        const seen = { offered: [], toolResults: [] };
        jest.spyOn(aiService, 'supportsNativeWebSearch').mockReturnValue(false);
        jest.spyOn(aiService, 'generateText').mockResolvedValue('false');
        jest.spyOn(aiService, 'chat').mockImplementation(async (messages, options = {}) => {
            const names = (options.functions || []).map(definition => definition.name);
            if (!names.length) return { content: 'ok', toolCalls: [] };
            seen.offered.push(names.includes(TOOL));
            const results = messages.filter(m => m.role === 'tool').map(m => m.content);
            if (!results.length && names.includes(TOOL)) return { content: '', toolCalls: [{ id: 'brief-1', name: TOOL, arguments: '{}' }] };
            seen.toolResults.push(...results);
            const said = results.length ? results[0].split('\n')[2] : 'Nothing to say.';
            if (typeof options.onDelta === 'function') options.onDelta(said);
            return { content: said, toolCalls: [] };
        });
        return seen;
    }

    test('a spoken turn hears the counts Home shows, and Home is the same afterwards', async () => {
        await busyHome();
        const session = await cookie(A);
        const before = await homeOf(session);
        expect(before.counts).toEqual({ unseen: 5, needsAction: 2, running: 1 });
        const state = await reviewState();
        const seen = scripted();

        const stream = await say(session, 'Brief me.', true);
        expect(seen.offered[0]).toBe(true);
        expect(seen.toolResults).toHaveLength(1);
        const expected = briefing.compose(await home.project({ userId: A })).text;
        expect(seen.toolResults[0]).toContain(expected);
        // What the person hears: the reply the voice chat reads aloud.
        expect(stream).toContain('Two things need you.');
        expect(stream).toContain('You have five updates you have not reviewed.');
        expect(stream).toContain('One piece of work is running.');

        const after = await homeOf(session);
        expect(after.counts).toEqual(before.counts);
        expect(after.brief).toEqual(before.brief);
        expect(after.needsYou).toEqual(before.needsYou);
        expect(await reviewState()).toBe(state);
    });

    test('a written turn in the same chat is not offered the briefing', async () => {
        await busyHome();
        const session = await cookie(A);
        const seen = scripted();
        await say(session, 'Brief me.', false);
        expect(seen.offered).toEqual([false]);
        expect(seen.toolResults).toEqual([]);
    });
});
