/**
 * Shared-instance Increment C: the assistant exists without Discord.
 *
 * Covers the in-app inbox (persist-first delivery, the Discord echo as
 * bookkeeping, dedupe, read/archive, erasure), the DisabledGateway journey
 * through the portal API (/me reports the installation assistant, inbox
 * and people routes work, Discord-specific routes answer DISCORD_DISABLED),
 * personal follow-up delivery with no client, native people discovery, the
 * core runtime lifecycle with the client absent, and the api service's
 * standalone mode - all against a throwaway database and no network.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');

const TEST_DB = path.join(os.tmpdir(), `goobster-independent-runtime-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const eventBusService = require('@goobster/core/services/eventBusService');
const inboxService = require('@goobster/core/services/inboxService');
const identityService = require('@goobster/core/services/identityService');
const privacyService = require('@goobster/core/services/privacyService');
const followupService = require('@goobster/core/services/followupService');
const followupDeliveryService = require('@goobster/core/services/followupDeliveryService');
const webChatService = require('@goobster/core/services/webChatService');
const aiService = require('@goobster/core/services/aiService');
const discordConfig = require('@goobster/core/config/discordConfig');
const identityConfig = require('@goobster/core/config/identityConfig');
const { assistantUser, isAssistantId } = require('@goobster/core/services/assistantIdentity');
const { DisabledGateway, GatewayDisabledError, isGatewayDisabled, isGatewayUnavailable, toGateway } = require('@goobster/core/gateway');
const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
const { startCoreRuntime } = require('@goobster/core/runtime/coreRuntime');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const DISCORD_USER = '100000000000000001';
const NATIVE_USER = 'usr_0f7f5d0e-1111-4a2b-9c3d-000000000001';
const NATIVE_PEER = 'usr_0f7f5d0e-2222-4a2b-9c3d-000000000002';
const GUILD = '200000000000000001';

const DIST_DIR = path.join(__dirname, '../apps/web/dist');
const DIST_INDEX = path.join(DIST_DIR, 'index.html');
let wroteDistFixture = false;

let server;
let port;

function request({ method = 'GET', reqPath = '/', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1', port, method, path: reqPath,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers
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

async function login(userId, name) {
    const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
    expect(res.status).toBe(200);
    return res.headers['set-cookie'].find(c => c.startsWith('goobster_web_session=')).split(';')[0];
}

async function member(id, displayName, loginName) {
    if (!(await identityService.getPrincipal(id))) {
        if (identityService.isSnowflake(id)) {
            await identityService.ensureLegacyPrincipal({ discordId: id, displayName });
        } else {
            await identityService.createNativePrincipal({ id, displayName });
        }
    }
    await identityService.grantAccount({ principalId: id, entitlement: 'invite', loginName });
}

beforeAll((done) => {
    discordConfig.setEnabledForTests(false);
    if (!fs.existsSync(DIST_INDEX)) {
        fs.mkdirSync(DIST_DIR, { recursive: true });
        fs.writeFileSync(DIST_INDEX, '<!doctype html><html><body><div id="root"></div></body></html>');
        wroteDistFixture = true;
    }
    const ctx = createWebAppContext({
        gateway: new DisabledGateway(),
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: { error: () => {}, warn: () => {}, info: () => {} }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        done();
    });
});

afterAll(async () => {
    discordConfig.setEnabledForTests(undefined);
    await new Promise(resolve => server.close(resolve));
    await eventBusService.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
    if (wroteDistFixture) {
        try { fs.unlinkSync(DIST_INDEX); } catch { /* already gone */ }
        try { fs.rmdirSync(DIST_DIR); } catch { /* dist had other files */ }
    }
});

beforeEach(async () => {
    jest.restoreAllMocks();
    for (const table of ['inbox_items', 'web_generated_files', 'followups', 'web_sessions', 'auth_identities', 'app_accounts', 'principals']) {
        await db.run(`DELETE FROM ${table}`);
    }
});

// ---------------------------------------------------------------------------

describe('assistant identity and the disabled adapter', () => {
    test('the installation assistant is stable, asst_-shaped, and named from config', () => {
        const user = assistantUser();
        expect(user.id).toMatch(/^asst_[A-Za-z0-9._-]+$/);
        expect(user.username).toBe(identityConfig.assistantName);
        expect(isAssistantId(user.id)).toBe(true);
        expect(isAssistantId(DISCORD_USER)).toBe(false);
        expect(assistantUser().id).toBe(user.id);
    });

    test('DisabledGateway refuses Discord reads with a permanent error and never throws on sends', async () => {
        const gateway = new DisabledGateway();
        expect(toGateway(gateway)).toBe(gateway);
        expect(gateway.kind).toBe('disabled');
        expect(await gateway.available()).toBe(false);
        expect((await gateway.botUser()).id).toBe(assistantUser().id);
        await expect(gateway.getGuildMember(GUILD, DISCORD_USER)).rejects.toBeInstanceOf(GatewayDisabledError);
        const error = await gateway.listMutualGuilds(DISCORD_USER).catch(e => e);
        expect(isGatewayDisabled(error)).toBe(true);
        expect(isGatewayUnavailable(error)).toBe(true);
        expect(error.code).toBe('DISCORD_DISABLED');
        expect(await gateway.sendDm(DISCORD_USER, { content: 'hi' })).toEqual({ ok: false, error: 'DISCORD_DISABLED' });
        expect(await gateway.sendToChannel('1', { content: 'hi' })).toEqual({ ok: false, error: 'DISCORD_DISABLED' });
    });

    test('discordConfig explains why the adapter is off', () => {
        expect(discordConfig.enabled).toBe(false);
        expect(typeof discordConfig.disabledReason).toBe('string');
        discordConfig.setEnabledForTests(true);
        expect(discordConfig.enabled).toBe(true);
        expect(discordConfig.disabledReason).toBeNull();
        discordConfig.setEnabledForTests(false);
    });
});

// ---------------------------------------------------------------------------

describe('inboxService', () => {
    test('persists first and records a skipped echo when there is no Discord path', async () => {
        const result = await inboxService.deliver({
            userId: NATIVE_USER, kind: 'task', title: 'Morning brief', body: 'Three things today.',
            source: { type: 'automation', id: 12 }, link: '/tasks'
        });
        expect(result.created).toBe(true);
        expect(result.discord).toEqual({ status: 'skipped', error: null });
        expect(result.item).toEqual(expect.objectContaining({
            kind: 'task', title: 'Morning brief', body: 'Three things today.',
            source: { type: 'automation', id: '12' }, link: '/tasks', read: false, archived: false
        }));
        expect(await inboxService.unreadCount(NATIVE_USER)).toBe(1);
    });

    test('a disabled gateway is a skip, a failed DM is a failure, a delivered DM is sent', async () => {
        const disabled = await inboxService.deliver({
            userId: DISCORD_USER, kind: 'reminder', title: 'A', discord: { gateway: new DisabledGateway() }
        });
        expect(disabled.discord.status).toBe('skipped');
        expect(disabled.discord.error).toBe('DISCORD_DISABLED');

        const closedDms = { isGoobsterGateway: true, sendDm: async () => ({ ok: false, error: 'Cannot send messages to this user' }) };
        const failed = await inboxService.deliver({ userId: DISCORD_USER, kind: 'reminder', title: 'B', discord: { gateway: closedDms } });
        expect(failed.discord.status).toBe('failed');
        expect(failed.discord.error).toMatch(/Cannot send/);

        const sends = [];
        const open = { isGoobsterGateway: true, sendDm: async (id, payload) => { sends.push({ id, payload }); return { ok: true }; } };
        const sent = await inboxService.deliver({ userId: DISCORD_USER, kind: 'reminder', title: 'C', body: 'body', discord: { gateway: open } });
        expect(sent.discord.status).toBe('sent');
        expect(sent.item.discord.sentAt).toBeTruthy();
        expect(sends).toHaveLength(1);
        expect(sends[0].id).toBe(DISCORD_USER);
        expect(sends[0].payload.content).toContain('**C**');

        // A native principal without a linked Discord identity has nowhere to echo to
        const native = await inboxService.deliver({ userId: NATIVE_USER, kind: 'notice', title: 'D', discord: { gateway: open } });
        expect(native.discord).toEqual({ status: 'skipped', error: 'no Discord identity' });
        expect(sends).toHaveLength(1);
    });

    test('the echo follows a native principal\'s linked Discord identity', async () => {
        await identityService.createNativePrincipal({ id: NATIVE_USER, displayName: 'Nat' });
        await db.run(
            `INSERT INTO auth_identities (principalId, provider, issuer, subject) VALUES (@p, 'discord', 'discord', @s)`,
            { p: NATIVE_USER, s: DISCORD_USER }
        );
        const sends = [];
        const open = { isGoobsterGateway: true, sendDm: async (id) => { sends.push(id); return { ok: true }; } };
        const result = await inboxService.deliver({ userId: NATIVE_USER, kind: 'invite', title: 'E', discord: { gateway: open } });
        expect(result.discord.status).toBe('sent');
        expect(sends).toEqual([DISCORD_USER]);
    });

    test('dedupeKey makes redelivery idempotent and never re-echoes', async () => {
        const sends = [];
        const open = { isGoobsterGateway: true, sendDm: async () => { sends.push(1); return { ok: true }; } };
        const first = await inboxService.deliver({ userId: DISCORD_USER, kind: 'watch', title: 'W', dedupeKey: 'watch:7:1', discord: { gateway: open } });
        const second = await inboxService.deliver({ userId: DISCORD_USER, kind: 'watch', title: 'W again', dedupeKey: 'watch:7:1', discord: { gateway: open } });
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.item.id).toBe(first.item.id);
        expect(second.item.title).toBe('W');
        expect(sends).toHaveLength(1);
        expect((await inboxService.list({ userId: DISCORD_USER })).items).toHaveLength(1);
    });

    test('list, read toggle, read-all, archive, and cross-user isolation', async () => {
        const a = (await inboxService.deliver({ userId: NATIVE_USER, kind: 'task', title: 'one' })).item;
        const b = (await inboxService.deliver({ userId: NATIVE_USER, kind: 'task', title: 'two' })).item;
        await inboxService.deliver({ userId: NATIVE_PEER, kind: 'task', title: 'theirs' });

        let list = await inboxService.list({ userId: NATIVE_USER });
        expect(list.items.map(i => i.title)).toEqual(['two', 'one']);
        expect(list.unread).toBe(2);

        expect((await inboxService.markRead({ userId: NATIVE_USER, itemId: a.id })).read).toBe(true);
        expect((await inboxService.list({ userId: NATIVE_USER, unread: true })).items.map(i => i.id)).toEqual([b.id]);
        expect((await inboxService.markRead({ userId: NATIVE_USER, itemId: a.id, read: false })).read).toBe(false);
        expect((await inboxService.markAllRead({ userId: NATIVE_USER })).updated).toBe(2);
        expect(await inboxService.unreadCount(NATIVE_USER)).toBe(0);

        await inboxService.archive({ userId: NATIVE_USER, itemId: b.id });
        expect((await inboxService.list({ userId: NATIVE_USER })).items.map(i => i.id)).toEqual([a.id]);
        expect((await inboxService.list({ userId: NATIVE_USER, archived: true })).items.map(i => i.id)).toEqual([b.id]);

        await expect(inboxService.get({ userId: NATIVE_PEER, itemId: a.id })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
        await expect(inboxService.markRead({ userId: NATIVE_PEER, itemId: a.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(inboxService.archive({ userId: NATIVE_PEER, itemId: a.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(await inboxService.unreadCount(NATIVE_PEER)).toBe(1);
    });

    test('rejects malformed items', async () => {
        await expect(inboxService.deliver({ userId: '', kind: 'task', title: 'x' })).rejects.toMatchObject({ code: 'BAD_USER' });
        await expect(inboxService.deliver({ userId: NATIVE_USER, kind: 'tweet', title: 'x' })).rejects.toMatchObject({ code: 'BAD_KIND' });
        await expect(inboxService.deliver({ userId: NATIVE_USER, kind: 'task', title: '   ' })).rejects.toMatchObject({ code: 'BAD_TITLE' });
    });

    test('unattended attachments survive registry expiry and pruning without exposing paths or another owner', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-inbox-files-'));
        const filePath = path.join(dir, 'overnight.txt');
        fs.writeFileSync(filePath, 'Scheduled report');
        jest.spyOn(require('@goobster/core/utils/chatHandler'), 'handleChatInteraction').mockImplementation(async interaction => {
            await interaction.channel.send({ files: [{ attachment: filePath, name: 'Report.txt' }] });
            await interaction.sendFullResponse('Your report is ready.');
        });
        try {
            const { item } = await require('@goobster/core/services/unattendedTurnService').run({
                userId: NATIVE_USER, prompt: 'Make a report', kind: 'task', title: 'Overnight report',
                gateway: new DisabledGateway()
            });
            expect(item.attachments).toHaveLength(1);
            expect(item.attachments[0].name).toBe('Report.txt');
            expect(JSON.stringify(item)).not.toContain(filePath);
            const oldId = item.attachments[0].url.split('/').pop();
            await db.run("UPDATE web_generated_files SET createdAt = datetime('now', '-7 hours') WHERE id = @id", { id: oldId });
            // Serving an expired URL prunes its row, as does registering
            // another generated file. The Inbox must survive either path.
            expect(await webChatService.getFile(oldId, NATIVE_USER)).toBeNull();

            const reopened = await inboxService.get({ userId: NATIVE_USER, itemId: item.id });
            const renewedId = reopened.attachments[0].url.split('/').pop();
            expect(renewedId).not.toBe(oldId);
            expect(await webChatService.getFile(renewedId, NATIVE_USER)).toMatchObject({ path: filePath });
            expect(await webChatService.getFile(renewedId, NATIVE_PEER)).toBeNull();
            await expect(inboxService.get({ userId: NATIVE_PEER, itemId: item.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });

            await inboxService.deliver({ userId: NATIVE_USER, kind: 'task', title: 'Same report again', attachments: reopened.attachments });
            await db.run('DELETE FROM web_generated_files WHERE userId = @userId', { userId: NATIVE_USER });
            const listed = await inboxService.list({ userId: NATIVE_USER });
            expect(listed.items).toHaveLength(2);
            expect(JSON.stringify(listed)).not.toContain(filePath);
            for (const listedItem of listed.items) {
                const listedAttachment = listedItem.attachments[0];
                expect(Object.keys(listedAttachment).sort()).toEqual(['name', 'url']);
                expect(await webChatService.getFile(listedAttachment.url.split('/').pop(), NATIVE_USER)).toMatchObject({ path: filePath });
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('recovers legacy URL-only attachments before renewing and retains them for later reads', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-inbox-legacy-'));
        try {
            const files = [];
            for (const name of ['first.txt', 'second.txt']) {
                const filePath = path.join(dir, name);
                fs.writeFileSync(filePath, name);
                files.push(await webChatService.registerFile(filePath, NATIVE_USER));
            }
            // Direct insertion models rows written before durable references.
            const id = await db.insert(
                "INSERT INTO inbox_items (userId, kind, title, attachmentsJson) VALUES (@userId, 'task', 'Legacy files', @json)",
                { userId: NATIVE_USER, json: JSON.stringify(files) }
            );
            await db.run("UPDATE web_generated_files SET createdAt = datetime('now', '-7 hours') WHERE userId = @userId", { userId: NATIVE_USER });
            const recovered = await inboxService.get({ userId: NATIVE_USER, itemId: id });
            for (const file of recovered.attachments) {
                expect(await webChatService.getFile(file.url.split('/').pop(), NATIVE_USER)).not.toBeNull();
            }
            await db.run('DELETE FROM web_generated_files WHERE userId = @userId', { userId: NATIVE_USER });
            const reopened = await inboxService.get({ userId: NATIVE_USER, itemId: id });
            for (const file of reopened.attachments) {
                expect(await webChatService.getFile(file.url.split('/').pop(), NATIVE_USER)).not.toBeNull();
            }
            expect(JSON.stringify(reopened)).not.toContain(dir);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('does not trust supplied attachment paths or renew another person\'s file', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-inbox-owner-'));
        try {
            const filePath = path.join(dir, 'private.txt');
            fs.writeFileSync(filePath, 'Private to the original owner');
            const registered = await webChatService.registerFile(filePath, NATIVE_USER);
            const { item } = await inboxService.deliver({
                userId: NATIVE_PEER, kind: 'task', title: 'Untrusted reference',
                attachments: [{ ...registered, file: { userId: NATIVE_PEER, path: filePath } }]
            });
            const stored = await db.get('SELECT attachmentsJson FROM inbox_items WHERE id = @id', { id: item.id });
            expect(stored.attachmentsJson).not.toContain(filePath);
            expect(await webChatService.getFile(registered.url.split('/').pop(), NATIVE_PEER)).toBeNull();
            expect(await webChatService.restoreFileReference({ userId: NATIVE_USER, path: filePath }, NATIVE_PEER)).toBeNull();
            await db.run('DELETE FROM web_generated_files WHERE userId = @userId', { userId: NATIVE_USER });
            await inboxService.get({ userId: NATIVE_PEER, itemId: item.id });
            expect(await db.get('SELECT COUNT(*) AS c FROM web_generated_files WHERE userId = @userId', { userId: NATIVE_PEER })).toMatchObject({ c: 0 });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('publishes inbox events the reactive client can act on', async () => {
        const seen = [];
        const unsubscribe = eventBusService.subscribe(event => { if (event.kind === 'inbox') seen.push(event.payload); });
        try {
            const { item } = await inboxService.deliver({ userId: NATIVE_USER, kind: 'notice', title: 'n' });
            await inboxService.markRead({ userId: NATIVE_USER, itemId: item.id });
            await new Promise(resolve => setTimeout(resolve, 20));
            expect(seen.length).toBeGreaterThanOrEqual(2);
            expect(seen[0]).toEqual(expect.objectContaining({ userId: NATIVE_USER, itemId: item.id, kind: 'notice' }));
            expect(eventBusService.invalidationHints('inbox')).toEqual(expect.arrayContaining(['inbox']));
        } finally {
            unsubscribe();
        }
    });

    test('/forget-me erases the inbox and the audit and report see it', async () => {
        await identityService.createNativePrincipal({ id: NATIVE_USER, displayName: 'Nat' });
        await inboxService.deliver({ userId: NATIVE_USER, kind: 'task', title: 'one' });
        await inboxService.deliver({ userId: NATIVE_USER, kind: 'task', title: 'two' });
        await inboxService.deliver({ userId: NATIVE_PEER, kind: 'task', title: 'theirs' });

        const report = await privacyService.buildUserReport({ userId: NATIVE_USER, guildId: dmScopeId(NATIVE_USER) });
        expect(report.inbox).toEqual({ count: 2, unread: 2 });

        const counts = await privacyService.forgetUser({ userId: NATIVE_USER });
        expect(counts.inboxItems).toBe(2);
        const audit = await privacyService.auditUser({ userId: NATIVE_USER });
        expect(audit.byTable.inbox_items).toBe(0);
        expect(audit.total).toBe(0);
        expect(await inboxService.countForUser(NATIVE_PEER)).toBe(1);
    });
});

// ---------------------------------------------------------------------------

describe('follow-up delivery without a Discord client', () => {
    test('personal follow-ups land in the inbox; guild ones wait for the bot', async () => {
        jest.spyOn(aiService, 'generateText').mockRejectedValue(new Error('no provider'));
        const insert = (guildId, channelId, userId, note) => db.insert(
            `INSERT INTO followups (guildId, channelId, userId, note, dueAt)
             VALUES (@guildId, @channelId, @userId, @note, datetime('now', '-1 minute'))`,
            { guildId, channelId, userId, note }
        );
        const personal = { id: await insert(dmScopeId(NATIVE_USER), inboxService.inboxChannelId(NATIVE_USER), NATIVE_USER, 'water the plants') };
        const guild = { id: await insert(GUILD, '300000000000000001', DISCORD_USER, 'post the schedule') };
        expect(await followupService.getDue()).toHaveLength(2);

        const outcome = await followupDeliveryService.deliverDue({ gateway: new DisabledGateway() });
        expect(outcome).toEqual({ delivered: 1, left: 1 });

        const { items } = await inboxService.list({ userId: NATIVE_USER });
        expect(items).toHaveLength(1);
        expect(items[0]).toEqual(expect.objectContaining({
            kind: 'reminder', title: 'Reminder: water the plants', link: '/activity/scheduled',
            source: { type: 'followup', id: String(personal.id) }
        }));
        expect(items[0].body).toContain('water the plants');
        expect(items[0].discord.status).toBe('skipped');

        const rows = await db.all('SELECT id, status FROM followups ORDER BY id');
        expect(rows.find(r => r.id === personal.id).status).toBe('DONE');
        expect(rows.find(r => r.id === guild.id).status).toBe('PENDING');

        // The second pass has nothing personal left and still leaves the guild one alone
        expect(await followupDeliveryService.deliverDue({ gateway: new DisabledGateway() })).toEqual({ delivered: 0, left: 1 });
        expect((await inboxService.list({ userId: NATIVE_USER })).items).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------

describe('native people discovery', () => {
    beforeEach(async () => {
        await member(NATIVE_USER, 'Nat Native', 'nat');
        await member(NATIVE_PEER, 'Peer Person', 'peer');
        await member(DISCORD_USER, 'Rob', 'rob');
    });

    test('searchPeople matches display or login name prefixes, excludes the caller, needs 2+ chars', async () => {
        expect(await identityService.searchPeople({ actorId: NATIVE_USER, q: 'p' })).toEqual([]);
        expect(await identityService.searchPeople({ actorId: NATIVE_USER, q: 'pe' })).toEqual([
            { id: NATIVE_PEER, name: 'Peer Person', source: 'member' }
        ]);
        expect(await identityService.searchPeople({ actorId: NATIVE_USER, q: 'ROB' })).toEqual([
            { id: DISCORD_USER, name: 'Rob', source: 'member' }
        ]);
        expect(await identityService.searchPeople({ actorId: NATIVE_USER, q: 'nat' })).toEqual([]);
        expect(await identityService.searchPeople({ actorId: NATIVE_PEER, q: 'na', exclude: [NATIVE_USER] })).toEqual([]);
        // LIKE metacharacters are literal
        expect(await identityService.searchPeople({ actorId: NATIVE_USER, q: '%' })).toEqual([]);
        expect(await identityService.searchPeople({ actorId: NATIVE_USER, q: '_e' })).toEqual([]);
    });

    test('only active members can search, and only active members are found', async () => {
        await db.run("UPDATE app_accounts SET status = 'disabled' WHERE principalId = @id", { id: NATIVE_PEER });
        expect(await identityService.searchPeople({ actorId: NATIVE_USER, q: 'pe' })).toEqual([]);
        expect(await identityService.searchPeople({ actorId: NATIVE_PEER, q: 'ro' })).toEqual([]);
        expect(await identityService.searchPeople({ actorId: 'usr_0f7f5d0e-3333-4a2b-9c3d-000000000003', q: 'ro' })).toEqual([]);
    });

    test('describeMember returns name + id for active members only', async () => {
        expect(await identityService.describeMember(NATIVE_PEER)).toEqual({ id: NATIVE_PEER, name: 'Peer Person' });
        expect(await identityService.describeMember('usr_0f7f5d0e-3333-4a2b-9c3d-000000000003')).toBeNull();
        expect(await identityService.describeMember('not-an-id')).toBeNull();
    });

    test('friendService.listInvitable surfaces members with the installation as the via label', async () => {
        const friendService = require('@goobster/core/services/friendService');
        const { people } = await friendService.listInvitable({ gateway: new DisabledGateway(), userId: NATIVE_USER, q: 'pe' });
        expect(people).toEqual([expect.objectContaining({
            id: NATIVE_PEER, name: 'Peer Person', source: 'member', via: identityConfig.installationName
        })]);
        // No query = no roster browse
        expect((await friendService.listInvitable({ gateway: new DisabledGateway(), userId: NATIVE_USER })).people).toEqual([]);
    });

    test('a project invite accepts a native principal id and files the invitation in their inbox', async () => {
        const { ObservatoryService } = require('@goobster/core/services/observatoryService');
        const { SandboxService } = require('@goobster/core/services/sandboxService');
        const projectService = new ObservatoryService({
            config: { enabled: true, scope: 'everywhere', maxProjectsPerUser: 5, maxMembersPerProject: 5, maxProjectMb: 256, maxActiveJobsPerUser: 2, maxResumes: 12, maxWorkspaceFiles: 50, maxWorkspaceReadMb: 8, maxUploadMb: 50, maxRenderFrames: 2000, renderFps: 24, ffmpegCommand: 'ffmpeg' },
            sandbox: new SandboxService({ enabled: true, scope: 'everywhere', timeoutMs: 15_000, maxCpuSeconds: 15, maxMemoryMb: 2048, maxWriteMb: 16, maxOutputBytes: 65_536, maxOutputFiles: 8, maxFileSizeBytes: 8_388_608, runsPerWindow: 1000, maxConcurrent: 4, retentionHours: 24, allowNetwork: false, pythonCommand: 'python3', extraBinds: [], requireStrongIsolation: false, runsDir: path.join(os.tmpdir(), `goobster-independent-sandbox-${process.pid}`) })
        });
        const project = await projectService.createProject({ userId: NATIVE_USER, name: 'Quiet Garden' });
        const result = await projectService.invite({
            gateway: new DisabledGateway(), userId: NATIVE_USER, project: project.slug, inviteeId: NATIVE_PEER
        });
        expect(result.invite).toEqual(expect.objectContaining({ inviteeId: NATIVE_PEER }));
        expect(result.dmSent).toBe(false);
        const { items } = await inboxService.list({ userId: NATIVE_PEER });
        expect(items).toHaveLength(1);
        expect(items[0]).toEqual(expect.objectContaining({ kind: 'invite', link: '/projects' }));
        expect(items[0].title).toContain('Quiet Garden');
        expect(items[0].discord.status).toBe('skipped');

        await expect(projectService.invite({
            gateway: new DisabledGateway(), userId: NATIVE_USER, project: project.slug, inviteeId: 'nobody'
        })).rejects.toMatchObject({ code: 'BAD_USER_ID' });
        await expect(projectService.invite({
            gateway: new DisabledGateway(), userId: NATIVE_USER, project: project.slug,
            inviteeId: 'usr_0f7f5d0e-3333-4a2b-9c3d-000000000003'
        })).rejects.toMatchObject({ code: 'NO_SUCH_USER' });
    });
});

// ---------------------------------------------------------------------------

describe('portal API with the Discord adapter off', () => {
    test('/me reports the installation assistant, the disabled adapter, and the unread count', async () => {
        await identityService.createNativePrincipal({ id: NATIVE_USER, displayName: 'Nat' });
        await inboxService.deliver({ userId: NATIVE_USER, kind: 'task', title: 'one' });
        const cookie = await login(NATIVE_USER, 'Nat');
        const res = await request({ reqPath: '/api/app/me', headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.bot).toBeNull();
        expect(res.json.assistant).toEqual({ id: assistantUser().id, name: identityConfig.assistantName });
        expect(res.json.discord).toEqual({ enabled: false, connected: false, reason: expect.stringMatching(/Discord/) });
        expect(res.json.inbox).toEqual({ unread: 1 });
        expect(res.json.scopes.some(scope => scope.kind === 'guild')).toBe(false);
    });

    test('inbox routes read, toggle, archive, and stay per-user', async () => {
        const mine = await login(NATIVE_USER, 'Nat');
        const theirs = await login(NATIVE_PEER, 'Peer');
        const a = (await inboxService.deliver({ userId: NATIVE_USER, kind: 'task', title: 'one', body: 'first' })).item;
        const b = (await inboxService.deliver({ userId: NATIVE_USER, kind: 'watch', title: 'two' })).item;

        expect((await request({ reqPath: '/api/app/inbox' })).status).toBe(401);

        let res = await request({ reqPath: '/api/app/inbox', headers: { Cookie: mine } });
        expect(res.status).toBe(200);
        expect(res.json.items.map(i => i.id)).toEqual([b.id, a.id]);
        expect(res.json.unread).toBe(2);

        res = await request({ reqPath: `/api/app/inbox/${a.id}`, headers: { Cookie: mine } });
        expect(res.json).toEqual(expect.objectContaining({ id: a.id, body: 'first' }));

        res = await request({ method: 'POST', reqPath: `/api/app/inbox/${a.id}/read`, headers: { Cookie: mine } });
        expect(res.status).toBe(200);
        expect(res.json.read).toBe(true);
        res = await request({ reqPath: '/api/app/inbox?unread=1', headers: { Cookie: mine } });
        expect(res.json.items.map(i => i.id)).toEqual([b.id]);
        res = await request({ method: 'POST', reqPath: `/api/app/inbox/${a.id}/read`, headers: { Cookie: mine }, body: { read: false } });
        expect(res.json.read).toBe(false);
        res = await request({ reqPath: '/api/app/inbox/unread', headers: { Cookie: mine } });
        expect(res.json).toEqual({ unread: 2 });

        res = await request({ method: 'POST', reqPath: '/api/app/inbox/read-all', headers: { Cookie: mine } });
        expect(res.json).toEqual({ updated: 2 });

        res = await request({ method: 'POST', reqPath: `/api/app/inbox/${b.id}/archive`, headers: { Cookie: mine } });
        expect(res.json).toEqual({ archived: true });
        res = await request({ reqPath: '/api/app/inbox?archived=1', headers: { Cookie: mine } });
        expect(res.json.items.map(i => i.id)).toEqual([b.id]);

        res = await request({ reqPath: `/api/app/inbox/${a.id}`, headers: { Cookie: theirs } });
        expect(res.status).toBe(404);
        expect(res.json.error.code).toBe('NOT_FOUND');
        res = await request({ method: 'POST', reqPath: `/api/app/inbox/${a.id}/archive`, headers: { Cookie: theirs } });
        expect(res.status).toBe(404);
    });

    test('/people finds installation members by prefix and says Discord is off', async () => {
        await member(NATIVE_USER, 'Nat Native', 'nat');
        await member(NATIVE_PEER, 'Peer Person', 'peer');
        const cookie = await login(NATIVE_USER, 'Nat');
        let res = await request({ reqPath: '/api/app/people?q=pe', headers: { Cookie: cookie } });
        expect(res.status).toBe(200);
        expect(res.json.discord).toBe(false);
        expect(res.json.people).toEqual([expect.objectContaining({ id: NATIVE_PEER, name: 'Peer Person', source: 'member' })]);
        res = await request({ reqPath: '/api/app/people', headers: { Cookie: cookie } });
        expect(res.json.people).toEqual([]);
    });

    test('Discord-specific surfaces answer DISCORD_DISABLED (or NO_DISCORD_IDENTITY for native accounts)', async () => {
        const discord = await login(DISCORD_USER, 'rob');
        let res = await request({ reqPath: `/api/app/memory/facts?scope=${GUILD}`, headers: { Cookie: discord } });
        expect(res.status).toBe(503);
        expect(res.json.error.code).toBe('DISCORD_DISABLED');
        res = await request({ reqPath: `/api/app/exchange/overview?guildId=${GUILD}`, headers: { Cookie: discord } });
        expect(res.status).toBe(503);
        expect(res.json.error.code).toBe('DISCORD_DISABLED');

        await identityService.createNativePrincipal({ id: NATIVE_USER, displayName: 'Nat' });
        const native = await login(NATIVE_USER, 'Nat');
        res = await request({ reqPath: `/api/app/exchange/overview?guildId=${GUILD}`, headers: { Cookie: native } });
        expect(res.status).toBe(403);
        expect(res.json.error.code).toBe('NO_DISCORD_IDENTITY');

        // DM-scoped work is untouched
        res = await request({ reqPath: `/api/app/memory/facts?scope=${dmScopeId(NATIVE_USER)}`, headers: { Cookie: native } });
        expect(res.status).toBe(200);
    });

    test('tasks can be created and are delivered to the inbox, not a Discord DM', async () => {
        await identityService.createNativePrincipal({ id: NATIVE_USER, displayName: 'Nat' });
        const cookie = await login(NATIVE_USER, 'Nat');
        const res = await request({
            method: 'POST', reqPath: '/api/app/tasks', headers: { Cookie: cookie },
            body: { name: 'Stretch', prompt: 'Remind me to stretch', dueAt: new Date(Date.now() + 2 * 3600_000).toISOString() }
        });
        expect(res.status).toBe(200);
        const list = await request({ reqPath: '/api/app/tasks', headers: { Cookie: cookie } });
        expect(list.status).toBe(200);
        expect(list.json.followups).toHaveLength(1);
        expect(list.json.followups[0].delivery).toBe('inbox');
        const row = await db.get('SELECT channelId FROM followups');
        expect(inboxService.isInboxChannelId(row.channelId)).toBe(true);
    });
});

// ---------------------------------------------------------------------------

describe('core runtime lifecycle', () => {
    function fakeDeps(log) {
        const worker = (name) => ({ start: () => log.push(`start:${name}`), stop: () => log.push(`stop:${name}`), close: () => log.push(`stop:${name}`) });
        class FakeAutomation { constructor(client, opts) { log.push(`new:automation:${client ? 'client' : 'none'}:${opts?.gateway?.kind}`); } start() { log.push('start:automation'); } stop() { log.push('stop:automation'); } }
        class FakePersonal { constructor(client, opts) { log.push(`new:personal:${client ? 'client' : 'none'}:${opts?.gateway?.kind}`); } start() { log.push('start:personal'); } stop() { log.push('stop:personal'); } }
        class FakeDiscordWorker { constructor() { log.push('new:discord-worker'); } start() { log.push('start:discord-worker'); } stop() { log.push('stop:discord-worker'); } }
        return {
            eventBusService: worker('eventBus'),
            chatHistoryRetentionService: worker('retention'),
            selfDocsService: { seedOnStartup: async () => ({ acquired: false }) },
            workshopPinMigration: { runOnStartup: async () => ({ acquired: false }) },
            observatoryService: { autoResumeInterrupted: async () => [] },
            projectMissionService: { reconcileStartingSteps: async () => 0, reconcileRunningSteps: async () => 0 },
            projectTriggerService: { catchUpEventTriggers: async () => 0 },
            AutomationService: FakeAutomation,
            followupDeliveryService: { deliverDue: async () => ({ delivered: 0, left: 0 }) },
            PersonalHeartbeatService: FakePersonal,
            spitballExpeditionRunner: { start: async () => [], stop: async () => log.push('stop:expeditions') },
            memoryConsolidationService: worker('consolidation'),
            knowledgeReflectionService: worker('reflection'),
            HeartbeatService: FakeDiscordWorker,
            AgentTrackerService: FakeDiscordWorker,
            MonologueService: FakeDiscordWorker,
            RiskEngine: FakeDiscordWorker
        };
    }

    test('without a client: gateway-safe workers start, Discord-bound ones are skipped, a follow-up ticker runs', async () => {
        const log = [];
        const quiet = { info: () => {}, error: () => {} };
        const runtime = await startCoreRuntime({ gateway: new DisabledGateway(), logger: quiet, deps: fakeDeps(log) });
        expect(runtime.started).toEqual(expect.arrayContaining([
            'eventBus', 'chatHistoryRetention', 'automation', 'followupDelivery', 'personalHeartbeat',
            'spitballExpeditions', 'memoryConsolidation', 'knowledgeReflection'
        ]));
        expect(runtime.skipped).toEqual(expect.arrayContaining(['heartbeat', 'agentTracker', 'monologue', 'exchangeRiskEngine']));
        expect(runtime.started).not.toContain('heartbeat');
        expect(log).toContain('new:automation:none:disabled');
        expect(log).toContain('new:personal:none:disabled');
        expect(log).not.toContain('new:discord-worker');
        expect(runtime.services.followupTimer).toBeTruthy();
        expect(runtime.gateway.kind).toBe('disabled');

        await runtime.stop();
        expect(log.filter(entry => entry.startsWith('stop:'))).toEqual(expect.arrayContaining([
            'stop:automation', 'stop:personal', 'stop:consolidation', 'stop:reflection', 'stop:eventBus', 'stop:retention'
        ]));
        // Reverse order: the event bus (started first) closes last
        expect(log.lastIndexOf('stop:eventBus')).toBeGreaterThan(log.lastIndexOf('stop:automation'));
        await runtime.stop(); // idempotent
    });

    test('with a live client: the Discord-bound workers start too and no separate follow-up ticker is needed', async () => {
        const log = [];
        const client = { user: { id: '900000000000000001', username: 'Goobster' }, isReady: () => true };
        const runtime = await startCoreRuntime({ client, logger: { info: () => {}, error: () => {} }, deps: fakeDeps(log) });
        expect(runtime.started).toEqual(expect.arrayContaining(['heartbeat', 'agentTracker', 'monologue', 'exchangeRiskEngine']));
        expect(runtime.skipped).toContain('followupDelivery');
        expect(runtime.services.followupTimer).toBeUndefined();
        expect(log.filter(entry => entry === 'new:discord-worker')).toHaveLength(4);
        expect(log).toContain('new:automation:client:local');
        await runtime.stop();
        expect(log.filter(entry => entry === 'stop:discord-worker')).toHaveLength(4);
    });

    test('schedulers=false runs only the startup reconciliation; a failing worker disables itself only', async () => {
        const log = [];
        const deps = fakeDeps(log);
        deps.selfDocsService = { seedOnStartup: async () => { throw new Error('corpus missing'); } };
        const errors = [];
        const runtime = await startCoreRuntime({
            gateway: new DisabledGateway(), schedulers: false,
            logger: { info: () => {}, error: (message) => errors.push(message) }, deps
        });
        expect(runtime.started).toEqual(expect.arrayContaining(['eventBus', 'chatHistoryRetention', 'observatoryResume']));
        expect(runtime.skipped).toContain('selfDocs');
        expect(runtime.started).not.toContain('automation');
        expect(errors.join('\n')).toMatch(/selfDocs failed to start: corpus missing/);
        await runtime.stop();
    });

    test('paired API startup preserves a mission child another process is still launching', async () => {
        const { ProjectMissionService } = require('@goobster/core/services/projectMissionService');
        const missions = new ProjectMissionService();
        const args = { userId: NATIVE_USER, project: 'startup-race' };
        await db.run(
            'INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, @slug, @name)',
            { userId: NATIVE_USER, slug: args.project, name: 'Startup race' }
        );
        await missions.create({
            ...args, title: 'Startup race', objective: 'Launch a job across an API restart',
            successCriteria: ['The job remains tracked'],
            steps: [{ kind: 'job', title: 'Launch job', actionParams: { asset: 'script' } }]
        });
        const receipt = await missions.mintApprovalReceipt({ ...args, origin: 'portal' });
        await missions.approve({ ...args, receiptId: receipt.id, nonce: receipt.nonce });
        const active = await missions.start(args);
        let release;
        let launched;
        const gate = new Promise(resolve => { release = resolve; });
        const entered = new Promise(resolve => { launched = resolve; });
        jest.spyOn(missions, '_kickStep').mockImplementation(async ({ project, step }) => {
            launched();
            await gate;
            const jobId = await db.insert(
                `INSERT INTO observatory_jobs (projectId, userId, language, code, status, executionAttemptId)
                 VALUES (@projectId, @userId, 'python', 'print(1)', 'RUNNING', @attemptId)`,
                { projectId: project.id, userId: NATIVE_USER, attemptId: step.executionAttemptId }
            );
            return { jobId };
        });
        const pending = missions.startStep({ ...args, stepId: active.steps[0].id })
            .then(result => ({ result }), error => ({ error }));
        await entered;
        let runtime;
        try {
            const deps = fakeDeps([]);
            deps.projectMissionService = missions;
            runtime = await startCoreRuntime({
                gateway: new DisabledGateway(), schedulers: false,
                logger: { info: () => {}, error: () => {} }, deps
            });
            const during = await missions.get(args);
            expect(during.status).toBe('ACTIVE');
            expect(during.steps[0].status).toBe('STARTING');
        } finally {
            release();
            await runtime?.stop();
        }
        const outcome = await pending;
        expect(outcome.error).toBeUndefined();
        expect(outcome.result.status).toBe('ACTIVE');
        expect(outcome.result.steps[0].status).toBe('RUNNING');
        expect(outcome.result.steps[0].jobId).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------

describe('api service runtime modes', () => {
    const { resolveRuntimeMode, createGatewayFromEnv, createApiApp } = require('../apps/api/server');

    test('mode follows the explicit env var, then the Discord adapter', () => {
        expect(resolveRuntimeMode({ GOOBSTER_RUNTIME_MODE: 'paired' })).toBe('paired');
        expect(resolveRuntimeMode({ GOOBSTER_RUNTIME_MODE: 'standalone' })).toBe('standalone');
        expect(resolveRuntimeMode({})).toBe('standalone');
        discordConfig.setEnabledForTests(true);
        expect(resolveRuntimeMode({})).toBe('paired');
        discordConfig.setEnabledForTests(false);
    });

    test('standalone mode uses the DisabledGateway and reports it on /health', async () => {
        expect(createGatewayFromEnv({ mode: 'standalone' }).kind).toBe('disabled');
        const previousToken = process.env.GOOBSTER_INTERNAL_TOKEN;
        process.env.GOOBSTER_INTERNAL_TOKEN = 'test-token';
        try {
            expect(createGatewayFromEnv({ mode: 'paired' }).kind).toBe('remote');
        } finally {
            if (previousToken === undefined) delete process.env.GOOBSTER_INTERNAL_TOKEN;
            else process.env.GOOBSTER_INTERNAL_TOKEN = previousToken;
        }

        const { app, mode } = createApiApp({
            config: { clientId: '123', webapp: { enabled: true, devMode: true } },
            logger: { error: () => {}, warn: () => {}, info: () => {} }
        });
        expect(mode).toBe('standalone');
        const local = app.listen(0, '127.0.0.1');
        await new Promise(resolve => local.once('listening', resolve));
        try {
            const health = await new Promise((resolve, reject) => {
                http.get({ host: '127.0.0.1', port: local.address().port, path: '/health' }, (res) => {
                    let data = '';
                    res.on('data', chunk => { data += chunk; });
                    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
                }).on('error', reject);
            });
            expect(health.status).toBe(200);
            expect(health.json).toEqual(expect.objectContaining({ status: 'healthy', service: 'api', mode: 'standalone', discord: 'disabled' }));
        } finally {
            await new Promise(resolve => local.close(resolve));
        }
    });
});
