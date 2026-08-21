/**
 * Unit tests for the attention ledger and the initiative policy
 * (services/attentionLedgerService.js, services/attentionPolicyService.js)
 * against a throwaway database.
 *
 * The properties under test are the ones that keep the ledger from turning
 * into a second knowledge graph or an unasked-for task list: identity by
 * (scope, kind, subject), corroboration before belief, provenance for every
 * mined item, bounded legalized mutations, and a per-person cap.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-attention-ledger-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const ledger = require('@goobster/core/services/attentionLedgerService');
const policies = require('@goobster/core/services/attentionPolicyService');
const config = require('@goobster/core/config/attentionConfig');

const USER = '700000000000000001';
const GUILD = '800000000000000001';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    await db.run('DELETE FROM attention_provenance', {});
    await db.run('DELETE FROM attention_items', {});
    await db.run('DELETE FROM attention_policies', {});
});

describe('ledger identity and corroboration', () => {
    test('a loop is identified by scope, kind, and subject', async () => {
        const first = await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'commitment', subject: 'dbt demo'
        });
        const again = await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'commitment', subject: '  DBT   Demo '
        });
        expect(first.created).toBe(true);
        expect(again.created).toBe(false);
        expect(again.id).toBe(first.id);

        // A different kind about the same subject is a different loop: the
        // deadline for the demo is not the commitment to build it.
        const other = await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'deadline', subject: 'dbt demo'
        });
        expect(other.created).toBe(true);
        expect(other.id).not.toBe(first.id);
    });

    test('a mined loop starts as an uncertain candidate', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'commitment', subject: 'finish the demo code'
        });
        const item = await ledger.getItem(id);
        expect(item.state).toBe('candidate');
        expect(item.corroborations).toBe(1);
    });

    test('independent corroboration promotes a candidate, one observation does not', async () => {
        await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'commitment', subject: 'dbt demo', corroborate: true
        });
        let item = (await ledger.listItems({ userId: USER }))[0];
        expect(item.state).toBe('candidate');

        const second = await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'commitment', subject: 'dbt demo', corroborate: true
        });
        expect(second.promoted).toBe(true);
        item = await ledger.getItem(second.id);
        expect(item.state).toBe('corroborated');
        expect(item.corroborations).toBe(2);
    });

    test('an update fills gaps without erasing what was already known', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD,
            userId: USER,
            kind: 'commitment',
            subject: 'dbt demo',
            goal: 'give the presentation Thursday',
            unresolved: ['choose lineage example']
        });
        await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'commitment', subject: 'dbt demo', importance: 0.9
        });
        const item = await ledger.getItem(id);
        expect(item.goal).toBe('give the presentation Thursday');
        expect(item.unresolved).toEqual(['choose lineage example']);
        expect(item.importance).toBeCloseTo(0.9, 5);
    });

    test('field caps are enforced on storage, not trusted from the caller', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD,
            userId: USER,
            kind: 'goal',
            subject: 'x'.repeat(400),
            goal: 'y'.repeat(2000),
            unresolved: Array.from({ length: 40 }, (_, i) => `step ${i}`),
            importance: 12,
            confidence: -3
        });
        const item = await ledger.getItem(id);
        expect(item.subject.length).toBe(config.MAX_SUBJECT_LENGTH);
        expect(item.goal.length).toBe(config.MAX_GOAL_LENGTH);
        expect(item.unresolved.length).toBe(config.MAX_UNRESOLVED_ITEMS);
        expect(item.importance).toBe(1);
        expect(item.confidence).toBe(0);
    });

    test('rejects a loop with no subject or no owner', async () => {
        expect(await ledger.upsertItem({ guildId: GUILD, userId: USER, subject: '   ' })).toBeNull();
        expect(await ledger.upsertItem({ guildId: GUILD, subject: 'orphan' })).toBeNull();
    });

    test('an unknown kind falls back rather than reaching the CHECK constraint', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'vibes', subject: 'unclassified thing'
        });
        expect((await ledger.getItem(id)).kind).toBe('open_question');
    });
});

describe('lifecycle', () => {
    test('resolving stamps a terminal state', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'commitment', subject: 'dbt demo'
        });
        expect(await ledger.setState(id, 'resolved')).toBe(true);
        const item = await ledger.getItem(id);
        expect(item.state).toBe('resolved');
        expect(item.resolvedAt).toBeTruthy();
        // Terminal items drop out of the working set.
        expect(await ledger.listItems({ userId: USER })).toHaveLength(0);
    });

    test('an unknown state is refused', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD, userId: USER, subject: 'thing'
        });
        await expect(ledger.setState(id, 'vanished')).rejects.toThrow(/Unknown attention state/);
    });

    test('expired loops are abandoned by the prune pass', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD,
            userId: USER,
            kind: 'opportunity',
            subject: 'conference CFP',
            expiresAt: new Date(Date.now() + 86_400_000).toISOString()
        });
        expect((await ledger.getItem(id)).state).toBe('candidate');

        await db.run(
            `UPDATE attention_items SET expiresAt = datetime('now', '-1 hours') WHERE id = @id`,
            { id }
        );
        const result = await ledger.pruneUser(USER);
        expect(result.expired).toBe(1);
        expect((await ledger.getItem(id)).state).toBe('abandoned');
    });

    test('a loop that is already expired when recorded never becomes live', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD,
            userId: USER,
            kind: 'opportunity',
            subject: 'CFP that already closed',
            expiresAt: new Date(Date.now() - 86_400_000).toISOString()
        });
        expect((await ledger.getItem(id)).state).toBe('abandoned');
    });

    test('the working set is capped, weakest loops going first', async () => {
        // One clearly valuable loop plus a flood of near-worthless ones.
        await ledger.upsertItem({
            guildId: GUILD,
            userId: USER,
            kind: 'goal',
            subject: 'the important one',
            importance: 1,
            confidence: 1
        });
        for (let i = 0; i < config.MAX_ITEMS_PER_USER + 5; i++) {
            await ledger.upsertItem({
                guildId: GUILD,
                userId: USER,
                kind: 'open_question',
                subject: `noise ${i}`,
                importance: 0.05,
                confidence: 0.05
            });
        }
        const live = await ledger.listItems({ userId: USER, limit: 200 });
        expect(live.length).toBeLessThanOrEqual(config.MAX_ITEMS_PER_USER);
        expect(live.some(item => item.subject === 'the important one')).toBe(true);
    });

    test('touching activity resets staleness', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD, userId: USER, subject: 'moving thing'
        });
        await db.run(
            `UPDATE attention_items SET lastActivityAt = datetime('now', '-30 days') WHERE id = @id`,
            { id }
        );
        await ledger.touchActivity(id);
        const item = await ledger.getItem(id);
        const age = Date.now() - new Date(`${item.lastActivityAt.replace(' ', 'T')}Z`).getTime();
        expect(age).toBeLessThan(60_000);
    });
});

describe('provenance', () => {
    test('records evidence once per source', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD, userId: USER, subject: 'traced thing'
        });
        expect(await ledger.addProvenance({ itemId: id, sourceKind: 'memory', sourceId: 42 })).toBe(true);
        expect(await ledger.addProvenance({ itemId: id, sourceKind: 'memory', sourceId: 42 })).toBe(false);
        const rows = await ledger.getProvenance(id);
        expect(rows).toHaveLength(1);
        expect(rows[0].sourceKind).toBe('memory');
    });

    test('refuses a source kind outside the whitelist', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD, userId: USER, subject: 'traced thing'
        });
        expect(await ledger.addProvenance({ itemId: id, sourceKind: 'vibes' })).toBe(false);
        expect(await ledger.getProvenance(id)).toHaveLength(0);
    });
});

describe('legalized mutations (the model proposes, code decides)', () => {
    test('applies upserts, resolves, and touches with provenance', async () => {
        const applied = await ledger.applyMutations({
            guildId: GUILD,
            userId: USER,
            source: 'reflection',
            mutations: {
                upsert: [{
                    kind: 'commitment',
                    subject: 'dbt demo',
                    goal: 'give presentation Thursday',
                    unresolved: ['choose lineage example', 'finish demo code'],
                    importance: 0.82,
                    confidence: 0.5,
                    provenance: [{ kind: 'memory', id: 7 }]
                }]
            }
        });
        expect(applied.itemsCreated).toBe(1);
        const item = (await ledger.listItems({ userId: USER }))[0];
        expect(item.unresolved).toEqual(['choose lineage example', 'finish demo code']);
        expect(await ledger.getProvenance(item.id)).toHaveLength(1);

        const resolved = await ledger.applyMutations({
            guildId: GUILD,
            userId: USER,
            mutations: { resolve: [{ kind: 'commitment', subject: 'dbt demo', state: 'resolved' }] }
        });
        expect(resolved.itemsResolved).toBe(1);
    });

    test('caps mined confidence: proposals are guesses, however sure they sound', async () => {
        await ledger.applyMutations({
            guildId: GUILD,
            userId: USER,
            mutations: {
                upsert: [{ kind: 'goal', subject: 'certainty', confidence: 1 }]
            }
        });
        const item = (await ledger.listItems({ userId: USER }))[0];
        expect(item.confidence).toBeLessThanOrEqual(config.ATTEND.maxMinedConfidence);
    });

    test('bounds how much one model response may change', async () => {
        const applied = await ledger.applyMutations({
            guildId: GUILD,
            userId: USER,
            mutations: {
                upsert: Array.from({ length: 50 }, (_, i) => ({
                    kind: 'open_question', subject: `proposal ${i}`
                }))
            }
        });
        expect(applied.itemsCreated).toBe(config.ATTEND.maxUpserts);
    });

    test('never invents a loop through resolve or touch', async () => {
        const applied = await ledger.applyMutations({
            guildId: GUILD,
            userId: USER,
            mutations: {
                resolve: [{ kind: 'commitment', subject: 'never existed' }],
                touch: [{ kind: 'goal', subject: 'also never existed' }]
            }
        });
        expect(applied.itemsResolved).toBe(0);
        expect(applied.itemsTouched).toBe(0);
        expect(await ledger.listItems({ userId: USER })).toHaveLength(0);
    });

    test('ignores an empty or malformed payload', async () => {
        for (const mutations of [null, {}, { upsert: 'nope' }, { junk: [1, 2] }]) {
            const applied = await ledger.applyMutations({ guildId: GUILD, userId: USER, mutations });
            expect(ledger.AttentionLedgerService.hasWork(applied)).toBe(false);
        }
    });

    test('hasPayload gates the legalizer on something worth applying', () => {
        const { AttentionLedgerService } = ledger;
        expect(AttentionLedgerService.hasPayload({ upsert: [{ subject: 'x' }] })).toBe(true);
        expect(AttentionLedgerService.hasPayload({ upsert: [] })).toBe(false);
        expect(AttentionLedgerService.hasPayload(null)).toBe(false);
    });
});

describe('prompt view', () => {
    test('describes only loops Goobster is entitled to raise', async () => {
        await ledger.upsertItem({
            guildId: GUILD, userId: USER, kind: 'goal', subject: 'a guess'
        });
        expect(await ledger.describeForPrompt({ userId: USER })).toBeNull();

        const { id } = await ledger.upsertItem({
            guildId: GUILD,
            userId: USER,
            kind: 'commitment',
            subject: 'dbt demo',
            goal: 'give presentation Thursday',
            unresolved: ['finish demo code']
        });
        await ledger.setState(id, 'active');
        const block = await ledger.describeForPrompt({ userId: USER });
        expect(block).toContain('dbt demo');
        expect(block).toContain('finish demo code');
        expect(block).not.toContain('a guess');
    });

    test('reports a deadline in relative terms', async () => {
        const { id } = await ledger.upsertItem({
            guildId: GUILD,
            userId: USER,
            kind: 'deadline',
            subject: 'presentation',
            deadlineAt: new Date(Date.now() + 3 * 86_400_000).toISOString()
        });
        await ledger.setState(id, 'active');
        expect(await ledger.describeForPrompt({ userId: USER })).toMatch(/deadline in 3d/);
    });
});

describe('initiative policy', () => {
    test('nobody is enrolled by default', async () => {
        expect(await policies.get(USER)).toBeNull();
        expect(await policies.listActive()).toHaveLength(0);
    });

    test('enrollment is idempotent and re-enrolling revives a disabled row', async () => {
        const first = await policies.enroll({ userId: USER });
        expect(first.initiative).toBe('nudge');
        expect(first.enabled).toBe(true);

        await policies.disable(USER);
        expect((await policies.get(USER)).enabled).toBe(false);
        expect(await policies.listActive()).toHaveLength(0);

        const revived = await policies.enroll({ userId: USER });
        expect(revived.enabled).toBe(true);
    });

    test('disabling keeps the ledger, so re-enabling resumes', async () => {
        await policies.enroll({ userId: USER });
        await ledger.upsertItem({ guildId: GUILD, userId: USER, subject: 'kept loop' });
        await policies.disable(USER);
        expect(await ledger.listItems({ userId: USER })).toHaveLength(1);
    });

    test('rejects an initiative level outside the spectrum', async () => {
        await expect(policies.setInitiative(USER, 'omniscient')).rejects.toThrow(/Initiative must be/);
    });

    test('per-category boundaries override the defaults partially', async () => {
        await policies.enroll({ userId: USER });
        const policy = await policies.setBoundary({
            userId: USER, category: 'github', proactiveCompute: false
        });
        const github = policies.boundariesFor(policy, 'github');
        expect(github.proactiveCompute).toBe(false);
        // Untouched fields keep the shipped default.
        expect(github.proactiveRead).toBe(true);
        expect(github.externalWrite).toBe('never');
    });

    test('both gates must pass before an action is allowed', async () => {
        const policy = await policies.setInitiative(USER, 'nudge');
        // nudge covers reading, but computing needs assist.
        expect(policies.allows(policy, 'research', 'read')).toBe(true);
        expect(policies.allows(policy, 'research', 'compute')).toBe(false);

        const assist = await policies.setInitiative(USER, 'assist');
        expect(policies.allows(assist, 'research', 'compute')).toBe(true);
        // The category boundary still refuses the write, whatever the level.
        const delegate = await policies.setInitiative(USER, 'delegate');
        expect(policies.allows(delegate, 'research', 'write')).toBe('confirm');
        expect(policies.allows(delegate, 'github', 'write')).toBe(false);
    });

    test('a disabled policy allows nothing at all', async () => {
        await policies.setInitiative(USER, 'delegate');
        await policies.disable(USER);
        const policy = await policies.get(USER);
        expect(policies.allows(policy, 'research', 'read')).toBe(false);
    });

    test('quiet hours cover windows that wrap past midnight', async () => {
        await policies.enroll({ userId: USER });
        const policy = await policies.setQuietHours({
            userId: USER, startMinute: 22 * 60, endMinute: 7 * 60
        });
        expect(policies.inQuietHours(policy, new Date('2026-08-21T23:30:00Z'))).toBe(true);
        expect(policies.inQuietHours(policy, new Date('2026-08-21T03:00:00Z'))).toBe(true);
        expect(policies.inQuietHours(policy, new Date('2026-08-21T12:00:00Z'))).toBe(false);
    });

    test('quiet hours need both ends, and clear together', async () => {
        await policies.enroll({ userId: USER });
        await expect(policies.setQuietHours({ userId: USER, startMinute: 60 }))
            .rejects.toThrow(/both a start and an end/);
        const cleared = await policies.setQuietHours({ userId: USER });
        expect(policies.inQuietHours(cleared)).toBe(false);
    });

    test('the contact budget is clamped to a sane range', async () => {
        await policies.enroll({ userId: USER });
        const policy = await policies.setBudget({
            userId: USER, maxContactsPerDay: 999, contactCooldownMinutes: 1
        });
        expect(policy.maxContactsPerDay).toBe(20);
        expect(policy.contactCooldownMinutes).toBe(5);
    });

    test('dirtied people jump the sweep rotation', async () => {
        const other = '700000000000000002';
        await policies.enroll({ userId: USER });
        await policies.enroll({ userId: other });
        await db.run(
            `INSERT INTO attention_state (userId, lastSweepAt) VALUES (@a, datetime('now'))`,
            { a: USER }
        );
        await db.run(
            `INSERT INTO attention_state (userId, lastSweepAt, dirtyAt)
             VALUES (@b, datetime('now', '-1 minutes'), datetime('now'))`,
            { b: other }
        );
        const active = await policies.listActive(10);
        expect(active[0].userId).toBe(other);
    });
});
