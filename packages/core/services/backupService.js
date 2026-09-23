/**
 * Backup and tested restore (roadmap #249, documentation/backup_and_restore.md).
 *
 * An archive is a directory:
 *
 *   goobster-backup-<UTC stamp>/
 *     manifest.json          what is inside, row counts, schema fingerprint
 *     database/goobster.sqlite   (SQLite: online-backup copy)
 *     database/goobster.dump     (Postgres: pg_dump custom format)
 *     files/<set>/...        project files, uploads, saved files, images,
 *                            Tavern overrides and assets
 *     config.json.enc        config.json, AES-256-GCM under a passphrase
 *                            typed at backup time (never plaintext)
 *
 * Only config.json is encrypted: it can hold the Discord token and provider
 * keys. The database and the files are stored as they are, so the archive
 * belongs on protected storage. Environment secrets are never in it; the
 * manifest records which ones were set so restore can list what to
 * re-enter.
 *
 * Restore refuses another engine or another schema fingerprint unless told
 * otherwise, replaces the database and the file sets, marks every piece of
 * in-flight work failed ("interrupted by restore" - never retried), and
 * leaves the instance **paused** so nothing that came due in the meantime
 * fires. The operator resumes from the Host room.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const db = require('../db');
const runtimePaths = require('../runtimePaths');
const { encryptWithPassphrase, decryptWithPassphrase, PassphraseError } = require('../utils/passphraseCrypto');
const instanceState = require('./instanceStateService');
const workFailures = require('./workFailureService');

const execFileAsync = promisify(execFile);

const FORMAT = 1;
const CONFIG_FILE = 'config.json.enc';
const INTERRUPTED_REASON = 'interrupted by restore';
const INTERRUPTED_CODE = 'INTERRUPTED_BY_RESTORE';

/**
 * Tables whose counts legitimately differ right after a restore: the
 * restore itself writes the pause and failure rows and clears the
 * process-bound leases and queues, and self_docs refills on the next start.
 */
const COUNT_EXEMPT = new Set([
    'instance_state', 'work_failures', 'execution_admissions', 'admission_locks',
    'web_live_turns', 'web_chat_queue', 'self_docs', 'data_migrations'
]);

/**
 * Environment variables that hold secrets and are deliberately not in the
 * archive. Restore prints the ones that were set when the backup was made.
 */
const ENV_SECRETS = [
    ['GOOBSTER_DB_URL', 'database connection URL (Postgres)'],
    ['GOOBSTER_INTERNAL_TOKEN', 'shared secret between bot, api and sandbox'],
    ['DISCORD_CLIENT_SECRET', 'Discord OAuth client secret (portal sign-in, Activity)'],
    ['OPENAI_API_KEY', 'OpenAI'],
    ['ANTHROPIC_API_KEY', 'Anthropic'],
    ['GEMINI_API_KEY', 'Gemini'],
    ['PERPLEXITY_API_KEY', 'Perplexity search'],
    ['ELEVENLABS_API_KEY', 'ElevenLabs speech'],
    ['GITHUB_TOKEN', 'GitHub integration'],
    ['GITHUB_WEBHOOK_SECRET', 'GitHub webhooks'],
    ['CURSOR_API_KEY', 'Cursor agents'],
    ['CURSOR_WEBHOOK_SECRET', 'Cursor webhooks'],
    ['SPOTIFY_CLIENT_SECRET', 'Spotify']
];

/**
 * The file sets an archive carries, each resolved against the data
 * directory (or its environment override) of the installation doing the
 * backup or the restore - never against the absolute path recorded by the
 * other side.
 */
const FILE_SETS = [
    { id: 'projects', label: 'project files', resolve: dataDir => path.join(dataDir, 'sandbox', 'projects') },
    { id: 'dashboards', label: 'project dashboards', resolve: dataDir => path.join(dataDir, 'sandbox', 'dashboards') },
    { id: 'uploads', label: 'portal uploads', resolve: dataDir => process.env.GOOBSTER_UPLOADS_DIR || path.join(dataDir, 'web-uploads') },
    { id: 'artifacts', label: 'saved knowledge files', resolve: dataDir => process.env.GOOBSTER_KG_ARTIFACTS_DIR || path.join(dataDir, 'kg-artifacts') },
    { id: 'images', label: 'generated images', resolve: dataDir => path.join(dataDir, 'images') },
    { id: 'tavern-campaigns', label: 'Tavern campaign overrides', resolve: dataDir => process.env.GOOBSTER_TAVERN_CAMPAIGNS_DIR || path.join(dataDir, 'tavern', 'campaigns') },
    { id: 'tavern-assets', label: 'Tavern assets', resolve: dataDir => path.join(dataDir, 'tavern', 'assets') }
];

class BackupError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'BackupError';
        this.code = code;
        Object.assign(this, details);
    }
}

function utcText(date = new Date()) {
    return new Date(date).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function stamp(date = new Date()) {
    return new Date(date).toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

/**
 * A fingerprint of the schema this code applies: schema.sql plus the
 * column migrations. Two installations running the same code agree on it;
 * restoring across a schema change is refused unless the operator accepts
 * that the open will migrate the restored database forward.
 * @returns {string} 16 hex characters
 */
function schemaFingerprint() {
    const dir = path.join(__dirname, '..', 'db');
    const hash = crypto.createHash('sha256');
    for (const file of ['schema.sql', 'migrations.js']) {
        hash.update(fs.readFileSync(path.join(dir, file)));
        hash.update('\0');
    }
    return hash.digest('hex').slice(0, 16);
}

function goobsterVersion() {
    try {
        return require(path.join(runtimePaths.workspaceRoot, 'package.json')).version || null;
    } catch {
        return null;
    }
}

/** Which of the known environment secrets are set (names only). */
function envSecretsPresent(env = process.env) {
    return ENV_SECRETS.filter(([name]) => typeof env[name] === 'string' && env[name].length > 0).map(([name]) => name);
}

function describeSecret(name) {
    const entry = ENV_SECRETS.find(([n]) => n === name);
    return entry ? `${name} (${entry[1]})` : name;
}

/** Row counts for every application table. */
async function tableCounts() {
    const counts = {};
    for (const table of await db.listTables()) {
        const row = await db.get(`SELECT COUNT(*) AS c FROM ${table}`);
        counts[table] = Number(row?.c || 0);
    }
    return counts;
}

function countFiles(dir) {
    let files = 0;
    let bytes = 0;
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                files += 1;
                bytes += fs.statSync(full).size;
            }
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return { files, bytes };
}

async function runTool(command, args, { env = process.env } = {}) {
    try {
        return await execFileAsync(command, args, { env, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new BackupError('TOOL_MISSING', `${command} is not installed or not on PATH. Install the PostgreSQL client tools and retry.`, { cause: error });
        }
        const stderr = String(error.stderr || '').trim();
        throw new BackupError('TOOL_FAILED', `${command} failed (exit ${error.code ?? '?'})${stderr ? `: ${stderr.split('\n').slice(-5).join(' | ')}` : ''}`, { cause: error });
    }
}

// --- Backup ---------------------------------------------------------------

/**
 * Write a backup archive.
 * @param {Object} params
 * @param {string} params.destDir - parent directory; the archive is a new subdirectory in it
 * @param {string|null} [params.passphrase] - required unless includeConfig is false
 * @param {boolean} [params.includeConfig=true]
 * @param {string} [params.dataDir] - defaults to runtimePaths.dataDir
 * @param {string} [params.configPath] - defaults to runtimePaths.configJsonPath
 * @param {Object} [params.logger]
 * @returns {Promise<{dir: string, manifest: Object}>}
 */
async function createBackup({
    destDir,
    passphrase = null,
    includeConfig = true,
    dataDir = runtimePaths.dataDir,
    configPath = runtimePaths.configJsonPath,
    logger = console
} = {}) {
    if (!destDir) throw new BackupError('BAD_ARGS', 'A destination directory is required.');
    const configExists = fs.existsSync(configPath);
    if (includeConfig && configExists && !passphrase) {
        throw new BackupError('PASSPHRASE_REQUIRED',
            'config.json holds secrets and is only ever stored encrypted: supply a passphrase, or exclude it with --skip-config.');
    }

    const createdAt = new Date();
    const dir = path.join(destDir, `goobster-backup-${stamp(createdAt)}`);
    if (fs.existsSync(dir)) throw new BackupError('EXISTS', `${dir} already exists.`);
    fs.mkdirSync(path.join(dir, 'database'), { recursive: true });

    const storage = await db.describeStorage();
    const manifest = {
        format: FORMAT,
        createdAt: utcText(createdAt),
        goobster: { version: goobsterVersion() },
        engine: storage.engine,
        schemaFingerprint: schemaFingerprint(),
        database: null,
        tables: await tableCounts(),
        files: [],
        config: { included: false, encrypted: false, file: null },
        envSecrets: { present: envSecretsPresent(), known: ENV_SECRETS.map(([name]) => name) },
        notes: [
            'The database and the files are stored unencrypted. Keep this archive on protected storage.',
            'config.json (if present) is encrypted with the passphrase typed at backup time; the passphrase is not stored anywhere.',
            'Environment secrets are not in this archive; see envSecrets.present for the ones to re-enter after a restore.'
        ]
    };

    // Database snapshot.
    if (storage.engine === 'sqlite') {
        const file = path.join('database', 'goobster.sqlite');
        await db.getDb().backup(path.join(dir, file));
        manifest.database = { kind: 'sqlite-file', file };
    } else {
        const file = path.join('database', 'goobster.dump');
        await runTool('pg_dump', [
            '--format=custom', '--no-owner', '--no-privileges',
            `--schema=${storage.schema}`,
            '--file', path.join(dir, file),
            '--dbname', storage.url
        ]);
        manifest.database = { kind: 'pg-dump', file, schema: storage.schema };
    }
    logger.info?.(`[backup] Database snapshot written (${storage.engine})`);

    // File sets.
    for (const set of FILE_SETS) {
        const source = set.resolve(dataDir);
        if (!fs.existsSync(source)) continue;
        const archivePath = path.join('files', set.id);
        fs.cpSync(source, path.join(dir, archivePath), { recursive: true });
        const size = countFiles(source);
        manifest.files.push({ id: set.id, label: set.label, archivePath, ...size });
        logger.info?.(`[backup] ${set.label}: ${size.files} file(s)`);
    }

    // config.json, encrypted or not at all.
    if (includeConfig && configExists) {
        const envelope = encryptWithPassphrase(fs.readFileSync(configPath), passphrase);
        fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(envelope, null, 2));
        manifest.config = { included: true, encrypted: true, file: CONFIG_FILE };
        logger.info?.('[backup] config.json encrypted into the archive');
    } else if (includeConfig) {
        logger.warn?.(`[backup] No config.json at ${configPath}; the archive has no configuration.`);
    } else {
        logger.info?.('[backup] config.json excluded (--skip-config)');
    }

    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { dir, manifest };
}

// --- Inspect --------------------------------------------------------------

/**
 * Read and validate an archive's manifest.
 * @param {string} dir
 * @returns {Object} manifest
 */
function inspectBackup(dir) {
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) throw new BackupError('NOT_AN_ARCHIVE', `${dir} has no manifest.json.`);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new BackupError('BAD_MANIFEST', `manifest.json is not valid JSON: ${error.message}`, { cause: error });
    }
    if (manifest.format !== FORMAT) {
        throw new BackupError('BAD_FORMAT', `Archive format ${manifest.format} is not supported by this version (expected ${FORMAT}).`);
    }
    if (!manifest.database?.file || !fs.existsSync(path.join(dir, manifest.database.file))) {
        throw new BackupError('BAD_MANIFEST', 'The archive is missing its database snapshot.');
    }
    if (manifest.config?.included && !fs.existsSync(path.join(dir, manifest.config.file))) {
        throw new BackupError('BAD_MANIFEST', 'The manifest says config.json is included but the file is missing.');
    }
    return manifest;
}

// --- Restore --------------------------------------------------------------

/**
 * Whether the target database already holds anything worth protecting.
 * Opens the database (applying the schema) if it is not open yet.
 */
async function targetHasData() {
    const counts = await tableCounts();
    return Object.entries(counts).some(([table, count]) => !COUNT_EXEMPT.has(table) && count > 0);
}

/** Move `file` (and, for SQLite, its -wal/-shm companions) aside. */
function setAside(file, tag) {
    const moved = [];
    for (const suffix of ['', '-wal', '-shm']) {
        const from = `${file}${suffix}`;
        if (!fs.existsSync(from)) continue;
        const to = `${file}.pre-restore-${tag}${suffix}`;
        fs.renameSync(from, to);
        moved.push(to);
    }
    return moved;
}

/**
 * Mark every piece of in-flight work failed with one fixed reason and
 * record a work_failures row for each. None of it is retried: the
 * observatory auto-resume only takes INTERRUPTED jobs, the expedition
 * runner only QUEUED ones, and both find none of these.
 * @param {{now?: Date}} [params]
 * @returns {Promise<Object>} counts by kind
 */
async function interruptInFlightWork({ now = new Date() } = {}) {
    const nowText = utcText(now);
    const counts = {};
    const bump = (kind, n = 1) => { counts[kind] = (counts[kind] || 0) + n; };

    await db.transaction(async () => {
        for (const job of await db.all(
            `SELECT id, userId, status FROM observatory_jobs WHERE status IN ('RUNNING', 'INTERRUPTED')`
        )) {
            await db.run(
                `UPDATE observatory_jobs
                 SET status = 'FAILED', error = @reason, finishedAt = @now, runnerId = NULL, leaseToken = NULL
                 WHERE id = @id`,
                { id: job.id, reason: INTERRUPTED_REASON, now: nowText }
            );
            await workFailures.record({ kind: 'job', workId: job.id, phase: job.status, code: INTERRUPTED_CODE, reason: INTERRUPTED_REASON, actor: job.userId });
            bump('job');
        }

        for (const run of await db.all(`SELECT id, userId FROM spitball_expeditions WHERE status = 'RUNNING'`)) {
            await db.run(
                `UPDATE spitball_expeditions
                 SET status = 'FAILED', lastError = @reason, stopReason = 'RESTORE', finishedAt = @now,
                     runnerId = NULL, updatedAt = datetime('now')
                 WHERE id = @id`,
                { id: run.id, reason: INTERRUPTED_REASON, now: nowText }
            );
            await db.run(
                `UPDATE spitball_expedition_cycles SET status = 'CANCELLED', lastError = @reason, finishedAt = @now
                 WHERE expeditionId = @id AND status = 'RUNNING'`,
                { id: run.id, reason: INTERRUPTED_REASON, now: nowText }
            );
            await workFailures.record({ kind: 'expedition', workId: run.id, phase: 'RUNNING', code: INTERRUPTED_CODE, reason: INTERRUPTED_REASON, actor: run.userId });
            bump('expedition');
        }

        for (const step of await db.all(
            `SELECT id, userId, status FROM project_mission_steps WHERE status IN ('STARTING', 'RUNNING')`
        )) {
            await db.run(
                `UPDATE project_mission_steps SET status = 'FAILED', finishedAt = @now, updatedAt = datetime('now') WHERE id = @id`,
                { id: step.id, now: nowText }
            );
            await workFailures.record({ kind: 'mission_step', workId: step.id, phase: step.status, code: INTERRUPTED_CODE, reason: INTERRUPTED_REASON, actor: step.userId });
            bump('mission_step');
        }

        for (const request of await db.all(`SELECT id, userId FROM sandbox_requests WHERE status = 'EXECUTING'`)) {
            await db.run(
                `UPDATE sandbox_requests SET status = 'FAILED', error = @reason, resolvedAt = @now WHERE id = @id`,
                { id: request.id, reason: INTERRUPTED_REASON, now: nowText }
            );
            await workFailures.record({ kind: 'sandbox', workId: request.id, phase: 'EXECUTING', code: INTERRUPTED_CODE, reason: INTERRUPTED_REASON, actor: request.userId });
            bump('sandbox');
        }

        for (const action of await db.all(`SELECT id, requestedBy FROM pending_integration_actions WHERE status = 'EXECUTING'`)) {
            await db.run(
                `UPDATE pending_integration_actions SET status = 'CANCELLED', resolvedAt = @now, resultJson = @result WHERE id = @id`,
                { id: action.id, now: nowText, result: JSON.stringify({ error: INTERRUPTED_REASON }) }
            );
            await workFailures.record({ kind: 'integration_action', workId: action.id, phase: 'EXECUTING', code: INTERRUPTED_CODE, reason: INTERRUPTED_REASON, actor: action.requestedBy });
            bump('integration_action');
        }

        for (const watch of await db.all(`SELECT id, userId FROM attention_watches WHERE status = 'FIRING'`)) {
            await db.run(
                `UPDATE attention_watches SET status = 'FAILED', lastError = @reason, executionAttemptId = NULL WHERE id = @id`,
                { id: watch.id, reason: INTERRUPTED_REASON }
            );
            await workFailures.record({ kind: 'watch', workId: watch.id, phase: 'FIRING', code: INTERRUPTED_CODE, reason: INTERRUPTED_REASON, actor: watch.userId });
            bump('watch');
        }

        for (const delivery of await db.all(
            `SELECT d.id, d.triggerId, d.sourceJobId, t.userId
             FROM project_trigger_deliveries d LEFT JOIN project_triggers t ON t.id = d.triggerId
             WHERE d.status = 'STARTED'`
        )) {
            await db.run(
                `UPDATE project_trigger_deliveries SET status = 'FAILED', detail = @reason, updatedAt = datetime('now') WHERE id = @id`,
                { id: delivery.id, reason: INTERRUPTED_REASON }
            );
            await workFailures.record({ kind: 'delivery', workId: `${delivery.triggerId}:${delivery.sourceJobId}`, phase: 'STARTED', code: INTERRUPTED_CODE, reason: INTERRUPTED_REASON, actor: delivery.userId });
            bump('delivery');
        }

        for (const run of await db.all(`SELECT id, requestedBy FROM kg_reflection_runs WHERE status = 'running'`)) {
            await db.run(
                `UPDATE kg_reflection_runs SET status = 'failed', error = @reason, finishedAt = @now WHERE id = @id`,
                { id: run.id, reason: INTERRUPTED_REASON, now: nowText }
            );
            await workFailures.record({ kind: 'reflection', workId: run.id, phase: 'running', code: INTERRUPTED_CODE, reason: INTERRUPTED_REASON, actor: run.requestedBy });
            bump('reflection');
        }

        for (const turn of await db.all('SELECT userId, turnId FROM web_live_turns')) {
            await workFailures.record({ kind: 'chat', workId: turn.turnId, phase: 'streaming', code: INTERRUPTED_CODE, reason: INTERRUPTED_REASON, actor: turn.userId });
            bump('chat');
        }
        await db.run('DELETE FROM web_live_turns');
        await db.run('DELETE FROM web_chat_queue');

        // Admission leases belong to processes that no longer exist.
        await db.run('DELETE FROM execution_admissions');
    });
    return counts;
}

/**
 * Restore an archive into this installation. The instance must be stopped.
 * @param {Object} params
 * @param {string} params.dir - the archive directory
 * @param {string|null} [params.passphrase] - to bring config.json back; omit to skip it
 * @param {boolean} [params.withConfig=true] - false skips config.json even if a passphrase is given
 * @param {boolean} [params.acceptSchemaChange=false] - restore across a schema fingerprint change
 * @param {boolean} [params.force=false] - restore over a target that already has data
 * @param {string} [params.dataDir]
 * @param {string} [params.configPath]
 * @param {string} [params.by] - who ran it (recorded on the pause)
 * @param {Object} [params.logger]
 * @returns {Promise<Object>} a report for the operator
 */
async function restoreBackup({
    dir,
    passphrase = null,
    withConfig = true,
    acceptSchemaChange = false,
    force = false,
    dataDir = runtimePaths.dataDir,
    configPath = runtimePaths.configJsonPath,
    by = 'npm run restore',
    logger = console
} = {}) {
    if (!dir) throw new BackupError('BAD_ARGS', 'An archive directory is required.');
    const manifest = inspectBackup(dir);
    const tag = stamp();

    // 1. Gates that cost nothing: engine, schema, passphrase.
    if (manifest.engine !== db.engine) {
        throw new BackupError('ENGINE_MISMATCH',
            `The archive is a ${manifest.engine} backup but this installation uses ${db.engine}. `
            + 'Restore onto the same engine. To move SQLite data to Postgres, restore onto SQLite first and then run `npm run migrate-to-postgres`.',
            { archiveEngine: manifest.engine, targetEngine: db.engine });
    }
    const currentFingerprint = schemaFingerprint();
    const schemaChanged = manifest.schemaFingerprint !== currentFingerprint;
    if (schemaChanged && !acceptSchemaChange) {
        throw new BackupError('SCHEMA_MISMATCH',
            `The archive was made by code with schema ${manifest.schemaFingerprint}; this installation has ${currentFingerprint}. `
            + 'Check out the version that made the backup, or pass --accept-schema-change to restore anyway and let the database open migrate it forward.',
            { archiveSchema: manifest.schemaFingerprint, targetSchema: currentFingerprint });
    }

    let configBytes = null;
    const configIncluded = Boolean(manifest.config?.included);
    if (configIncluded && withConfig && passphrase) {
        const envelope = JSON.parse(fs.readFileSync(path.join(dir, manifest.config.file), 'utf8'));
        try {
            configBytes = decryptWithPassphrase(envelope, passphrase);
        } catch (error) {
            if (error instanceof PassphraseError && error.code === 'BAD_PASSPHRASE') {
                throw new BackupError('BAD_PASSPHRASE', 'The passphrase does not open this archive. Nothing was restored.', { cause: error });
            }
            throw error;
        }
    }

    // 2. Protect a target that already holds data.
    const hadData = await targetHasData();
    if (hadData && !force) {
        throw new BackupError('TARGET_NOT_EMPTY',
            'This installation already has data. Pass --force to replace it (SQLite keeps a .pre-restore copy of the old file).');
    }

    const storage = await db.describeStorage();
    let configSkipped = null;
    if (!configIncluded) configSkipped = 'the archive has no config.json';
    else if (!withConfig) configSkipped = 'excluded by --without-config';
    else if (!passphrase) configSkipped = 'no passphrase was given';
    const report = {
        archive: dir,
        archiveCreatedAt: manifest.createdAt,
        engine: manifest.engine,
        schemaChanged,
        replacedExisting: hadData,
        setAside: [],
        files: [],
        config: { restored: false, path: null, skipped: configSkipped },
        secretsToReenter: [],
        interrupted: {},
        counts: { expected: manifest.tables, actual: null, mismatches: [] }
    };

    // 3. The database.
    if (storage.engine === 'sqlite') {
        await db.closeConnection();
        if (hadData) {
            report.setAside = setAside(storage.path, tag);
        } else {
            // targetHasData() opened (and so created) an empty database; a
            // .pre-restore copy of nothing would only confuse.
            for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${storage.path}${suffix}`, { force: true });
        }
        fs.mkdirSync(path.dirname(storage.path), { recursive: true });
        const Database = require('better-sqlite3');
        const snapshot = new Database(path.join(dir, manifest.database.file), { readonly: true, fileMustExist: true });
        try {
            await snapshot.backup(storage.path);
        } finally {
            snapshot.close();
        }
        logger.info?.(`[restore] Database restored to ${storage.path}`);
    } else {
        // Drop what is there (CASCADE takes dependent constraints with it),
        // then restore the dump into the same schema. pg_restore is told the
        // schema so it does not try to CREATE SCHEMA over the existing one.
        for (const table of await db.listTables({ includeDerived: true })) {
            await db.rawQuery(`DROP TABLE IF EXISTS "${table}" CASCADE`);
        }
        const schema = manifest.database.schema || storage.schema;
        await runTool('pg_restore', [
            '--no-owner', '--no-privileges', '--single-transaction',
            `--schema=${schema}`,
            '--dbname', storage.url,
            path.join(dir, manifest.database.file)
        ]);
        if (schemaChanged) {
            // Reopening re-runs the column migrations and schema.sql on the
            // restored tables, which is what accepting the change means.
            await db.closeConnection();
        }
        logger.info?.(`[restore] Database restored into schema ${schema}`);
    }

    // 4. Files.
    for (const entry of manifest.files || []) {
        const set = FILE_SETS.find(s => s.id === entry.id);
        if (!set) {
            logger.warn?.(`[restore] Unknown file set '${entry.id}' in the archive; skipped`);
            continue;
        }
        const from = path.join(dir, entry.archivePath);
        if (!fs.existsSync(from)) continue;
        const to = set.resolve(dataDir);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, { recursive: true, force: true });
        report.files.push({ id: set.id, label: set.label, to, files: entry.files });
        logger.info?.(`[restore] ${set.label}: ${entry.files} file(s) → ${to}`);
    }

    // 5. config.json.
    if (configBytes) {
        if (fs.existsSync(configPath)) {
            const aside = `${configPath}.pre-restore-${tag}`;
            fs.renameSync(configPath, aside);
            report.setAside.push(aside);
        }
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, configBytes, { mode: 0o600 });
        report.config = { restored: true, path: configPath, skipped: null };
        logger.info?.(`[restore] config.json restored to ${configPath}`);
    }
    if (!report.config.restored) {
        report.secretsToReenter.push('config.json: recreate it from config.example.json (Discord token, client id, guild ids, any provider keys kept there)');
    }
    for (const name of manifest.envSecrets?.present || []) {
        report.secretsToReenter.push(describeSecret(name));
    }

    // 6. Open the restored database (schema applied, migrations if accepted),
    //    fail in-flight work, pause, and verify counts.
    report.interrupted = await interruptInFlightWork();
    await instanceState.pause({
        reason: 'restore',
        by,
        detail: { archive: path.basename(dir), archiveCreatedAt: manifest.createdAt, interrupted: report.interrupted }
    });
    await instanceState.recordRestore({
        archive: path.basename(dir),
        archiveCreatedAt: manifest.createdAt,
        engine: manifest.engine,
        schemaChanged,
        configRestored: report.config.restored,
        interrupted: report.interrupted,
        by
    });

    report.counts.actual = await tableCounts();
    for (const [table, expected] of Object.entries(manifest.tables || {})) {
        if (COUNT_EXEMPT.has(table)) continue;
        const actual = report.counts.actual[table];
        if (actual === undefined) {
            report.counts.mismatches.push({ table, expected, actual: null });
        } else if (actual !== expected) {
            report.counts.mismatches.push({ table, expected, actual });
        }
    }
    return report;
}

module.exports = {
    createBackup,
    inspectBackup,
    restoreBackup,
    interruptInFlightWork,
    schemaFingerprint,
    envSecretsPresent,
    tableCounts,
    BackupError,
    FILE_SETS,
    ENV_SECRETS,
    COUNT_EXEMPT,
    FORMAT,
    CONFIG_FILE,
    INTERRUPTED_REASON,
    INTERRUPTED_CODE
};
