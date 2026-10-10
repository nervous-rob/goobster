/**
 * The parts of backup and restore that need no database
 * (documentation/backup_and_restore.md): the archive format, the file-set
 * list, the classification of everything under the data directory, reading
 * and verifying an archive, and the compatibility verdict a restore plan
 * shows. `backupService` builds the operations on top of it; the
 * installation manager (apps/manager) reads this module to plan and
 * inspect without ever loading the database facade.
 *
 * Nothing here writes. Nothing here returns a passphrase, a decrypted
 * config.json or a row.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const runtimePaths = require('../runtimePaths');
const { decryptWithPassphrase, PassphraseError } = require('../utils/passphraseCrypto');

const FORMAT = 1;
const CONFIG_FILE = 'config.json.enc';

/**
 * Tables whose counts legitimately differ right after a restore: the
 * restore itself writes the pause and failure rows and clears the
 * process-bound leases and queues, and self_docs refills on the next start.
 */
const COUNT_EXEMPT = new Set([
    'instance_state', 'work_failures', 'operator_audit', 'execution_admissions', 'admission_locks',
    'web_live_turns', 'web_chat_queue', 'self_docs', 'data_migrations', 'account_exports'
]);

/**
 * Environment variables that hold secrets and are deliberately not in the
 * archive. Restore prints the ones that were set when the backup was made.
 */
const ENV_SECRETS = [
    ['GOOBSTER_USER_AI_ENCRYPTION_KEY', 'personal AI credential encryption'],
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
 * other side. `since` is the roadmap issue that put the set in the archive.
 */
const FILE_SETS = [
    { id: 'projects', label: 'project files', since: '#249', resolve: (dataDir) => path.join(dataDir, 'sandbox', 'projects') },
    { id: 'dashboards', label: 'project dashboards', since: '#249', resolve: (dataDir) => path.join(dataDir, 'sandbox', 'dashboards') },
    { id: 'uploads', label: 'portal uploads', since: '#249', resolve: (dataDir, env = process.env) => env.GOOBSTER_UPLOADS_DIR || path.join(dataDir, 'web-uploads') },
    { id: 'artifacts', label: 'saved knowledge files', since: '#249', resolve: (dataDir, env = process.env) => env.GOOBSTER_KG_ARTIFACTS_DIR || path.join(dataDir, 'kg-artifacts') },
    { id: 'images', label: 'generated images', since: '#249', resolve: (dataDir) => path.join(dataDir, 'images') },
    { id: 'tavern-campaigns', label: 'Tavern campaign overrides', since: '#249', resolve: (dataDir, env = process.env) => env.GOOBSTER_TAVERN_CAMPAIGNS_DIR || path.join(dataDir, 'tavern', 'campaigns') },
    { id: 'tavern-assets', label: 'Tavern assets', since: '#249', resolve: (dataDir) => path.join(dataDir, 'tavern', 'assets') },
    // The self-generated VAPID pair (documentation/pwa.md): a single file,
    // but losing it strands every browser push subscription.
    { id: 'web-push-keys', label: 'Web Push keys', since: '#249', resolve: (dataDir) => path.join(dataDir, 'web-push-keys.json') },
    // Operator-authored notes the model reads through consultDocs
    // (documentation/self_knowledge.md): content a person wrote, not derived.
    { id: 'self-docs', label: 'operator self-documentation', since: '#337', resolve: (dataDir, env = process.env) => env.GOOBSTER_SELF_DOCS_OPERATOR_DIR || path.join(dataDir, 'self-docs') }
];

/**
 * Everything the installation keeps under (or next to) its data directory,
 * and what a backup does with it. `archived` names the file set that carries
 * it (or `database` for the snapshot); `excluded` says why it is left out.
 * tests/backupOperations.test.js fails when a directory appears in the
 * source tree that this list does not classify, so a new store has to be
 * decided here (and in documentation/backup_and_restore.md) on purpose.
 *
 * `path` is relative to the data directory; `base: 'cwd'` marks the few
 * stores that still resolve against the process's working directory.
 */
const DATA_CLASSIFICATION = Object.freeze([
    { path: 'user-ai.key', disposition: 'excluded', since: 'personal-ai', reason: 'Personal AI encryption key: back up separately as a secret, or supply GOOBSTER_USER_AI_ENCRYPTION_KEY' },
    { path: 'goobster.sqlite', disposition: 'archived', archivedAs: 'database', since: '#249', note: 'SQLite engine only; Postgres is dumped with pg_dump' },
    { path: 'sandbox/projects', disposition: 'archived', archivedAs: 'projects', since: '#249' },
    { path: 'sandbox/dashboards', disposition: 'archived', archivedAs: 'dashboards', since: '#249' },
    { path: 'web-uploads', disposition: 'archived', archivedAs: 'uploads', since: '#249', note: 'includes the note and chat attachments dropped into the portal (#313)' },
    { path: 'kg-artifacts', disposition: 'archived', archivedAs: 'artifacts', since: '#249', note: 'attachments saved as knowledge entities' },
    { path: 'images', disposition: 'archived', archivedAs: 'images', since: '#249' },
    { path: 'tavern/campaigns', disposition: 'archived', archivedAs: 'tavern-campaigns', since: '#249' },
    { path: 'tavern/assets', disposition: 'archived', archivedAs: 'tavern-assets', since: '#249' },
    { path: 'web-push-keys.json', disposition: 'archived', archivedAs: 'web-push-keys', since: '#249' },
    { path: 'self-docs', disposition: 'archived', archivedAs: 'self-docs', since: '#337' },
    { path: 'manager', disposition: 'excluded', reason: 'the installation manager store (identity, operations journal, audit log, maintenance state): installation state, not user data' },
    { path: 'features.json', disposition: 'excluded', reason: 'the feature choice belongs to the installed payload and is set again through the Features pane or the manager' },
    { path: 'command-deploy.json', disposition: 'excluded', reason: 'derived: the last slash-command deployment, recreated by the next deploy' },
    { path: '.command-deploy-hash', disposition: 'excluded', reason: 'derived: legacy slash-command deployment marker' },
    { path: 'account-exports', disposition: 'excluded', reason: 'temporary account export archives, deleted by a restore on purpose' },
    { path: 'sandbox/runs', disposition: 'excluded', reason: 'temporary code-execution workspaces' },
    { path: 'sandbox/venv', disposition: 'excluded', reason: 'derived Python environment, rebuilt by npm run sandbox-python' },
    { path: 'sandbox/overlay', disposition: 'excluded', reason: 'derived package overlay for the sandbox' },
    { path: 'backups', disposition: 'excluded', reason: 'the default destination of backups: an archive never contains archives' },
    { path: 'music', disposition: 'excluded', base: 'cwd', reason: 'downloaded media, fetched again on demand' },
    { path: 'ambience', disposition: 'excluded', base: 'cwd', reason: 'generated ambience clips, regenerated on demand' },
    { path: 'playlists', disposition: 'excluded', base: 'cwd', reason: 'voice-channel playlists are rebuilt in memory' },
    { path: 'voiceLimits.json', disposition: 'excluded', base: 'cwd', reason: 'transient rate-limit counters' }
]);

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

function countFiles(dir) {
    let files = 0;
    let bytes = 0;
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) {
        return { files: 1, bytes: fs.statSync(dir).size };
    }
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

/** The file set a path belongs to, or null. */
function fileSetById(id) {
    return FILE_SETS.find(set => set.id === id) || null;
}

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

/**
 * Check that an archive is complete and describes the data it is supposed
 * to: the manifest is valid, the database snapshot exists and is not empty,
 * every file set the manifest lists is present with the recorded file
 * count, the schema fingerprint is this code's, and (when `expectCounts`
 * is given) every table count equals the live count - both the count the
 * manifest recorded and, when the archive holds a SQLite snapshot, the count
 * inside the snapshot itself. Reads the archive only; never writes. A
 * backup that fails this is not a safety net.
 * @param {string} dir
 * @param {Object} [options]
 * @param {Object<string, number>} [options.expectCounts] live table counts to compare with
 * @param {string} [options.expectFingerprint] defaults to schemaFingerprint()
 * @returns {{ manifest: Object, tables: number, files: number }}
 * @throws {BackupError} code UNVERIFIED with `problems` (codes only, no paths or rows)
 */
function verifyBackup(dir, { expectCounts = null, expectFingerprint = schemaFingerprint() } = {}) {
    const manifest = inspectBackup(dir);
    const problems = [];
    const snapshotPath = path.join(dir, manifest.database.file);
    if (countFiles(snapshotPath).bytes === 0) problems.push('SNAPSHOT_EMPTY');
    if (manifest.schemaFingerprint !== expectFingerprint) problems.push('FINGERPRINT_MISMATCH');
    for (const entry of manifest.files || []) {
        const target = path.join(dir, entry.archivePath);
        if (!fs.existsSync(target)) problems.push(`FILES_MISSING:${entry.id}`);
        else if (countFiles(target).files !== entry.files) problems.push(`FILES_COUNT:${entry.id}`);
    }
    if (expectCounts) {
        const recorded = manifest.tables || {};
        let inSnapshot = null;
        let snapshot = null;
        if (manifest.database.kind === 'sqlite-file' && !problems.includes('SNAPSHOT_EMPTY')) {
            const Database = require('better-sqlite3');
            try {
                snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
                inSnapshot = (table) => {
                    try {
                        return snapshot.prepare(`SELECT COUNT(*) AS c FROM ${/^[a-z_][a-z0-9_]*$/i.test(table) ? table : `"${table.replace(/"/g, '""')}"`}`).get().c;
                    } catch {
                        return undefined;
                    }
                };
            } catch {
                problems.push('SNAPSHOT_UNREADABLE');
            }
        }
        try {
            for (const [table, expected] of Object.entries(expectCounts)) {
                if (COUNT_EXEMPT.has(table)) continue;
                const matches = recorded[table] === expected && (!inSnapshot || inSnapshot(table) === expected);
                if (!matches) problems.push(`COUNT_MISMATCH:${table}`);
            }
        } finally {
            if (snapshot) snapshot.close();
        }
    }
    if (problems.length > 0) {
        throw new BackupError('UNVERIFIED', `The backup could not be verified (${problems.join(', ')}).`, { problems });
    }
    return { manifest, tables: Object.keys(manifest.tables || {}).length, files: (manifest.files || []).length };
}

/**
 * Decrypt the archive's config.json blob into memory to prove the
 * passphrase opens it. The plaintext is returned to the caller (restore
 * writes it); a check that only wants the verdict drops it.
 * @returns {Buffer}
 * @throws {BackupError} BAD_PASSPHRASE
 */
function openConfig(dir, manifest, passphrase) {
    const envelope = JSON.parse(fs.readFileSync(path.join(dir, manifest.config.file), 'utf8'));
    try {
        return decryptWithPassphrase(envelope, passphrase);
    } catch (error) {
        if (error instanceof PassphraseError && error.code === 'BAD_PASSPHRASE') {
            throw new BackupError('BAD_PASSPHRASE', 'The passphrase does not open this archive. Nothing was restored.', { cause: error });
        }
        throw error;
    }
}

/**
 * The compatibility verdict a restore plan shows and a restore re-checks
 * before it changes anything: engine, schema fingerprint, and (when a
 * passphrase is supplied) whether it opens the encrypted config.json.
 * Reads the archive only. Throws the same codes restoreBackup does.
 * @param {Object} params
 * @param {string} params.dir
 * @param {'sqlite'|'postgres'} params.targetEngine
 * @param {string|null} [params.passphrase]
 * @param {boolean} [params.withConfig=true]
 * @param {boolean} [params.acceptSchemaChange=false]
 * @returns {{ manifest: Object, schemaChanged: boolean, config: { included: boolean, encrypted: boolean, restore: boolean, skipped: string|null, passphraseVerified: boolean } }}
 */
function assessArchive({ dir, targetEngine, passphrase = null, withConfig = true, acceptSchemaChange = false }) {
    if (!dir) throw new BackupError('BAD_ARGS', 'An archive directory is required.');
    const manifest = inspectBackup(dir);
    if (manifest.engine !== targetEngine) {
        throw new BackupError('ENGINE_MISMATCH',
            `The archive is a ${manifest.engine} backup but this installation uses ${targetEngine}. `
            + 'Restore onto the same engine. To move SQLite data to Postgres, restore onto SQLite first and then run `npm run migrate-to-postgres` (or `goobster-manager migrate`).',
            { archiveEngine: manifest.engine, targetEngine });
    }
    const currentFingerprint = schemaFingerprint();
    const schemaChanged = manifest.schemaFingerprint !== currentFingerprint;
    if (schemaChanged && !acceptSchemaChange) {
        throw new BackupError('SCHEMA_MISMATCH',
            `The archive was made by code with schema ${manifest.schemaFingerprint}; this installation has ${currentFingerprint}. `
            + 'Check out the version that made the backup, or accept the schema change to restore anyway and let the database open migrate it forward.',
            { archiveSchema: manifest.schemaFingerprint, targetSchema: currentFingerprint });
    }
    const included = Boolean(manifest.config?.included);
    let skipped = null;
    if (!included) skipped = 'the archive has no config.json';
    else if (!withConfig) skipped = 'excluded on purpose (without config)';
    else if (!passphrase) skipped = 'no passphrase was given';
    let passphraseVerified = false;
    if (included && withConfig && passphrase) {
        openConfig(dir, manifest, passphrase);
        passphraseVerified = true;
    }
    return {
        manifest,
        schemaChanged,
        config: { included, encrypted: Boolean(manifest.config?.encrypted), restore: passphraseVerified, skipped, passphraseVerified }
    };
}

/**
 * The inspection view an operator reads: counts, file sets, config
 * handling, the fingerprint verdict and the engine. No path, no secret
 * value; the environment secrets are names only.
 * @param {Object} manifest
 * @param {{ targetEngine: 'sqlite'|'postgres' }} target
 */
function describeManifest(manifest, { targetEngine }) {
    const tables = manifest.tables || {};
    const counted = Object.entries(tables).filter(([name]) => !COUNT_EXEMPT.has(name));
    const sets = (manifest.files || []).map(entry => {
        const known = fileSetById(entry.id);
        return { id: entry.id, label: entry.label || (known && known.label) || entry.id, files: entry.files, bytes: entry.bytes, known: Boolean(known) };
    });
    return {
        format: manifest.format,
        createdAt: manifest.createdAt,
        version: manifest.goobster ? manifest.goobster.version : null,
        engine: manifest.engine,
        engineMatches: manifest.engine === targetEngine,
        schemaFingerprint: manifest.schemaFingerprint,
        fingerprintMatches: manifest.schemaFingerprint === schemaFingerprint(),
        tables: counted.length,
        rows: counted.reduce((sum, [, count]) => sum + (Number(count) || 0), 0),
        fileSets: sets,
        configIncluded: Boolean(manifest.config && manifest.config.included),
        configEncrypted: Boolean(manifest.config && manifest.config.encrypted),
        archiveEncrypted: false,
        envSecretsToReenter: (manifest.envSecrets && manifest.envSecrets.present) || []
    };
}

module.exports = {
    FORMAT,
    CONFIG_FILE,
    COUNT_EXEMPT,
    ENV_SECRETS,
    FILE_SETS,
    DATA_CLASSIFICATION,
    BackupError,
    utcText,
    stamp,
    schemaFingerprint,
    goobsterVersion,
    envSecretsPresent,
    describeSecret,
    countFiles,
    fileSetById,
    inspectBackup,
    verifyBackup,
    openConfig,
    assessArchive,
    describeManifest
};
