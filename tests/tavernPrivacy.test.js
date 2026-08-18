/**
 * Tavern data in the privacy surface: /forget-me deletes the character and
 * party seats, anonymizes shared adventure records, scrubs state JSON, and
 * the review pass drops log prose naming the user's character. The audit
 * must come back clean.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-tavern-privacy-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const privacyService = require('@goobster/core/services/privacyService');
const characterService = require('@goobster/core/services/tavern/characterService');
const { AdventureService } = require('@goobster/core/services/tavern/adventureService');

const GUILD = '500000000000000001';
const CHANNEL = '500000000000000010';
const USER = '500000000000000101';
const OTHER = '500000000000000102';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

test('/forget-me erases tavern data and the audit comes back clean', () => {
    characterService.createCharacter({
        guildId: GUILD, userId: USER, name: 'Zanzibar Quillfeather', origin: 'Clockwork pilgrim',
        calling: 'mystic', complication: 'Allergic to prophecy',
        stats: { might: 1, finesse: 1, wits: 2, heart: 2 }
    });
    characterService.createCharacter({
        guildId: GUILD, userId: OTHER, name: 'Innocent Bystander', origin: 'Local farmer',
        calling: 'guide', complication: 'Will not abandon anyone',
        stats: { might: 2, finesse: 2, wits: 1, heart: 1 }
    });

    const service = new AdventureService(() => 0.9); // rolls 19s
    const { adventure } = service.createParty({ guildId: GUILD, channelId: CHANNEL, questId: 'missing-bell-of-brinewatch', userId: USER });
    service.join(adventure.id, OTHER);
    service.begin(adventure.id, USER);
    service.chooseOption(adventure.id, USER, 'question-pell');

    // Sanity: the log names Zanzibar, and the state carries the user's id
    expect(db.get(`SELECT COUNT(*) AS c FROM tavern_adventure_log WHERE content LIKE '%Zanzibar%'`).c).toBeGreaterThan(0);
    expect(db.get('SELECT state FROM tavern_adventures WHERE id = @id', { id: adventure.id }).state).toContain(USER);

    const report = privacyService.buildUserReport({ guildId: GUILD, userId: USER });
    expect(report.tavernCharacter.name).toBe('Zanzibar Quillfeather');

    const counts = privacyService.forgetUser({ userId: USER, extraNames: ['SomeDiscordName'] });
    expect(counts.tavern).toBeGreaterThanOrEqual(2); // character + party seat
    expect(counts.reviewedTavernLog).toBeGreaterThan(0);

    // Character gone, other player untouched
    expect(characterService.getCharacter(GUILD, USER)).toBeNull();
    expect(characterService.getCharacter(GUILD, OTHER).name).toBe('Innocent Bystander');

    // Shared adventure survives, but carries no trace of the user
    const row = db.get('SELECT createdBy, state FROM tavern_adventures WHERE id = @id', { id: adventure.id });
    expect(row.createdBy).toBeNull();
    expect(row.state).not.toContain(USER);
    expect(db.get(`SELECT COUNT(*) AS c FROM tavern_adventure_log WHERE content LIKE '%Zanzibar%'`).c).toBe(0);
    expect(db.get('SELECT COUNT(*) AS c FROM tavern_adventure_log WHERE userId = @u', { u: USER }).c).toBe(0);

    const audit = privacyService.auditUser({ userId: USER });
    expect(audit.byTable.tavern_characters).toBe(0);
    expect(audit.byTable.tavern_party_members).toBe(0);
    expect(audit.byTable.tavern_adventure_log).toBe(0);
    expect(audit.total).toBe(0);
});
