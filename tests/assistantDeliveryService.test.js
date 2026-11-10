/**
 * Delivery and interruption for delegated work (DA-9,
 * documentation/delegated_delivery.md), against a throwaway database.
 *
 * The properties under test: an update leaves the portal only as its
 * responsibility's interruption rule says; every way out is Attention's
 * `requestContact()`, so quiet hours, the daily cap and the cooldown hold
 * and Attention's own notices spend the same budget; there is at most one
 * digest a day and an empty day sends none; the same update never goes
 * out both as a contact and as a digest entry; going out is delivery, not
 * review; turning Attention off stops it at once; and the whole thing is
 * the owner's alone until the pilot decision is recorded.
 *
 * Nothing leaves the process: the push sender and the Discord gateway are
 * fakes.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-assistant-delivery-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const delivery = require('@goobster/core/services/assistantDeliveryService');
const updates = require('@goobster/core/services/assistantUpdateService');
const responsibilities = require('@goobster/core/services/assistantResponsibilityService');
const access = require('@goobster/core/services/assistantAccessService');
const control = require('@goobster/core/services/assistantControlService');
const instanceState = require('@goobster/core/services/instanceStateService');
const attention = require('@goobster/core/services/attentionService');
const policies = require('@goobster/core/services/attentionPolicyService');
const userSettings = require('@goobster/core/services/userSettingsService');
const identityService = require('@goobster/core/services/identityService');
const inbox = require('@goobster/core/services/inboxService');
const pushConfig = require('@goobster/core/config/pushConfig');
const pushService = require('@goobster/core/services/pushService');
const privacyService = require('@goobster/core/services/privacyService');
const steward = require('@goobster/core/services/assistantStewardService');
const { useState } = require('./helpers/featureFixtures');

const OWNER = '790000000000000001';
const MEMBER = '790000000000000002';
const READ_WEB = { operation: 'read', resource: { kind: 'web' } };
const PUSH_KEYS = {
    enabled: true,
    reason: null,
    publicKey: 'BIPUL12DLfytvTajnryr2PRdAgXS3HGKiLqndGcJGabyhHheJPFbo0gxnXrbZw4mE0-lrGvJ60YaHKY5aCcB4Ho',
    privateKey: 'kU0z4tWfbfKvGwb1cQ8M9Cn0jbDYpR0yYQpCwjvSb1k',
    subject: 'mailto:test@example.com'
};

/** Tomorrow at a UTC hour: after everything this suite creates, and a known minute of the day. */
function at(hour, minute = 0, dayOffset = 1) {
    const today = new Date();
    return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + dayOffset, hour, minute, 0));
}
const utcText = date => date.toISOString().slice(0, 19).replace('T', ' ');

let pushes;
let dms;
let gateway;

function fakeGateway({ ok = true } = {}) {
    return {
        isGoobsterGateway: true,
        kind: 'local',
        sendDm: async (userId, message) => {
            dms.push({ userId, message });
            return ok ? { ok: true } : { ok: false, error: 'CANNOT_DM' };
        }
    };
}

async function device(userId, n = 1) {
    await pushService.subscribe({
        userId,
        subscription: {
            endpoint: `https://push.example.test/send/${userId}-${n}`,
            keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
        }
    });
}

async function owner(userId = OWNER) {
    await identityService.ensureLegacyPrincipal({ discordId: userId, displayName: 'owner' });
    await identityService.grantAccount({ principalId: userId, entitlement: 'bootstrap', role: 'operator' });
}

let titleSeq = 0;
async function responsibility(interruption, userId = OWNER) {
    await policies.enroll({ userId, initiative: 'assist' });
    const { responsibility: draft } = await responsibilities.create({
        userId,
        body: {
            title: `Keep the garden plan moving ${++titleSeq}`,
            operations: [READ_WEB],
            ...(interruption ? { rules: { interruption } } : {})
        }
    });
    return (await responsibilities.act({ userId, id: draft.id, action: 'activate', expectedRevision: draft.revision })).responsibility;
}

let keySeq = 0;
async function finding(grant, overrides = {}) {
    const key = `finding:${++keySeq}`;
    const { update } = await updates.publish({
        audience: { userId: grant.ownerUserId || OWNER },
        identityKey: key,
        kind: 'finding',
        title: `Finding ${keySeq}`,
        summary: 'Something was found.',
        components: ['research'],
        responsibilityId: grant.id,
        deliver: true,
        ...overrides
    });
    return update;
}

async function request(grant, overrides = {}) {
    const key = `gate:${++keySeq}`;
    const { update } = await updates.publish({
        audience: { userId: grant.ownerUserId || OWNER },
        identityKey: key,
        kind: 'question',
        title: `Request ${keySeq}`,
        summary: 'A decision is needed.',
        components: ['research'],
        responsibilityId: grant.id,
        gate: { kind: 'question', id: key },
        deliver: true,
        ...overrides
    });
    return update;
}

const outbound = id => db.get(
    'SELECT outboundKind, outboundRevision, outboundOccurrence, materialRevision FROM assistant_updates WHERE id = @id', { id }
);
const contacts = (userId = OWNER) => db.all(
    'SELECT reason, refId, urgent, inboxItemId, discordStatus, pushSent FROM attention_contacts WHERE userId = @userId ORDER BY id', { userId }
);
const digests = (userId = OWNER) => db.all('SELECT * FROM assistant_digests WHERE userId = @userId ORDER BY id', { userId });
const receipt = (id, userId = OWNER) => db.get(
    'SELECT deliveredRevision, acknowledgedRevision FROM assistant_update_receipts WHERE updateId = @id AND userId = @userId', { id, userId }
);

beforeEach(async () => {
    useState();
    for (const table of [
        'assistant_digests', 'attention_contacts', 'assistant_update_receipts', 'assistant_updates',
        'assistant_initiatives', 'assistant_responsibility_revisions', 'assistant_responsibilities',
        'attention_notices', 'attention_state', 'attention_policies', 'inbox_items', 'push_subscriptions',
        'user_setting_revisions', 'user_settings', 'work_failures', 'app_accounts'
    ]) {
        await db.run(`DELETE FROM ${table}`, {});
    }
    for (const key of [access.KEY_PILOT, control.KEY_PAUSED]) await instanceState.remove(key);
    pushConfig._setForTests({ ...PUSH_KEYS });
    pushes = [];
    dms = [];
    pushService._sender = {
        async sendNotification(subscription, payload) {
            pushes.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
            return { statusCode: 201 };
        }
    };
    gateway = fakeGateway();
    delivery.attach({ gateway });
    await owner();
    await device(OWNER);
});

afterAll(async () => {
    delivery.detach();
    pushConfig._setForTests(null);
    useState();
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) fs.rmSync(TEST_DB + suffix, { force: true });
});

describe('the interruption rule', () => {
    test('home (the default): the update is on Home and in the Inbox and nothing leaves the portal', async () => {
        const grant = await responsibility(null);
        const asked = await request(grant);
        await finding(grant);

        expect((await inbox.list({ userId: OWNER })).items).toHaveLength(2);
        expect(pushes).toEqual([]);
        expect(dms).toEqual([]);
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 0 });
        expect(await contacts()).toEqual([]);
        expect(await digests()).toEqual([]);
        expect(await outbound(asked.id)).toMatchObject({ outboundKind: null, outboundRevision: 0 });
    });

    test('an update that belongs to no responsibility never leaves the portal', async () => {
        await policies.enroll({ userId: OWNER, initiative: 'assist' });
        await updates.publish({
            audience: { userId: OWNER }, identityKey: 'loose', kind: 'question', title: 'Loose request',
            components: ['research'], gate: { kind: 'question', id: 'loose' }, deliver: true
        });
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 0 });
        expect(pushes).toEqual([]);
        expect(dms).toEqual([]);
    });

    test('immediate: an open request is one contact, on every channel, as soon as its envelope is filed', async () => {
        const grant = await responsibility('immediate');
        const asked = await request(grant);

        expect(pushes).toHaveLength(1);
        expect(dms).toHaveLength(1);
        expect(dms[0].userId).toBe(OWNER);
        expect(await outbound(asked.id)).toMatchObject({ outboundKind: 'contact', outboundRevision: 1, outboundOccurrence: 1 });
        const [row] = await contacts();
        expect(row).toMatchObject({ reason: 'assistant', refId: String(asked.id), urgent: 0, discordStatus: 'sent', pushSent: 1 });
        // The contact points at the envelope that is already in the Inbox: no second item.
        const { items } = await inbox.list({ userId: OWNER });
        expect(items).toHaveLength(1);
        expect(row.inboxItemId).toBe(items[0].id);

        // Nothing more on later passes, and it is never also a digest entry.
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 0 });
        expect(pushes).toHaveLength(1);
        expect(await digests()).toEqual([]);
    });

    test('immediate: a finding never contacts anyone by itself; it waits for the digest', async () => {
        const grant = await responsibility('immediate');
        const found = await finding(grant);
        expect(pushes).toEqual([]);
        expect(dms).toEqual([]);
        expect(await delivery.sweep({ now: at(12) })).toMatchObject({ contacts: 0, digests: 1 });
        expect(await outbound(found.id)).toMatchObject({ outboundKind: 'digest', outboundRevision: 1 });
    });

    test('one contact per gate occurrence: a revision of the same request is silent, a new occurrence contacts again', async () => {
        const grant = await responsibility('immediate');
        const key = 'gate:repeat';
        const ask = (extra = {}) => updates.publish({
            audience: { userId: OWNER }, identityKey: key, kind: 'question', title: 'Which bed first?',
            summary: 'A decision is needed.', components: ['research'], responsibilityId: grant.id,
            gate: { kind: 'question', id: key }, deliver: true, ...extra
        });
        const { update } = await ask();
        expect(pushes).toHaveLength(1);

        // The wording changed: a new material revision of the same occurrence.
        const revised = await ask({ summary: 'A decision is needed today.' });
        expect(revised.update.revision).toBe(2);
        await delivery.sweep({ now: at(12, 0, 2) });
        expect(pushes).toHaveLength(1);
        expect(await digests()).toEqual([]);

        // Asked again later (occurrence 2), after the cooldown.
        await db.run('DELETE FROM attention_contacts', {});
        await ask({ gate: { kind: 'question', id: key, occurrence: 2 } });
        expect(pushes).toHaveLength(2);
        expect(await outbound(update.id)).toMatchObject({ outboundKind: 'contact', outboundOccurrence: 2 });
    });

    test('the rule is read when the decision is made: back to home stops what was still waiting', async () => {
        const grant = await responsibility('digest');
        await finding(grant);
        const paused = (await responsibilities.act({ userId: OWNER, id: grant.id, action: 'pause', expectedRevision: grant.revision })).responsibility;
        const edited = (await responsibilities.update({
            userId: OWNER, id: grant.id, expectedRevision: paused.revision, body: { rules: { interruption: 'home' } }
        })).responsibility;
        await responsibilities.act({ userId: OWNER, id: grant.id, action: 'resume', expectedRevision: edited.revision });
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 0 });
        expect(await digests()).toEqual([]);
        expect(pushes).toEqual([]);
    });

    test('a paused or revoked responsibility sends nothing out; resuming sends what is still waiting', async () => {
        const grant = await responsibility('digest');
        const revoked = await responsibility('digest');
        await finding(grant);
        await finding(revoked);
        const paused = (await responsibilities.act({ userId: OWNER, id: grant.id, action: 'pause', expectedRevision: grant.revision })).responsibility;
        await responsibilities.act({ userId: OWNER, id: revoked.id, action: 'revoke', expectedRevision: revoked.revision });
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 0 });
        expect(pushes).toEqual([]);

        await responsibilities.act({ userId: OWNER, id: grant.id, action: 'resume', expectedRevision: paused.revision });
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 1, held: 0 });
        expect(JSON.parse((await digests())[0].updateIdsJson)).toHaveLength(1);
    });

    test('a web-only process (not the sender) leaves the contact for the steward', async () => {
        delivery.detach();
        const grant = await responsibility('immediate');
        const asked = await request(grant);
        expect(pushes).toEqual([]);
        expect(await outbound(asked.id)).toMatchObject({ outboundKind: null, outboundRevision: 0 });

        delivery.attach({ gateway });
        expect(await delivery.sweep({ now: at(8) })).toMatchObject({ contacts: 1, digests: 0 });
        expect(pushes).toHaveLength(1);
        expect(dms).toHaveLength(1);
    });
});

describe('the daily digest', () => {
    test('one digest a day: a single Inbox item, one contact, and each entry marked as sent', async () => {
        const grant = await responsibility('digest');
        const first = await finding(grant);
        const second = await request(grant);
        expect(pushes).toEqual([]);

        // Before the digest time (09:00 by default) nothing goes out.
        expect(await delivery.sweep({ now: at(8, 59) })).toEqual({ contacts: 0, digests: 0, held: 0 });
        expect(await digests()).toEqual([]);

        expect(await delivery.sweep({ now: at(9, 1) })).toEqual({ contacts: 0, digests: 1, held: 0 });
        const [digest] = await digests();
        expect(digest.day).toBe(at(9).toISOString().slice(0, 10));
        expect(JSON.parse(digest.updateIdsJson)).toEqual([first.id, second.id]);
        expect(digest.sentAt).toBeTruthy();
        expect(pushes).toHaveLength(1);
        expect(dms).toHaveLength(1);

        const item = await db.get('SELECT * FROM inbox_items WHERE id = @id', { id: digest.inboxItemId });
        expect(item).toMatchObject({ userId: OWNER, kind: 'notice', sourceType: 'assistant_digest', title: '2 updates from your delegated work' });
        expect(item.body).toContain(first.title);
        expect(item.body).toContain(`${second.title} (waiting for your decision)`);
        expect(await contacts()).toEqual([
            expect.objectContaining({ reason: 'assistant', refId: `digest:${digest.day}`, inboxItemId: digest.inboxItemId })
        ]);
        for (const update of [first, second]) {
            expect(await outbound(update.id)).toMatchObject({ outboundKind: 'digest', outboundRevision: 1 });
        }

        // Later the same day: more waiting, still no second digest.
        await finding(grant);
        await db.run('DELETE FROM attention_contacts', {});
        expect(await delivery.sweep({ now: at(20) })).toMatchObject({ digests: 0 });
        expect(await digests()).toHaveLength(1);
        expect(pushes).toHaveLength(1);
    });

    test('an empty day sends nothing and records nothing', async () => {
        const grant = await responsibility('digest');
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 0 });

        // Everything already looked at is not waiting either.
        const seen = await finding(grant);
        await updates.acknowledge({ userId: OWNER, items: [{ id: seen.id, revision: 1 }] });
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 0 });
        expect(await digests()).toEqual([]);
        expect(await contacts()).toEqual([]);
        expect(pushes).toEqual([]);
    });

    test('what arrives after today\'s digest time is tomorrow\'s digest', async () => {
        const grant = await responsibility('digest');
        const early = await finding(grant);
        const late = await finding(grant);
        await db.run('UPDATE assistant_updates SET updatedAt = @at WHERE id = @id', { id: late.id, at: utcText(at(10)) });

        expect(await delivery.sweep({ now: at(12) })).toMatchObject({ digests: 1 });
        expect(JSON.parse((await digests())[0].updateIdsJson)).toEqual([early.id]);
        expect(await outbound(late.id)).toMatchObject({ outboundKind: null });

        expect(await delivery.sweep({ now: at(12, 0, 2) })).toMatchObject({ digests: 1 });
        const rows = await digests();
        expect(rows).toHaveLength(2);
        expect(JSON.parse(rows[1].updateIdsJson)).toEqual([late.id]);
    });

    test('the digest time is the person\'s setting, on the clock their quiet hours use', async () => {
        const grant = await responsibility('digest');
        await finding(grant);
        const saved = await userSettings.updateSection({ userId: OWNER, section: 'initiative', changes: { digestMinute: 18 * 60 } });
        expect(saved.data.values.digestMinute).toBe(18 * 60);
        expect((await policies.get(OWNER)).digestMinute).toBe(18 * 60);

        expect(await delivery.sweep({ now: at(12) })).toMatchObject({ digests: 0 });
        expect(await delivery.sweep({ now: at(18, 5) })).toMatchObject({ digests: 1 });

        await expect(userSettings.updateSection({ userId: OWNER, section: 'initiative', changes: { digestMinute: 1440 } }))
            .rejects.toMatchObject({ code: 'BAD_DIGEST_TIME' });
        // Clearing it goes back to the default.
        await userSettings.updateSection({ userId: OWNER, section: 'initiative', changes: { digestMinute: null } });
        expect((await policies.get(OWNER)).digestMinute).toBeNull();
        expect(delivery.DEFAULT_DIGEST_MINUTE).toBe(9 * 60);
    });

    test('local quiet hours: the digest day and time follow the person\'s timezone', async () => {
        await userSettings.updateSection({ userId: OWNER, section: 'profile', changes: { timezone: 'Pacific/Auckland' } });
        await userSettings.updateSection({ userId: OWNER, section: 'initiative', changes: { quietHoursTzMode: 'local' } });
        // 22:30 UTC is the next morning in Auckland (UTC+12 or +13).
        const clock = await delivery.clock(OWNER, at(22, 30));
        expect(clock.timeZone).toBe('Pacific/Auckland');
        expect(clock.day).toBe(at(0, 0, 2).toISOString().slice(0, 10));
        expect([10 * 60 + 30, 11 * 60 + 30]).toContain(clock.minute);
        expect(await delivery.clock(MEMBER, at(22, 30))).toMatchObject({ timeZone: null, minute: 22 * 60 + 30, day: at(0).toISOString().slice(0, 10) });
    });

    test('a digest that could not go out is given back and sent on a later pass', async () => {
        const grant = await responsibility('digest');
        const found = await finding(grant);
        await policies.setQuietHours({ userId: OWNER, startMinute: 11 * 60, endMinute: 13 * 60 });

        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 1 });
        expect(await digests()).toEqual([]);
        expect(await outbound(found.id)).toMatchObject({ outboundKind: null, outboundRevision: 0 });

        expect(await delivery.sweep({ now: at(13, 30) })).toMatchObject({ digests: 1 });
        expect(pushes).toHaveLength(1);
    });
});

describe('one contact budget, shared with Attention', () => {
    test('quiet hours hold a request; it goes out when they end', async () => {
        await policies.enroll({ userId: OWNER, initiative: 'assist' });
        await policies.setQuietHours({ userId: OWNER, startMinute: 0, endMinute: 1439 });
        const grant = await responsibility('immediate');
        const asked = await request(grant);
        expect(pushes).toEqual([]);
        expect(dms).toEqual([]);
        expect(await contacts()).toEqual([]);
        expect(await outbound(asked.id)).toMatchObject({ outboundKind: null, outboundRevision: 0 });
        expect(await attention.contactAllowed({ userId: OWNER, reason: 'assistant' })).toMatchObject({ allowed: false, code: 'QUIET_HOURS' });

        await policies.setQuietHours({ userId: OWNER, startMinute: null, endMinute: null });
        expect(await delivery.sweep({ now: at(8) })).toMatchObject({ contacts: 1 });
        expect(pushes).toHaveLength(1);
    });

    test('the cooldown holds a second request; both are never sent back to back', async () => {
        const grant = await responsibility('immediate');
        await request(grant);
        const second = await request(grant);
        expect(pushes).toHaveLength(1);
        expect(await outbound(second.id)).toMatchObject({ outboundKind: null });
        expect(await attention.contactAllowed({ userId: OWNER, reason: 'assistant' })).toMatchObject({ allowed: false, code: 'COOLDOWN' });

        // Three hours and a minute later (the default cooldown is 180 minutes).
        const later = new Date(Date.now() + 181 * 60_000);
        expect(await delivery.sweep({ now: later })).toMatchObject({ contacts: 1 });
        expect(pushes).toHaveLength(2);
    });

    test('the daily cap counts Attention\'s notices and delegated contacts together', async () => {
        const grant = await responsibility('immediate');
        const now = new Date();
        // Two contacts Attention itself made today, four and five hours ago.
        for (const hours of [5, 4]) {
            await db.run(
                `INSERT INTO attention_notices (userId, dedupeKey, title, disposition, status, deliveredAt, createdAt)
                 VALUES (@userId, @key, 'A notice', 'dm', 'delivered', @at, @at)`,
                { userId: OWNER, key: `n${hours}`, at: utcText(new Date(now.getTime() - hours * 3_600_000)) }
            );
        }
        // The third of three is a delegated request.
        await request(grant);
        expect(pushes).toHaveLength(1);

        // The fourth, after the cooldown, is over the cap of three.
        const later = new Date(now.getTime() + 200 * 60_000);
        const held = await request(grant);
        expect(await attention.contactAllowed({ userId: OWNER, reason: 'assistant', now: later.getTime() }))
            .toMatchObject({ allowed: false, code: 'CONTACT_CAP' });
        expect(await delivery.sweep({ now: later })).toMatchObject({ contacts: 0 });
        expect(pushes).toHaveLength(1);
        expect(await outbound(held.id)).toMatchObject({ outboundKind: null });

        // And Attention's own contact is refused by the same count.
        expect((await attention._measurePressure(OWNER, await policies.get(OWNER), later.getTime())).blocked).toBe(true);
    });

    test('a digest spends a contact too, and waits behind the cooldown of a contact just made', async () => {
        const grant = await responsibility('immediate');
        const found = await finding(grant);
        const asked = await request(grant);
        expect(pushes).toHaveLength(1);

        // The request was contacted a moment ago: the digest is held, not sent as a second ping.
        const soon = new Date(Date.now() + 60_000);
        await policies.setDigestTime({ userId: OWNER, minute: soon.getUTCHours() * 60 + soon.getUTCMinutes() });
        expect(await delivery.sweep({ now: soon })).toEqual({ contacts: 0, digests: 0, held: 1 });
        expect(pushes).toHaveLength(1);
        expect(await digests()).toEqual([]);

        await policies.setDigestTime({ userId: OWNER, minute: 0 });
        const later = new Date(Date.now() + 26 * 3_600_000);
        expect(await delivery.sweep({ now: later })).toMatchObject({ digests: 1 });
        const [digest] = await digests();
        // The request already went out as a contact: it is not in the digest as well.
        expect(JSON.parse(digest.updateIdsJson)).toEqual([found.id]);
        expect(await outbound(asked.id)).toMatchObject({ outboundKind: 'contact' });
        expect((await contacts()).map(row => row.refId)).toEqual([String(asked.id), `digest:${digest.day}`]);
    });

    test('two requests at once cannot both pass the cap', async () => {
        await policies.enroll({ userId: OWNER, initiative: 'assist' });
        await db.run('UPDATE attention_policies SET maxContactsPerDay = 1, contactCooldownMinutes = 1 WHERE userId = @userId', { userId: OWNER });
        const item = n => ({ kind: 'notice', title: `Item ${n}`, dedupeKey: `race:${n}` });
        const results = await Promise.all([1, 2, 3].map(n => attention.requestContact({
            userId: OWNER, reason: 'assistant', refId: `race:${n}`, gateway, item: item(n)
        })));
        expect(results.filter(result => result.attempted)).toHaveLength(1);
        expect(await contacts()).toHaveLength(1);
        expect(pushes).toHaveLength(1);
        for (const refused of results.filter(result => !result.attempted)) {
            expect(['CONTACT_CAP', 'COOLDOWN']).toContain(refused.code);
            expect(refused.inboxItemId).toBeNull();
        }
    });

    test('outbound notifications turned off, and no channel at all, are refusals that spend nothing', async () => {
        const grant = await responsibility('immediate');
        await userSettings.updateSection({ userId: OWNER, section: 'initiative', changes: { notifyOutbound: false } });
        const asked = await request(grant);
        expect(pushes).toEqual([]);
        expect(dms).toEqual([]);
        expect(await attention.contactAllowed({ userId: OWNER, reason: 'assistant' })).toMatchObject({ allowed: false, code: 'OUTBOUND_OFF' });

        await userSettings.updateSection({ userId: OWNER, section: 'initiative', changes: { notifyOutbound: true } });
        await db.run('DELETE FROM push_subscriptions', {});
        delivery.attach({ gateway: null });
        expect(await attention.requestContact({ userId: OWNER, reason: 'assistant', updateId: asked.id, inboxItemId: 1 }))
            .toMatchObject({ attempted: false, code: 'NO_CHANNEL' });
        expect(await delivery.sweep({ now: at(8) })).toEqual({ contacts: 0, digests: 0, held: 1 });
        expect(await contacts()).toEqual([]);
        expect(await outbound(asked.id)).toMatchObject({ outboundKind: null, outboundRevision: 0 });
    });

    test('a failed Discord DM still spent the contact and is recorded as failed', async () => {
        await db.run('DELETE FROM push_subscriptions', {});
        delivery.attach({ gateway: fakeGateway({ ok: false }) });
        const grant = await responsibility('immediate');
        await request(grant);
        expect(dms).toHaveLength(1);
        expect(await contacts()).toEqual([expect.objectContaining({ discordStatus: 'failed', pushSent: 0 })]);
    });

    test('the ledger keeps codes and ids only, and requestContact refuses what it does not know', async () => {
        const grant = await responsibility('immediate');
        const asked = await request(grant, { title: 'Secret title', summary: 'Secret body' });
        const rows = await db.all('SELECT * FROM attention_contacts', {});
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows)).not.toMatch(/Secret/);
        expect(Object.keys(rows[0]).sort()).toEqual(
            ['createdAt', 'discordStatus', 'id', 'inboxItemId', 'pushSent', 'reason', 'refId', 'urgent', 'userId']
        );
        expect(rows[0].refId).toBe(String(asked.id));

        expect(await attention.requestContact({ userId: OWNER, reason: 'marketing', inboxItemId: 1 }))
            .toMatchObject({ attempted: false, code: 'BAD_REASON' });
        expect(await attention.requestContact({ userId: OWNER, reason: 'assistant' }))
            .toMatchObject({ attempted: false });
        expect(await db.all('SELECT id FROM attention_contacts', {})).toHaveLength(1);
    });
});

describe('delivery is not review', () => {
    test('a push or DM records delivery; the update stays unseen and Home stays highlighted', async () => {
        const grant = await responsibility('immediate');
        const asked = await request(grant);
        expect(pushes).toHaveLength(1);
        expect(await receipt(asked.id)).toMatchObject({ deliveredRevision: 1, acknowledgedRevision: 0 });
        const page = await updates.list({ userId: OWNER });
        expect(page.counts).toMatchObject({ unseen: 1, needsAction: 1 });
        expect(page.updates[0]).toMatchObject({ id: asked.id, unseen: true });
        // The Inbox envelope is unread too.
        expect((await inbox.list({ userId: OWNER })).items[0].readAt).toBeFalsy();
    });

    test('a digest records delivery of each entry and acknowledges none', async () => {
        const grant = await responsibility('digest');
        const first = await finding(grant);
        const second = await finding(grant);
        await delivery.sweep({ now: at(12) });
        for (const update of [first, second]) {
            expect(await receipt(update.id)).toMatchObject({ deliveredRevision: 1, acknowledgedRevision: 0 });
        }
        expect((await updates.list({ userId: OWNER })).counts.unseen).toBe(2);
    });
});

describe('turning it off', () => {
    test('turning Attention off stops outbound contact at once, for what was already waiting', async () => {
        const grant = await responsibility('digest');
        const immediate = await responsibility('immediate');
        await finding(grant);
        await policies.disable(OWNER);
        const asked = await request(immediate);

        expect(pushes).toEqual([]);
        expect(dms).toEqual([]);
        expect(await attention.requestContact({ userId: OWNER, reason: 'assistant', updateId: asked.id, inboxItemId: 1, gateway }))
            .toMatchObject({ contacted: false, attempted: false, code: 'ATTENTION_OFF' });
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 2 });
        expect(await contacts()).toEqual([]);
        expect(await digests()).toEqual([]);
        // The updates themselves are still on Home and in the Inbox.
        expect((await updates.list({ userId: OWNER })).counts.unseen).toBe(2);
    });

    test('the host\'s stop-all and the feature being off both hold delivery', async () => {
        const grant = await responsibility('digest');
        await finding(grant);
        await control.pauseAll();
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 1 });
        await control.resumeAll();

        useState({ inactive: ['assistant'] });
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 0 });
        expect(pushes).toEqual([]);

        useState();
        expect(await delivery.sweep({ now: at(12) })).toMatchObject({ digests: 1 });
    });

    test('a snoozed request is not contacted about while it is snoozed', async () => {
        delivery.detach();
        const grant = await responsibility('immediate');
        const asked = await request(grant);
        await updates.snooze({ userId: OWNER, id: asked.id, until: at(20).toISOString() });
        delivery.attach({ gateway });
        expect(await delivery.sweep({ now: at(8) })).toMatchObject({ contacts: 0 });
        expect(pushes).toEqual([]);
        expect(await delivery.sweep({ now: at(21) })).toMatchObject({ contacts: 1 });
    });
});

describe('the pilot gate', () => {
    test('before the pilot decision only the owner may choose digest or immediate', async () => {
        await policies.enroll({ userId: MEMBER, initiative: 'assist' });
        for (const interruption of ['digest', 'immediate']) {
            const { responsibility: draft } = await responsibilities.create({
                userId: MEMBER, body: { title: `Member ${interruption}`, operations: [READ_WEB], rules: { interruption } }
            });
            await expect(responsibilities.act({ userId: MEMBER, id: draft.id, action: 'activate', expectedRevision: draft.revision }))
                .rejects.toMatchObject({ code: 'PILOT_ONLY', status: 409 });
        }
        // Home-only is everyone's.
        const kept = await responsibility('home', MEMBER);
        expect(kept.status).toBe('ACTIVE');

        await access.recordDecision({ scope: 'everyone' });
        const opened = await responsibility('digest', MEMBER);
        expect(opened.status).toBe('ACTIVE');
    });

    test('a decision taken back holds what a member\'s responsibility still had waiting', async () => {
        await access.recordDecision({ scope: 'everyone' });
        await device(MEMBER);
        const grant = await responsibility('immediate', MEMBER);
        await access.recordDecision({ scope: 'owner' });

        const asked = await request(grant);
        expect(pushes).toEqual([]);
        expect(await delivery.sweep({ now: at(12) })).toEqual({ contacts: 0, digests: 0, held: 1 });
        expect(await outbound(asked.id)).toMatchObject({ outboundKind: null });

        await access.recordDecision({ scope: 'everyone' });
        expect(await delivery.sweep({ now: at(12) })).toMatchObject({ contacts: 1 });
        expect(pushes).toHaveLength(1);
        expect(pushes[0].endpoint).toContain(MEMBER);
    });
});

describe('the steward, retention and erasure', () => {
    test('the steward pass sends what is due and reports it', async () => {
        const grant = await responsibility('digest');
        await finding(grant);
        const result = await steward.sweep({ now: at(12) });
        expect(result.delivery).toEqual({ contacts: 0, digests: 1, held: 0 });
        expect(pushes).toHaveLength(1);
    });

    test('digests are kept 90 days and the contact ledger 30', async () => {
        const now = at(12);
        const days = n => utcText(new Date(now.getTime() - n * 86_400_000));
        await db.run("INSERT INTO assistant_digests (userId, day, createdAt) VALUES (@u, '2026-01-01', @at)", { u: OWNER, at: days(91) });
        await db.run("INSERT INTO assistant_digests (userId, day, createdAt) VALUES (@u, '2026-03-01', @at)", { u: OWNER, at: days(89) });
        await db.run("INSERT INTO attention_contacts (userId, reason, createdAt) VALUES (@u, 'assistant', @at)", { u: OWNER, at: days(31) });
        await db.run("INSERT INTO attention_contacts (userId, reason, createdAt) VALUES (@u, 'assistant', @at)", { u: OWNER, at: days(29) });
        expect(await delivery.prune({ now })).toEqual({ digests: 1, contacts: 1 });
        expect(await digests()).toHaveLength(1);
        expect(await contacts()).toHaveLength(1);
    });

    test('/forget-me removes the digests and the contact ledger, and the report counts them first', async () => {
        const grant = await responsibility('immediate');
        await finding(grant);
        await request(grant);
        await delivery.sweep({ now: at(12, 0, 2) });
        expect(await digests()).toHaveLength(1);
        expect(await contacts()).toHaveLength(2);

        const report = await privacyService.buildUserReport({ guildId: `dm:${OWNER}`, userId: OWNER });
        expect(report.attention.contacts).toBe(2);
        const audit = await privacyService.auditUser({ userId: OWNER });
        expect(audit.byTable).toMatchObject({ assistant_digests: 1, attention_contacts: 2 });

        await privacyService.forgetUser({ userId: OWNER });
        expect(await digests()).toEqual([]);
        expect(await contacts()).toEqual([]);
        expect(await db.get('SELECT COUNT(*) AS n FROM inbox_items WHERE userId = @u', { u: OWNER })).toMatchObject({ n: 0 });
    });
});
