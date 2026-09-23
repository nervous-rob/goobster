/**
 * Backup and tested restore (roadmap #249).
 *
 * Drives the whole path headless on a throwaway database and data
 * directory: an archive is written (database snapshot, file sets, an
 * encrypted config.json, the names of environment secrets that were set),
 * inspected, and restored into a fresh installation - which comes back
 * paused, with every piece of in-flight work marked failed and recorded in
 * work_failures. The engine and schema gates, the passphrase cases, the
 * paused core runtime, the resume that skips missed schedules, the erasure
 * path for work_failures and the two CLI scripts are covered too. Runs on
 * both engines; the parts that must differ (fresh SQLite file vs. the same
 * Postgres schema, child processes) branch on db.engine.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const express = require('express');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-backup-restore-'));
const SOURCE_DB = path.join(ROOT, 'source', 'goobster.sqlite');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');
process.env.GOOBSTER_DB_PATH = SOURCE_DB;
process.env.GOOBSTER_DATA_DIR = DATA_DIR;
process.env.GOOBSTER_CONFIG_PATH = CONFIG_PATH;
for (const name of ['GOOBSTER_UPLOADS_DIR', 'GOOBSTER_KG_ARTIFACTS_DIR', 'GOOBSTER_TAVERN_CAMPAIGNS_DIR', 'ELEVENLABS_API_KEY']) {
    delete process.env[name];
}

const db = require('@goobster/core/db');
const backupService = require('@goobster/core/services/backupService');
const instanceState = require('@goobster/core/services/instanceStateService');
const workFailures = require('@goobster/core/services/workFailureService');
const webSessionService = require('@goobster/core/services/webSessionService');
const followupService = require('@goobster/core/services/followupService');
const inboxService = require('@goobster/core/services/inboxService');
const privacyService = require('@goobster/core/services/privacyService');
const { encryptWithPassphrase, decryptWithPassphrase, PassphraseError } = require('@goobster/core/utils/passphraseCrypto');
const { DisabledGateway } = require('@goobster/core/gateway');
const { startCoreRuntime } = require('@goobster/core/runtime/coreRuntime');

const { BackupError, INTERRUPTED_REASON, INTERRUPTED_CODE } = backupService;
const PG = db.engine === 'postgres';
const SCRIPTS = path.join(__dirname, '..', 'scripts');

const USER = '100000000000000042';
const OTHER = '100000000000000043';
const GUILD = '200000000000000001';
const CHANNEL = '300000000000000001';
const PASSPHRASE = 'correct horse battery staple';
const DISCORD_TOKEN = 'MTAw.SECRET-DISCORD-TOKEN-do-not-leak';

function utcText(date) {
    return new Date(date).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
const HOUR = 3_600_000;
/** Milliseconds for a stored UTC 'YYYY-MM-DD HH:MM:SS' (or a Date the driver returned). */
const toMs = (value) => value instanceof Date ? value.getTime() : Date.parse(`${String(value).replace(' ', 'T')}Z`);
const ago = (hours) => utcText(Date.now() - hours * HOUR);
const ahead = (hours) => utcText(Date.now() + hours * HOUR);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** Every file under `dir`, relative, with contents. */
function walk(dir, prefix = '') {
    const out = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = path.join(prefix, entry.name);
        if (entry.isDirectory()) Object.assign(out, walk(path.join(dir, entry.name), rel));
        else out[rel] = fs.readFileSync(path.join(dir, entry.name));
    }
    return out;
}

async function expectBackupError(promise, code) {
    let caught = null;
    try {
        await promise;
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(BackupError);
    expect(caught.code).toBe(code);
    return caught;
}

/** The world an operator would back up: sessions, schedules, in-flight work, files, config. */
const seeded = {};
async function seedInstallation() {
    seeded.session = await webSessionService.create({ userId: USER, userName: 'Rob' });

    // Schedules that will come due during the "downtime".
    seeded.pastOneShot = await db.insert(
        `INSERT INTO followups (guildId, channelId, userId, note, dueAt, status)
         VALUES (@guildId, @channelId, @userId, @note, @dueAt, 'PENDING')`,
        { guildId: GUILD, channelId: CHANNEL, userId: USER, note: 'call the vet', dueAt: ago(5) }
    );
    seeded.pastRecurring = await db.insert(
        `INSERT INTO followups (guildId, channelId, userId, note, dueAt, status, recurMinutes)
         VALUES (@guildId, @channelId, @userId, @note, @dueAt, 'PENDING', 60)`,
        { guildId: GUILD, channelId: CHANNEL, userId: USER, note: 'hourly stretch', dueAt: ago(5) }
    );
    seeded.futureOneShot = await db.insert(
        `INSERT INTO followups (guildId, channelId, userId, note, dueAt, status)
         VALUES (@guildId, @channelId, @userId, @note, @dueAt, 'PENDING')`,
        { guildId: GUILD, channelId: CHANNEL, userId: USER, note: 'still ahead', dueAt: ahead(5) }
    );
    seeded.automation = await db.insert(
        `INSERT INTO automations (userId, guildId, channelId, name, promptText, schedule, isEnabled, nextRun)
         VALUES (@userId, @guildId, @channelId, 'digest', 'Summarize the day', '0 9 * * *', 1, @nextRun)`,
        { userId: USER, guildId: GUILD, channelId: CHANNEL, nextRun: ago(30) }
    );

    seeded.project = await db.insert(
        'INSERT INTO observatory_projects (userId, slug, name) VALUES (@userId, @slug, @name)',
        { userId: USER, slug: 'restore-demo', name: 'Restore demo' }
    );
    seeded.cronTrigger = await db.insert(
        `INSERT INTO project_triggers (projectId, userId, name, kind, schedule, nextRun, action, isEnabled)
         VALUES (@projectId, @userId, 'nightly', 'cron', '0 3 * * *', @nextRun, 'run_script', 1)`,
        { projectId: seeded.project, userId: USER, nextRun: ago(20) }
    );
    seeded.eventTrigger = await db.insert(
        `INSERT INTO project_triggers (projectId, userId, name, kind, eventTopic, action, isEnabled)
         VALUES (@projectId, @userId, 'on-settle', 'event', 'job_settled', 'run_script', 1)`,
        { projectId: seeded.project, userId: USER }
    );
    // A job that settled during the downtime and was never reacted to.
    seeded.settledJob = await db.insert(
        `INSERT INTO observatory_jobs (projectId, userId, language, code, status, finishedAt)
         VALUES (@projectId, @userId, 'python', 'print(1)', 'COMPLETED', @finishedAt)`,
        { projectId: seeded.project, userId: USER, finishedAt: ago(2) }
    );

    // In-flight work, one of each kind restore has to fail.
    seeded.runningJob = await db.insert(
        `INSERT INTO observatory_jobs (projectId, userId, language, code, status, runnerId, leaseToken)
         VALUES (@projectId, @userId, 'python', 'while True: pass', 'RUNNING', 'runner-1', 'lease-1')`,
        { projectId: seeded.project, userId: USER }
    );
    seeded.interruptedJob = await db.insert(
        `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
         VALUES (@projectId, @userId, 'python', 'pass', 'INTERRUPTED')`,
        { projectId: seeded.project, userId: OTHER }
    );
    seeded.expedition = await db.insert(
        `INSERT INTO spitball_expeditions (userId, guildId, seed, status, runnerId)
         VALUES (@userId, @guildId, 'tide pools', 'RUNNING', 'runner-1')`,
        { userId: USER, guildId: GUILD }
    );
    await db.insert(
        `INSERT INTO spitball_expedition_cycles (expeditionId, cycleNumber, status) VALUES (@id, 1, 'RUNNING')`,
        { id: seeded.expedition }
    );
    seeded.mission = await db.insert(
        `INSERT INTO project_missions (projectId, userId, title, objective, successCriteriaJson, status)
         VALUES (@projectId, @userId, 'Ship it', 'Get the thing done', '[]', 'ACTIVE')`,
        { projectId: seeded.project, userId: USER }
    );
    seeded.step = await db.insert(
        `INSERT INTO project_mission_steps (missionId, userId, kind, title, status)
         VALUES (@missionId, @userId, 'job', 'Run the script', 'RUNNING')`,
        { missionId: seeded.mission, userId: USER }
    );
    seeded.sandbox = await db.insert(
        `INSERT INTO sandbox_requests (type, userId, payload, status) VALUES ('package-install', @userId, '{}', 'EXECUTING')`,
        { userId: USER }
    );
    seeded.integrationAction = await db.insert(
        `INSERT INTO pending_integration_actions (type, guildId, channelId, requestedBy, payload, status)
         VALUES ('github-issue', @guildId, @channelId, @userId, '{}', 'EXECUTING')`,
        { guildId: GUILD, channelId: CHANNEL, userId: USER }
    );
    seeded.watch = await db.insert(
        `INSERT INTO attention_watches (userId, guildId, label, topic, promptText, status)
         VALUES (@userId, @guildId, 'when done', 'job', 'Tell me', 'FIRING')`,
        { userId: USER, guildId: GUILD }
    );
    seeded.delivery = await db.insert(
        `INSERT INTO project_trigger_deliveries (triggerId, sourceJobId, projectId, status, attempts)
         VALUES (@triggerId, @sourceJobId, @projectId, 'STARTED', 1)`,
        { triggerId: seeded.cronTrigger, sourceJobId: seeded.runningJob, projectId: seeded.project }
    );
    seeded.reflection = await db.insert(
        `INSERT INTO kg_reflection_runs (guildId, requestedBy, status, passes) VALUES (@guildId, @userId, 'running', 1)`,
        { guildId: GUILD, userId: USER }
    );
    await db.run(
        `INSERT INTO web_live_turns (userId, turnId, startedAtMs) VALUES (@userId, 'turn-live-1', @now)`,
        { userId: USER, now: Date.now() }
    );
    await db.run(
        `INSERT INTO web_chat_queue (userId, position, message) VALUES (@userId, 1, 'queued while streaming')`,
        { userId: USER }
    );
    await db.run(
        `INSERT INTO execution_admissions (id, resource, actorId, state, createdAt, expiresAt)
         VALUES ('adm-1', 'sandbox', @userId, 'running', @now, @expiresAt)`,
        { userId: USER, now: Date.now(), expiresAt: Date.now() + HOUR }
    );

    // Files and configuration.
    fs.mkdirSync(path.join(DATA_DIR, 'sandbox', 'projects', 'restore-demo'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'sandbox', 'projects', 'restore-demo', 'main.py'), 'print("hello")\n');
    fs.mkdirSync(path.join(DATA_DIR, 'web-uploads'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'web-uploads', 'notes.txt'), 'uploaded\n');
    fs.mkdirSync(path.join(DATA_DIR, 'tavern', 'campaigns'), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'tavern', 'campaigns', 'override.yaml'), 'id: override\n');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ clientId: '1', guildIds: [GUILD], token: DISCORD_TOKEN }, null, 2));
}

let archive;
let manifest;

beforeAll(async () => {
    fs.mkdirSync(path.dirname(SOURCE_DB), { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    await seedInstallation();
});

afterAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('passphrase envelope', () => {
    test('round-trips, and a wrong passphrase or a tampered envelope fails before any plaintext exists', () => {
        const envelope = encryptWithPassphrase('{"token":"abc"}', PASSPHRASE);
        expect(envelope.format).toBe('goobster-passphrase-v1');
        expect(envelope.cipher).toBe('aes-256-gcm');
        expect(envelope.kdf.name).toBe('scrypt');
        expect(JSON.stringify(envelope)).not.toContain('abc');
        expect(decryptWithPassphrase(envelope, PASSPHRASE).toString('utf8')).toBe('{"token":"abc"}');

        let wrong;
        try { decryptWithPassphrase(envelope, 'nope'); } catch (error) { wrong = error; }
        expect(wrong).toBeInstanceOf(PassphraseError);
        expect(wrong.code).toBe('BAD_PASSPHRASE');

        const tampered = { ...envelope, ciphertext: Buffer.from('tampered-bytes').toString('base64') };
        let altered;
        try { decryptWithPassphrase(tampered, PASSPHRASE); } catch (error) { altered = error; }
        expect(altered?.code).toBe('BAD_PASSPHRASE');

        expect(() => encryptWithPassphrase('x', '')).toThrow(PassphraseError);
        expect(() => decryptWithPassphrase({ format: 'other' }, PASSPHRASE)).toThrow(/Not a recognised/);
    });
});

describe('backup', () => {
    test('refuses to store config.json without a passphrase, and never in plaintext', async () => {
        await expectBackupError(
            backupService.createBackup({ destDir: path.join(ROOT, 'out-refused'), logger: quiet }),
            'PASSPHRASE_REQUIRED'
        );
        expect(fs.existsSync(path.join(ROOT, 'out-refused'))).toBe(false);
    });

    test('writes an archive with the database, the file sets, an encrypted config.json and the secret names', async () => {
        process.env.ELEVENLABS_API_KEY = 'el-secret-value';
        try {
            ({ dir: archive, manifest } = await backupService.createBackup({
                destDir: path.join(ROOT, 'backups'), passphrase: PASSPHRASE, logger: quiet
            }));
        } finally {
            delete process.env.ELEVENLABS_API_KEY;
        }
        expect(path.basename(archive)).toMatch(/^goobster-backup-\d{4}-\d{2}-\d{2}T/);
        expect(manifest.format).toBe(1);
        expect(manifest.engine).toBe(db.engine);
        expect(manifest.schemaFingerprint).toBe(backupService.schemaFingerprint());
        expect(manifest.schemaFingerprint).toMatch(/^[0-9a-f]{16}$/);
        expect(manifest.database.kind).toBe(PG ? 'pg-dump' : 'sqlite-file');
        expect(fs.existsSync(path.join(archive, manifest.database.file))).toBe(true);

        // Counts describe what was there.
        expect(manifest.tables.web_sessions).toBe(1);
        expect(manifest.tables.followups).toBe(3);
        expect(manifest.tables.observatory_jobs).toBe(3);
        expect(manifest.tables.memory_vec_1536).toBeUndefined();

        // File sets come along, resolved against the data directory.
        expect(manifest.files.map(f => f.id).sort()).toEqual(['projects', 'tavern-campaigns', 'uploads']);
        const files = walk(archive);
        expect(files[path.join('files', 'projects', 'restore-demo', 'main.py')].toString()).toBe('print("hello")\n');
        expect(files[path.join('files', 'uploads', 'notes.txt')].toString()).toBe('uploaded\n');

        // config.json is inside, encrypted; the token appears nowhere in plaintext.
        expect(manifest.config).toEqual({ included: true, encrypted: true, file: 'config.json.enc' });
        for (const [name, contents] of Object.entries(files)) {
            if (name.startsWith('database')) continue;
            expect(contents.toString('latin1')).not.toContain(DISCORD_TOKEN);
        }
        const envelope = JSON.parse(files['config.json.enc'].toString('utf8'));
        expect(JSON.parse(decryptWithPassphrase(envelope, PASSPHRASE).toString('utf8')).token).toBe(DISCORD_TOKEN);

        // Environment secrets: names only, never values.
        expect(manifest.envSecrets.present).toContain('ELEVENLABS_API_KEY');
        expect(JSON.stringify(manifest)).not.toContain('el-secret-value');

        expect(backupService.inspectBackup(archive)).toEqual(manifest);
    });

    test('--skip-config leaves configuration out and needs no passphrase', async () => {
        const { dir, manifest: m } = await backupService.createBackup({
            destDir: path.join(ROOT, 'backups-noconfig'), includeConfig: false, logger: quiet
        });
        expect(m.config.included).toBe(false);
        expect(fs.existsSync(path.join(dir, 'config.json.enc'))).toBe(false);
    });

    test('inspect rejects directories that are not archives and manifests it cannot trust', async () => {
        expect(() => backupService.inspectBackup(ROOT)).toThrow(expect.objectContaining({ code: 'NOT_AN_ARCHIVE' }));
        const broken = path.join(ROOT, 'broken-archive');
        fs.mkdirSync(broken, { recursive: true });
        fs.writeFileSync(path.join(broken, 'manifest.json'), '{ not json');
        expect(() => backupService.inspectBackup(broken)).toThrow(expect.objectContaining({ code: 'BAD_MANIFEST' }));
        fs.writeFileSync(path.join(broken, 'manifest.json'), JSON.stringify({ ...manifest, format: 99 }));
        expect(() => backupService.inspectBackup(broken)).toThrow(expect.objectContaining({ code: 'BAD_FORMAT' }));
        fs.writeFileSync(path.join(broken, 'manifest.json'), JSON.stringify(manifest));
        expect(() => backupService.inspectBackup(broken)).toThrow(/missing its database snapshot/);
    });
});

/** A copy of the archive with an edited manifest. */
function archiveVariant(name, patch) {
    const dir = path.join(ROOT, 'variants', name);
    fs.cpSync(archive, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ...patch }, null, 2));
    return dir;
}

describe('restore gates', () => {
    test('refuses another engine with the migration path spelled out', async () => {
        const other = archiveVariant('other-engine', { engine: PG ? 'sqlite' : 'postgres' });
        const error = await expectBackupError(backupService.restoreBackup({ dir: other, logger: quiet }), 'ENGINE_MISMATCH');
        expect(error.message).toMatch(/migrate-to-postgres/);
    });

    test('refuses another schema fingerprint unless the change is accepted', async () => {
        const other = archiveVariant('other-schema', { schemaFingerprint: '0000000000000000' });
        const error = await expectBackupError(backupService.restoreBackup({ dir: other, logger: quiet }), 'SCHEMA_MISMATCH');
        expect(error.archiveSchema).toBe('0000000000000000');
        expect(error.targetSchema).toBe(backupService.schemaFingerprint());
    });

    test('a wrong passphrase restores nothing and the target config.json is untouched', async () => {
        const before = fs.readFileSync(CONFIG_PATH, 'utf8');
        const countsBefore = await backupService.tableCounts();
        await expectBackupError(
            backupService.restoreBackup({ dir: archive, passphrase: 'wrong', force: true, logger: quiet }),
            'BAD_PASSPHRASE'
        );
        expect(fs.readFileSync(CONFIG_PATH, 'utf8')).toBe(before);
        expect(await backupService.tableCounts()).toEqual(countsBefore);
        expect(await instanceState.isPaused()).toBe(false);
    });

    test('refuses to replace an installation that already has data without --force', async () => {
        await expectBackupError(backupService.restoreBackup({ dir: archive, logger: quiet }), 'TARGET_NOT_EMPTY');
        expect(await instanceState.isPaused()).toBe(false);
    });
});

describe('restore into a fresh installation', () => {
    let report;
    const RESTORED_DATA_DIR = path.join(ROOT, 'restored-data');
    const RESTORED_CONFIG = path.join(ROOT, 'restored-config.json');

    beforeAll(async () => {
        process.env.ELEVENLABS_API_KEY = 'set-on-the-new-box-too';
        try {
            if (PG) {
                // Same database, same schema: the only fresh target Postgres
                // tests can have, so this is a forced replace.
                report = await backupService.restoreBackup({
                    dir: archive, passphrase: PASSPHRASE, force: true,
                    dataDir: RESTORED_DATA_DIR, configPath: RESTORED_CONFIG, by: 'jest', logger: quiet
                });
            } else {
                await db.closeConnection();
                process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'target', 'goobster.sqlite');
                report = await backupService.restoreBackup({
                    dir: archive, passphrase: PASSPHRASE,
                    dataDir: RESTORED_DATA_DIR, configPath: RESTORED_CONFIG, by: 'jest', logger: quiet
                });
            }
        } finally {
            delete process.env.ELEVENLABS_API_KEY;
        }
    });

    test('brings the data back: every table count matches and a session issued before the backup still works', async () => {
        expect(report.engine).toBe(db.engine);
        expect(report.schemaChanged).toBe(false);
        expect(report.replacedExisting).toBe(PG);
        expect(report.counts.mismatches).toEqual([]);
        for (const [table, expected] of Object.entries(manifest.tables)) {
            if (backupService.COUNT_EXEMPT.has(table)) continue;
            expect(report.counts.actual[table]).toBe(expected);
        }
        const session = await webSessionService.get(seeded.session.token, { touch: false });
        expect(session?.userId).toBe(USER);
        if (!PG) {
            expect(fs.existsSync(process.env.GOOBSTER_DB_PATH)).toBe(true);
            expect(report.setAside).toEqual([]);
        }
    });

    test('puts the file sets back under this installation\'s data directory', () => {
        expect(report.files.map(f => f.id).sort()).toEqual(['projects', 'tavern-campaigns', 'uploads']);
        expect(fs.readFileSync(path.join(RESTORED_DATA_DIR, 'sandbox', 'projects', 'restore-demo', 'main.py'), 'utf8')).toBe('print("hello")\n');
        expect(fs.readFileSync(path.join(RESTORED_DATA_DIR, 'web-uploads', 'notes.txt'), 'utf8')).toBe('uploaded\n');
        expect(fs.readFileSync(path.join(RESTORED_DATA_DIR, 'tavern', 'campaigns', 'override.yaml'), 'utf8')).toBe('id: override\n');
    });

    test('decrypts config.json into place and lists the environment secrets to re-enter', () => {
        expect(report.config).toEqual({ restored: true, path: RESTORED_CONFIG, skipped: null });
        expect(JSON.parse(fs.readFileSync(RESTORED_CONFIG, 'utf8')).token).toBe(DISCORD_TOKEN);
        expect(report.secretsToReenter.join('\n')).toMatch(/ELEVENLABS_API_KEY \(ElevenLabs speech\)/);
        expect(report.secretsToReenter.join('\n')).not.toMatch(/config\.json: recreate/);
    });

    test('marks every piece of in-flight work failed with one fixed reason - nothing is left for a retry', async () => {
        expect(report.interrupted).toEqual({
            job: 2, expedition: 1, mission_step: 1, sandbox: 1, integration_action: 1,
            watch: 1, delivery: 1, reflection: 1, chat: 1
        });
        const jobs = await db.all('SELECT id, status, error, runnerId, leaseToken FROM observatory_jobs ORDER BY id');
        expect(jobs.find(j => j.id === seeded.settledJob).status).toBe('COMPLETED');
        for (const id of [seeded.runningJob, seeded.interruptedJob]) {
            const job = jobs.find(j => j.id === id);
            expect(job).toMatchObject({ status: 'FAILED', error: INTERRUPTED_REASON, runnerId: null, leaseToken: null });
        }
        expect((await db.get(`SELECT COUNT(*) AS c FROM observatory_jobs WHERE status IN ('RUNNING', 'INTERRUPTED')`)).c).toBe(0);
        expect(await db.get('SELECT status, stopReason, lastError FROM spitball_expeditions WHERE id = @id', { id: seeded.expedition }))
            .toMatchObject({ status: 'FAILED', stopReason: 'RESTORE', lastError: INTERRUPTED_REASON });
        expect((await db.get('SELECT status FROM spitball_expedition_cycles WHERE expeditionId = @id', { id: seeded.expedition })).status).toBe('CANCELLED');
        expect((await db.get('SELECT status FROM project_mission_steps WHERE id = @id', { id: seeded.step })).status).toBe('FAILED');
        expect(await db.get('SELECT status, error FROM sandbox_requests WHERE id = @id', { id: seeded.sandbox }))
            .toMatchObject({ status: 'FAILED', error: INTERRUPTED_REASON });
        expect((await db.get('SELECT status FROM pending_integration_actions WHERE id = @id', { id: seeded.integrationAction })).status).toBe('CANCELLED');
        expect(await db.get('SELECT status, lastError FROM attention_watches WHERE id = @id', { id: seeded.watch }))
            .toMatchObject({ status: 'FAILED', lastError: INTERRUPTED_REASON });
        expect(await db.get('SELECT status, detail FROM project_trigger_deliveries WHERE id = @id', { id: seeded.delivery }))
            .toMatchObject({ status: 'FAILED', detail: INTERRUPTED_REASON });
        expect((await db.get('SELECT status FROM kg_reflection_runs WHERE id = @id', { id: seeded.reflection })).status).toBe('failed');
        expect((await db.get('SELECT COUNT(*) AS c FROM web_live_turns')).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM web_chat_queue')).c).toBe(0);
        expect((await db.get('SELECT COUNT(*) AS c FROM execution_admissions')).c).toBe(0);
    });

    test('records one work_failures row per interrupted piece, with the owner and no body', async () => {
        const rows = await db.all('SELECT kind, workId, phase, code, reason, actor FROM work_failures ORDER BY id');
        expect(rows).toHaveLength(10);
        expect(new Set(rows.map(r => r.kind))).toEqual(new Set([
            'job', 'expedition', 'mission_step', 'sandbox', 'integration_action', 'watch', 'delivery', 'reflection', 'chat'
        ]));
        for (const row of rows) {
            expect(row.code).toBe(INTERRUPTED_CODE);
            expect(row.reason).toBe(INTERRUPTED_REASON);
        }
        expect(rows.find(r => r.kind === 'job' && r.workId === String(seeded.runningJob))).toMatchObject({ phase: 'RUNNING', actor: USER });
        expect(rows.find(r => r.kind === 'job' && r.workId === String(seeded.interruptedJob))).toMatchObject({ phase: 'INTERRUPTED', actor: OTHER });
        expect(rows.find(r => r.kind === 'chat')).toMatchObject({ workId: 'turn-live-1', phase: 'streaming', actor: USER });
        expect(JSON.stringify(rows)).not.toContain('queued while streaming');
        expect(JSON.stringify(rows)).not.toContain('while True');

        const mine = await workFailures.listForUser(USER);
        expect(mine).toHaveLength(9);
        expect(mine[0]).not.toHaveProperty('actor');
        expect(await workFailures.listForWork('expedition', seeded.expedition)).toHaveLength(1);
    });

    test('leaves the instance paused with the restore on record', async () => {
        expect(await instanceState.isPaused()).toBe(true);
        const state = await instanceState.describe();
        expect(state.paused).toMatchObject({ reason: 'restore', by: 'jest' });
        expect(state.paused.detail.archive).toBe(path.basename(archive));
        expect(state.paused.detail.interrupted).toEqual(report.interrupted);
        expect(state.lastRestore).toMatchObject({ archive: path.basename(archive), engine: db.engine, configRestored: true, by: 'jest' });
        expect(state.lastResume).toBeNull();
        // A second pause keeps the first record.
        const again = await instanceState.pause({ reason: 'operator', by: 'someone-else' });
        expect(again.by).toBe('jest');
    });
});

describe('paused runtime and resume', () => {
    function fakeDeps(log) {
        const worker = (name) => ({ start: () => log.push(`start:${name}`), stop: () => log.push(`stop:${name}`), close: () => log.push(`stop:${name}`) });
        class FakeAutomation { start() { log.push('start:automation'); } stop() { log.push('stop:automation'); } }
        class FakePersonal { start() { log.push('start:personal'); } stop() { log.push('stop:personal'); } }
        return {
            eventBusService: worker('eventBus'),
            chatHistoryRetentionService: worker('retention'),
            selfDocsService: { seedOnStartup: async () => { log.push('selfDocs'); return { acquired: false }; } },
            workshopPinMigration: { runOnStartup: async () => ({ acquired: false }) },
            observatoryService: { autoResumeInterrupted: async () => { log.push('observatoryResume'); return []; } },
            projectMissionService: { reconcileStartingSteps: async () => 0, reconcileRunningSteps: async () => 0 },
            projectTriggerService: { catchUpEventTriggers: async () => { log.push('catchUp'); return 0; } },
            AutomationService: FakeAutomation,
            followupDeliveryService: { deliverDue: async () => ({ delivered: 0, left: 0 }) },
            PersonalHeartbeatService: FakePersonal,
            spitballExpeditionRunner: { start: async () => { log.push('start:expeditions'); return []; }, stop: async () => log.push('stop:expeditions') },
            memoryConsolidationService: worker('consolidation'),
            knowledgeReflectionService: worker('reflection')
        };
    }

    let resumeResult;

    test('a paused instance starts only the event bus and history retention, then picks the workers up on resume', async () => {
        expect(await instanceState.isPaused()).toBe(true);
        const log = [];
        const warnings = [];
        const runtime = await startCoreRuntime({
            gateway: new DisabledGateway(), pausePollMs: 25,
            logger: { info: () => {}, error: () => {}, warn: (m) => warnings.push(m) }, deps: fakeDeps(log)
        });
        try {
            expect(runtime.pausedAtStart).toBe(true);
            expect(runtime.started).toEqual(['eventBus', 'chatHistoryRetention']);
            expect(runtime.skipped).toContain('paused');
            expect(warnings.join('\n')).toMatch(/Instance is PAUSED since .* \(restore\)/);
            expect(log).toEqual(['start:eventBus', 'start:retention']);
            await sleep(80);
            expect(log).toEqual(['start:eventBus', 'start:retention']);

            resumeResult = await instanceState.resume({ by: USER });
            const deadline = Date.now() + 3000;
            while (!log.includes('start:reflection') && Date.now() < deadline) await sleep(20);
            expect(log).toEqual(expect.arrayContaining([
                'selfDocs', 'observatoryResume', 'catchUp', 'start:automation', 'start:personal',
                'start:expeditions', 'start:consolidation', 'start:reflection'
            ]));
            expect(runtime.started).toEqual(expect.arrayContaining(['automation', 'followupDelivery', 'knowledgeReflection']));
            expect(await instanceState.isPaused()).toBe(false);
        } finally {
            await runtime.stop();
        }
        expect(log.filter(entry => entry.startsWith('stop:'))).toEqual(expect.arrayContaining(['stop:automation', 'stop:reflection', 'stop:eventBus']));
    });

    test('a running instance is unaffected by the pause machinery', async () => {
        const log = [];
        const runtime = await startCoreRuntime({ gateway: new DisabledGateway(), logger: quiet, deps: fakeDeps(log) });
        expect(runtime.pausedAtStart).toBe(false);
        expect(runtime.skipped).not.toContain('paused');
        expect(runtime.started).toEqual(expect.arrayContaining(['eventBus', 'selfDocs', 'automation', 'knowledgeReflection']));
        await runtime.stop();
    });

    test('resume moves every missed schedule to its next future time and cancels one-shot reminders with a notice', async () => {
        expect(resumeResult.paused).toBeNull();
        // Three event fires: the job that settled during the downtime, plus
        // the two the restore itself failed - a trigger must not react to
        // work that only "settled" because of the restore.
        expect(resumeResult.skipped).toMatchObject({
            automations: 1, cronTriggers: 1, eventTriggers: 3, recurringFollowups: 1, oneShotFollowups: 1
        });
        const now = Date.now();

        const automation = await db.get('SELECT nextRun FROM automations WHERE id = @id', { id: seeded.automation });
        expect(toMs(automation.nextRun)).toBeGreaterThan(now);
        const cron = await db.get('SELECT nextRun FROM project_triggers WHERE id = @id', { id: seeded.cronTrigger });
        expect(toMs(cron.nextRun)).toBeGreaterThan(now);

        const missedFire = await db.get(
            'SELECT status, detail FROM project_trigger_deliveries WHERE triggerId = @triggerId AND sourceJobId = @jobId',
            { triggerId: seeded.eventTrigger, jobId: seeded.settledJob }
        );
        expect(missedFire).toMatchObject({ status: 'SKIPPED' });
        expect(missedFire.detail).toMatch(/missed while the instance was paused/);
        for (const jobId of [seeded.runningJob, seeded.interruptedJob]) {
            const row = await db.get(
                'SELECT status FROM project_trigger_deliveries WHERE triggerId = @triggerId AND sourceJobId = @jobId',
                { triggerId: seeded.eventTrigger, jobId }
            );
            expect(row?.status).toBe('SKIPPED');
        }

        const followups = await db.all('SELECT id, status, dueAt FROM followups ORDER BY id');
        const byId = Object.fromEntries(followups.map(f => [f.id, f]));
        expect(byId[seeded.pastOneShot].status).toBe('CANCELLED');
        expect(byId[seeded.pastRecurring].status).toBe('PENDING');
        expect(toMs(byId[seeded.pastRecurring].dueAt)).toBeGreaterThan(now);
        expect(byId[seeded.futureOneShot]).toMatchObject({ status: 'PENDING' });
        expect(toMs(byId[seeded.futureOneShot].dueAt)).toBeGreaterThan(now);
        expect(await followupService.getDue()).toEqual([]);

        const inbox = await inboxService.list({ userId: USER });
        const notice = inbox.items.find(item => item.kind === 'system' && /reminder was missed/.test(item.title));
        expect(notice).toBeTruthy();
        expect(notice.body).toContain('call the vet');
        expect(notice.link).toBe('/activity/scheduled');

        const state = await instanceState.describe();
        expect(state.paused).toBeNull();
        expect(state.lastResume).toMatchObject({ by: USER, pauseReason: 'restore' });
        expect(state.lastResume.skipped.oneShotFollowups).toBe(1);
    });

    test('resuming again is safe and skips nothing new', async () => {
        const again = await instanceState.resume({ by: USER });
        expect(again.skipped).toMatchObject({ automations: 0, cronTriggers: 0, eventTriggers: 0, recurringFollowups: 0, oneShotFollowups: 0 });
        expect((await inboxService.list({ userId: USER })).items.filter(i => /reminder was missed/.test(i.title))).toHaveLength(1);
    });
});

describe('work_failures and privacy', () => {
    test('erasure nulls the actor and keeps the row; the report lists a person\'s own failures first', async () => {
        const report = await privacyService.buildUserReport({ guildId: GUILD, userId: USER });
        expect(report.workFailures.length).toBeGreaterThanOrEqual(9);
        expect(report.workFailures[0]).toMatchObject({ code: INTERRUPTED_CODE });

        const total = (await db.get('SELECT COUNT(*) AS c FROM work_failures')).c;
        const counts = await privacyService.forgetUser({ userId: USER });
        expect(counts.anonymizedWorkFailures).toBe(9);
        expect((await db.get('SELECT COUNT(*) AS c FROM work_failures')).c).toBe(total);
        expect(await workFailures.countForUser(USER)).toBe(0);
        expect(await workFailures.countForUser(OTHER)).toBe(1);
        const audit = await privacyService.auditUser({ userId: USER });
        expect(audit.byTable.work_failures).toBe(0);
    });

    test('record validates its input, clips the reason, and prune honours the retention window', async () => {
        await expect(workFailures.record({ kind: 'nope', code: 'X' })).rejects.toThrow(/unknown kind/);
        await expect(workFailures.record({ kind: 'chat', code: '' })).rejects.toThrow(/code is required/);
        const id = await workFailures.record({ kind: 'chat', workId: 7, code: 'PROVIDER_ERROR', reason: 'x'.repeat(1000), actor: OTHER });
        const row = await db.get('SELECT * FROM work_failures WHERE id = @id', { id });
        expect(row.reason.length).toBeLessThanOrEqual(300);
        expect(row.workId).toBe('7');

        await db.run('UPDATE work_failures SET createdAt = @old WHERE id = @id', { old: ago(31 * 24), id });
        expect(await workFailures.prune()).toBe(1);
        expect(await db.get('SELECT id FROM work_failures WHERE id = @id', { id })).toBeFalsy();
    });
});

describe('portal: the Host room sees the pause and resumes it', () => {
    const HOST = '100000000000000077';
    const MEMBER = '100000000000000078';
    let server;
    let port;

    function request({ method = 'GET', reqPath, headers = {}, body = null }) {
        const payload = body ? JSON.stringify(body) : null;
        return new Promise((resolve, reject) => {
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

    async function cookieFor(userId, name) {
        const res = await request({ method: 'POST', reqPath: '/api/app/auth/dev-session', body: { userId, name } });
        const setCookie = (res.headers['set-cookie'] || []).find(c => c.startsWith('goobster_web_session='));
        return setCookie.split(';')[0];
    }

    beforeAll(async () => {
        const identityService = require('@goobster/core/services/identityService');
        await identityService.ensureLegacyPrincipal({ discordId: HOST, displayName: 'host' });
        await identityService.grantAccount({ principalId: HOST, entitlement: 'bootstrap', role: 'operator' });
        await identityService.ensureLegacyPrincipal({ discordId: MEMBER, displayName: 'member' });
        await identityService.grantAccount({ principalId: MEMBER, entitlement: 'migration' });

        const { createWebAppContext, createWebAppApp } = require('@goobster/core/web/appApi');
        const ctx = createWebAppContext({
            gateway: new DisabledGateway(),
            config: { webapp: { enabled: true, devMode: true } },
            logger: quiet
        });
        const app = express();
        app.use(createWebAppApp(ctx));
        await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
        port = server.address().port;
        await instanceState.pause({ reason: 'restore', by: 'npm run restore', detail: { archive: path.basename(archive) } });
    });

    afterAll(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
    });

    test('/me tells everyone the instance is paused; the admin routes are operator-only', async () => {
        const member = await cookieFor(MEMBER, 'member');
        const me = await request({ reqPath: '/api/app/me', headers: { cookie: member } });
        expect(me.status).toBe(200);
        expect(me.json.instance).toMatchObject({ paused: true, reason: 'restore' });
        expect(typeof me.json.instance.since).toBe('string');
        expect((await request({ reqPath: '/api/app/admin/instance', headers: { cookie: member } })).status).toBe(403);
        expect((await request({ method: 'POST', reqPath: '/api/app/admin/instance/resume', headers: { cookie: member } })).status).toBe(403);
        expect(await instanceState.isPaused()).toBe(true);
    });

    test('the host reads the state and resumes; /me clears', async () => {
        const host = await cookieFor(HOST, 'host');
        const state = await request({ reqPath: '/api/app/admin/instance', headers: { cookie: host } });
        expect(state.status).toBe(200);
        expect(state.json.paused).toMatchObject({ reason: 'restore', by: 'npm run restore', detail: { archive: path.basename(archive) } });
        expect(state.json.lastRestore).toMatchObject({ archive: path.basename(archive) });

        const resumed = await request({ method: 'POST', reqPath: '/api/app/admin/instance/resume', headers: { cookie: host } });
        expect(resumed.status).toBe(200);
        expect(resumed.json.paused).toBeNull();
        expect(resumed.json.skipped).toMatchObject({ automations: 0, oneShotFollowups: 0 });
        expect(resumed.json.state.paused).toBeNull();
        expect(resumed.json.state.lastResume).toMatchObject({ by: HOST, pauseReason: 'restore' });

        expect(await instanceState.isPaused()).toBe(false);
        const me = await request({ reqPath: '/api/app/me', headers: { cookie: host } });
        expect(me.json.instance).toEqual({ paused: false, reason: null, since: null });
    });
});

describe('CLI scripts', () => {
    const cliTest = PG ? test.skip : test;
    let cliArchive;

    function runScript(script, args, extraEnv = {}) {
        const env = { ...process.env, GOOBSTER_DATA_DIR: DATA_DIR, GOOBSTER_CONFIG_PATH: CONFIG_PATH, ...extraEnv };
        delete env.GOOBSTER_DB_URL;
        return execFileSync(process.execPath, [path.join(SCRIPTS, script), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }

    cliTest('npm run backup writes an archive and refuses config.json without a passphrase', async () => {
        await db.closeConnection();
        const out = path.join(ROOT, 'cli-backups');
        let failed = null;
        try {
            runScript('backup.js', ['--out', out]);
        } catch (error) {
            failed = error;
        }
        expect(failed?.status).toBe(64);
        expect(String(failed.stderr)).toMatch(/passphrase/i);

        const passFile = path.join(ROOT, 'passphrase.txt');
        fs.writeFileSync(passFile, `${PASSPHRASE}\n`);
        const stdout = runScript('backup.js', ['--out', out, '--passphrase-file', passFile]);
        expect(stdout).toMatch(/protected storage/i);
        const dirs = fs.readdirSync(out).filter(name => name.startsWith('goobster-backup-'));
        expect(dirs).toHaveLength(1);
        cliArchive = path.join(out, dirs[0]);
        const m = backupService.inspectBackup(cliArchive);
        expect(m.config.included).toBe(true);
        expect(m.engine).toBe('sqlite');
    });

    cliTest('npm run restore replaces the database with --force, keeps a .pre-restore copy, and reports the pause', async () => {
        let refused = null;
        try {
            runScript('restore.js', [cliArchive, '--without-config']);
        } catch (error) {
            refused = error;
        }
        expect(refused).toBeTruthy();
        expect(String(refused.stderr)).toMatch(/--force/);

        const stdout = runScript('restore.js', [cliArchive, '--force', '--without-config']);
        expect(stdout).toMatch(/PAUSED/);
        expect(stdout).toMatch(/config\.json: recreate/);
        const dbDir = path.dirname(process.env.GOOBSTER_DB_PATH);
        expect(fs.readdirSync(dbDir).some(name => /goobster\.sqlite\.pre-restore-/.test(name))).toBe(true);

        expect(await instanceState.isPaused()).toBe(true);
        const state = await instanceState.describe();
        expect(state.paused.by).toBe('npm run restore');
        expect(state.lastRestore.configRestored).toBe(false);
    });
});
