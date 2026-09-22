/**
 * Activity correlation (package E5).
 *
 * A notice `_contact` also files in the Inbox is one delivery: the Inbox
 * row names the notices, each notice names that row, and the unread count
 * grows by one. Acknowledge, snooze and dismiss stay on the notice; archive
 * stays on the inbox row; each side's later read shows what the other did.
 * Hiding a tool is a validated preference on the existing settings row.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB = path.join(os.tmpdir(), `goobster-activity-correlation-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const attention = require('@goobster/core/services/attentionService');
const inbox = require('@goobster/core/services/inboxService');
const userSettings = require('@goobster/core/services/userSettingsService');
const privacy = require('@goobster/core/services/privacyService');
const eventBus = require('@goobster/core/services/eventBusService');
const { dmScopeId } = require('@goobster/core/utils/dmScope');

const OWNER = '700000000000000001';
const OTHER = '700000000000000002';

function candidate(key, title, score) {
    return {
        key,
        itemId: null,
        category: 'watch',
        title,
        detail: 'The nightly ingest changed.',
        urgency: 0.4,
        importance: 0.5,
        confidence: 0.6,
        actionability: 0.5,
        interruptionCost: 0.2,
        score,
        disposition: 'dm',
        reason: 'a watch that fired'
    };
}

async function raiseBundle(userId = OWNER) {
    const raised = [];
    const specs = [
        ['lead', 'The ingest watch fired', 0.4],
        ['more-1', 'A second watch fired', 0.3],
        ['more-2', 'A third watch fired', 0.2]
    ];
    for (const [key, title, score] of specs) {
        raised.push(await attention._raiseNotice(userId, candidate(`${userId}-${key}`, title, score)));
    }
    const before = await inbox.unreadCount(userId);
    const filed = await attention._contact({
        userId,
        gateway: null,
        notices: raised,
        message: 'Three watches fired while you were away.',
        urgent: false
    });
    return { raised, before, filed };
}

beforeEach(async () => {
    await db.run('DELETE FROM inbox_items');
    await db.run('DELETE FROM attention_notices');
    await db.run('DELETE FROM attention_feedback');
    await db.run('DELETE FROM attention_state');
    await db.run('DELETE FROM user_settings');
    await db.run('DELETE FROM user_setting_revisions');
});

afterAll(async () => {
    await eventBus.close();
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* isolated PG or already gone */ }
    }
});

test('one _contact delivery is a single unread inbox row that names every notice', async () => {
    const { raised, before, filed } = await raiseBundle();
    expect(filed).toBe(true);
    expect(raised.every(notice => notice && notice.id)).toBe(true);

    expect(await inbox.unreadCount(OWNER)).toBe(before + 1);

    const page = await inbox.list({ userId: OWNER });
    expect(page.items).toHaveLength(1);
    const item = page.items[0];
    expect(item.kind).toBe('notice');
    expect(item.title).toBe('The ingest watch fired (+2 more)');
    expect(item.link).toBe('/activity/attention');
    expect(item.attention.notices.map(notice => notice.title)).toEqual([
        'The ingest watch fired',
        'A second watch fired',
        'A third watch fired'
    ]);
    expect(item.attention.notices.map(notice => notice.id)).toEqual(raised.map(notice => notice.id));
    expect(item.attention.notices.every(notice => notice.status === 'delivered')).toBe(true);

    const notices = await attention.listNotices({ userId: OWNER });
    expect(notices).toHaveLength(3);
    for (const notice of notices) {
        expect(notice.inboxDelivery).toEqual({
            itemId: item.id,
            read: false,
            archived: false,
            link: '/activity/inbox'
        });
    }

    await attention._raiseNotice(OWNER, {
        ...candidate(`${OWNER}-mention`, 'Say this next time', 0.3),
        disposition: 'mention'
    });
    const mentions = await attention.takePendingMentions(OWNER);
    expect(mentions).toHaveLength(1);
    expect(Object.hasOwn(mentions[0], 'inboxDelivery')).toBe(false);
});

test('archive stays an inbox action and shows on the notice; attention actions stay on the notice and show on the row', async () => {
    const { raised } = await raiseBundle();
    const [lead, second, third] = raised;
    const item = (await inbox.list({ userId: OWNER })).items[0];

    await inbox.archive({ userId: OWNER, itemId: item.id });
    const archived = (await attention.listNotices({ userId: OWNER })).find(notice => notice.id === lead.id);
    expect(archived.status).toBe('delivered');
    expect(archived.inboxDelivery.archived).toBe(true);
    expect(archived.inboxDelivery.read).toBe(true);

    const dismissed = await attention.actOnNotice({ userId: OWNER, noticeId: lead.id, action: 'dismiss' });
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.inboxDelivery.itemId).toBe(item.id);
    const snoozed = await attention.actOnNotice({ userId: OWNER, noticeId: second.id, action: 'snooze', snoozeHours: 24 });
    expect(snoozed.status).toBe('snoozed');
    expect(snoozed.snoozeUntil).toBeTruthy();
    const acted = await attention.actOnNotice({ userId: OWNER, noticeId: third.id, action: 'act' });
    expect(acted.status).toBe('acted_on');

    const open = await attention.listNotices({ userId: OWNER });
    expect(open.map(notice => notice.id)).not.toEqual(expect.arrayContaining([lead.id, second.id, third.id]));

    const stored = await inbox.get({ userId: OWNER, itemId: item.id });
    expect(stored.attention.notices.map(notice => notice.status)).toEqual(['dismissed', 'snoozed', 'acted_on']);
    const archivedPage = await inbox.list({ userId: OWNER, archived: true });
    expect(archivedPage.items.map(row => row.id)).toEqual([item.id]);
    const stillOpen = await inbox.list({ userId: OWNER, archived: false });
    expect(stillOpen.items).toHaveLength(0);
});

test('a forged source id cannot read another person\'s notice', async () => {
    const { raised } = await raiseBundle(OWNER);
    await inbox.deliver({
        userId: OTHER,
        kind: 'notice',
        title: 'Not theirs',
        body: 'Points at someone else.',
        source: { type: 'attention', id: String(raised[0].id) }
    });
    const foreign = (await inbox.list({ userId: OTHER })).items[0];
    expect(foreign.attention.notices).toEqual([
        { id: raised[0].id, title: null, status: null, snoozeUntil: null }
    ]);
    const owner = (await inbox.list({ userId: OWNER })).items[0];
    expect(owner.attention.notices[0].title).toBe('The ingest watch fired');
});

test('hidden tool rooms are a validated preference on the existing settings row', async () => {
    await expect(userSettings.updateSection({
        userId: OWNER, section: 'appearance', changes: { hiddenToolRooms: 'music' }
    })).rejects.toMatchObject({ status: 400, code: 'BAD_TOOL_ROOMS' });
    await expect(userSettings.updateSection({
        userId: OWNER, section: 'appearance', changes: { hiddenToolRooms: ['workshop'] }
    })).rejects.toMatchObject({ status: 400, code: 'BAD_TOOL_ROOMS' });

    const saved = await userSettings.updateSection({
        userId: OWNER,
        section: 'appearance',
        changes: { hiddenToolRooms: ['decks', 'decks', ' music ', 'trading'] }
    });
    expect(saved.data.values.hiddenToolRooms).toEqual(['decks', 'music', 'trading']);

    const report = await privacy.buildUserReport({ guildId: dmScopeId(OWNER), userId: OWNER });
    expect(report.settingsPreferences.hiddenToolRooms).toEqual(['decks', 'music', 'trading']);

    const { raised } = await raiseBundle(OWNER);
    expect(raised).toHaveLength(3);
    await privacy.forgetUser({ userId: OWNER });
    const audit = await privacy.auditUser({ userId: OWNER });
    expect(audit.byTable.user_settings).toBe(0);
    expect(audit.byTable.attention_notices).toBe(0);
    expect(audit.byTable.inbox_items).toBe(0);
});

test('resetting appearance clears a hidden tool without touching chat tool switches', async () => {
    await userSettings.updateSection({
        userId: OWNER,
        section: 'chat',
        changes: { disabledTools: ['performSearch'] }
    });
    await userSettings.updateSection({
        userId: OWNER,
        section: 'appearance',
        changes: { hiddenToolRooms: ['music'] }
    });
    const reset = await userSettings.resetSection({ userId: OWNER, section: 'appearance' });
    expect(reset.data.values.hiddenToolRooms).toEqual([]);
    const chat = await userSettings.getSettings({ userId: OWNER });
    expect(chat.sections.chat.values.disabledTools).toEqual(['performSearch']);
});
