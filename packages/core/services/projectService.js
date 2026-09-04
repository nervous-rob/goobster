/**
 * Projects (the Observatory grown up): persistent, long-running workspaces
 * layered ON TOP of the code sandbox. Named per-user projects with durable
 * directories, checkpointed background jobs that survive the sandbox's
 * timeout wall, an automatic frame->video render pipeline, and completion
 * notifications that ride the existing follow-up machinery.
 *
 * Physical tables keep the `observatory_*` prefix; this module is the
 * service-layer name. `observatoryService.js` re-exports this file so
 * existing requires keep working.
 *
 * Trust boundary (the pattern used everywhere in this project - the model
 * proposes, deterministic code legalizes): nothing here grants new execution
 * powers, only new persistence. Every run still goes through
 * services/sandboxService.js with all of its guardrails (isolation ladder,
 * rlimits, scrubbed env, wall-clock timeout, concurrency cap); the ONLY
 * addition is that a project's workspace directory is bind-mounted
 * read-write beside the throwaway run dir and exposed to the snippet as
 * $GOOBSTER_PROJECT_DIR.
 *
 * Background jobs are "many small legal runs, not one lawless big one": a
 * job runs the same snippet in segments, each a normal sandbox run holding a
 * concurrency slot honestly. A segment killed at the timeout wall is resumed
 * (up to observatoryConfig.maxResumes) ONLY when the job advanced its own
 * checkpoint - the documented convention, not magic: the snippet loads
 * $GOOBSTER_RUN_DIR/checkpoint.json (falling back to the project-root
 * file for older jobs) when present and rewrites it as it progresses.
 *
 * Durable state (projects registry, job records) lives in SQLite per the
 * house rule; live job handles (AbortControllers) are transient in-memory
 * state. Ownership of a RUNNING job is a durable lease (runnerId +
 * lastHeartbeatAt + leaseToken): heartbeat, segment writes, and finish
 * require the attempt token. A stale lease is reaped to INTERRUPTED
 * (or CANCELLED when cancel was requested) and may auto-resume from its
 * checkpoint with a new token. Only one RUNNING job is allowed per
 * project, including foreground runs.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const db = require('../db');
const { toGateway, isGatewayUnavailable } = require('../gateway');
const logger = require('../utils/logger');
const observatoryConfig = require('../config/observatoryConfig');
const sandboxService = require('./sandboxService');
const { buildDashboard } = require('./observatoryDashboard');
const { dmScopeId } = require('../utils/dmScope');
const knowledgeGraphService = require('./knowledgeGraphService');
const { windowLines } = require('../utils/toolResultWindow');
const { makeRunnerId, makeLeaseToken, staleCutoffUtc, HEARTBEAT_MS } = require('../utils/executionLease');

const PROJECTS_ROOT = path.join(require('../runtimePaths').dataDir, 'sandbox', 'projects');
/**
 * Dashboards live OUTSIDE the workspace on purpose: the workspace is
 * bind-mounted writable into snippet runs, and a served dashboard is
 * trusted HTML - a snippet must never be able to author it.
 */
const DASHBOARDS_ROOT = path.join(require('../runtimePaths').dataDir, 'sandbox', 'dashboards');
/** The checkpoint/resume convention: this file, under runs/<jobId>/. */
const CHECKPOINT_FILE = 'checkpoint.json';
/** Per-job tree for checkpoint, frames, logs. Shared root is inputs/artifacts. */
const RUNS_DIR = 'runs';
/** The render convention: numbered frames in this run subdirectory. */
const FRAMES_DIR = 'frames';
const RENDERS_DIR = 'renders';
const FRAME_PATTERN = /^frame_\d+\.png$/;
/** Persisted stream tails per segment (forensics, not archival). */
const TAIL_CHARS = 8000;
/** A busy sandbox defers a job segment instead of failing the job. */
const BUSY_RETRY_MS = 10_000;
const MAX_BUSY_RETRIES = 60;
/** Render invocations are bounded like everything else. */
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_NAME_LENGTH = 60;
const SLUG_MAX_LENGTH = 48;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SNOWFLAKE_PATTERN = /^\d{5,20}$/;
/** Default inbox project for migrated Workshop pins (Phase 2). */
const WORKSHOP_SLUG = 'workshop';
const WORKSHOP_NAME = 'Workshop';
/** Compact chat-preamble caps so a busy project does not flood the turn. */
const MANIFEST_MAX_ASSETS = 20;
const MANIFEST_MAX_TRIGGERS = 20;
const MANIFEST_MAX_FILES = 20;
const MANIFEST_MAX_KNOWLEDGE = 8;
const PROJECT_CONV_PREFIX = '🔭 ';
const GENERIC_OBS_TITLE = '🔭 Observatory';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm']);
/** MIME types for dashboard media inlining (extension-checked files only). */
const MEDIA_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.webm': 'video/webm'
};
/**
 * Allowlist for the owner-only workspace reader (applet capability bridge).
 * Tight on purpose: JSON/CSV/text plus a few raster images. HTML/SVG/video
 * stay out — this is content, not a second dashboard authoring path.
 */
const WORKSPACE_READ_MIME = {
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
};
/** Broader MIME map for the owner portal explorer (not the applet bridge). */
const PORTAL_READ_MIME = {
    ...WORKSPACE_READ_MIME,
    '.py': 'text/x-python',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.ts': 'text/plain',
    '.tsx': 'text/plain',
    '.jsx': 'text/javascript',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.yml': 'text/yaml',
    '.yaml': 'text/yaml',
    '.xml': 'text/xml',
    '.log': 'text/plain',
    '.sh': 'text/x-sh',
    '.toml': 'text/plain',
    '.ini': 'text/plain',
    '.cfg': 'text/plain',
    '.sql': 'text/plain',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf'
};
const MAX_RELATIVE_PATH_LENGTH = 1024;
/** Inline-media caps keep the self-contained dashboard a sane size. */
const MAX_INLINE_IMAGES = 12;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_CHARS = 4000;
const SHARE_TOKEN_PATTERN = /^[a-f0-9]{32,64}$/;

/**
 * String-only workspace path legalization: workspace-relative, no
 * traversal syntax, no absolute paths. Shared by the reader and writers.
 * @param {string} relativePath
 * @param {{ allowEmpty?: boolean }} [opts]
 * @returns {string} posix-style relative path
 */
function normalizeWorkspaceRelPath(relativePath, { allowEmpty = false } = {}) {
    const raw = String(relativePath ?? '').trim();
    if (!raw) {
        if (allowEmpty) return '';
        throw new ObservatoryError(400, 'BAD_PATH', 'Which file?');
    }
    if (raw.length > MAX_RELATIVE_PATH_LENGTH) {
        throw new ObservatoryError(400, 'BAD_PATH', 'Path is too long.');
    }
    if (raw.includes('\0')) {
        throw new ObservatoryError(400, 'BAD_PATH', 'Invalid path.');
    }
    const unified = raw.replace(/\\/g, '/');
    if (path.isAbsolute(unified) || unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
        throw new ObservatoryError(400, 'BAD_PATH',
            'Path must be relative to the project workspace.');
    }
    const parts = unified.split('/');
    if (parts.some(part => part === '' || part === '.' || part === '..')) {
        throw new ObservatoryError(400, 'BAD_PATH',
            'Path must stay inside the project workspace.');
    }
    return parts.join('/');
}

/**
 * One shared helper for every workspace read and write: traversal and
 * symlink refusal, workspace-relative only. The file need not exist
 * (writers create parents from the path) unless mustExist is set.
 * @param {string} workspaceDir
 * @param {string} relativePath
 * @param {{ allowEmpty?: boolean, mustExist?: boolean }} [opts]
 * @returns {{ relativePath: string, absolutePath: string }}
 */
function legalizeWorkspacePath(workspaceDir, relativePath, {
    allowEmpty = false,
    mustExist = false
} = {}) {
    const rel = normalizeWorkspaceRelPath(relativePath, { allowEmpty });
    const root = path.resolve(String(workspaceDir || ''));
    const resolved = rel ? path.resolve(root, rel) : root;
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new ObservatoryError(400, 'BAD_PATH',
            'Path must stay inside the project workspace.');
    }
    let cursor = root;
    const parts = rel ? rel.split('/') : [];
    for (let i = 0; i < parts.length; i++) {
        cursor = path.join(cursor, parts[i]);
        let lst;
        try {
            lst = fs.lstatSync(cursor);
        } catch {
            if (mustExist) {
                throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
            }
            break;
        }
        if (lst.isSymbolicLink()) {
            throw new ObservatoryError(400, 'BAD_PATH',
                'Symbolic links are not allowed in the project workspace.');
        }
    }
    return { relativePath: rel, absolutePath: resolved };
}

/** Machine-readable observatory error (the PanelError contract: status + code). */
class ObservatoryError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ObservatoryError';
        this.status = status;
        this.code = code;
    }
}

/** 'YYYY-MM-DD HH:MM:SS' UTC text (the timestamp format the tables use). */
function toUtcText(date) {
    return new Date(date).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** True if `cmd` exists on PATH (same probe sandboxService uses). */
function commandExists(cmd) {
    try {
        const res = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
        return res.status === 0;
    } catch {
        return false;
    }
}

class ObservatoryService {
    constructor({ config = observatoryConfig, sandbox = sandboxService } = {}) {
        this.config = config;
        this.sandbox = sandbox;
        /**
         * Live background jobs: jobId -> { controller }. Transient,
         * re-derivable control state (the allowed in-memory exception);
         * the durable job record is the SQLite row.
         * @type {Map<number, { controller: AbortController }>}
         */
        this._jobs = new Map();
        this.runnerId = makeRunnerId();
    }

    /** The Observatory needs both its own switch AND the sandbox it rides on. */
    get enabled() {
        return this.config.enabled === true && this.sandbox.enabled === true;
    }

    // --- Lifecycle -----------------------------------------------------------

    /**
     * Reclaim stale leases: a RUNNING row with no live in-process handle
     * AND an expired (or missing) heartbeat is an orphan. A fresh
     * heartbeat means another process still owns the job — leave it.
     */
    async _ensureReaped() {
        try {
            const cutoff = staleCutoffUtc();
            const rows = await db.all(
                `SELECT id, cancelRequested FROM observatory_jobs
                 WHERE status = 'RUNNING'
                   AND (lastHeartbeatAt IS NULL OR lastHeartbeatAt < @cutoff)`,
                { cutoff }
            );
            for (const row of rows) {
                if (this._jobs.has(row.id)) continue;
                const cancelled = Number(row.cancelRequested) === 1;
                const status = cancelled ? 'CANCELLED' : 'INTERRUPTED';
                const error = cancelled
                    ? 'Cancelled (the owning worker did not acknowledge before the lease expired).'
                    : 'The job lease expired (process crash or restart).';
                const reaped = (await db.run(
                    `UPDATE observatory_jobs
                     SET status = @status, error = @error,
                         finishedAt = datetime('now')
                     WHERE id = @id AND status = 'RUNNING'
                       AND (lastHeartbeatAt IS NULL OR lastHeartbeatAt < @cutoff)`,
                    { id: row.id, cutoff, status, error }
                )).changes > 0;
                if (reaped) await this._publishJobEvent(row.id, status);
            }
        } catch (error) {
            logger.warn?.(`[observatory] Orphan reap failed: ${error.message}`);
        }
    }

    async _requireEnabled() {
        if (!this.enabled) {
            throw new ObservatoryError(403, 'DISABLED', 'The Observatory is disabled on this server.');
        }
        await this._ensureReaped();
    }

    /**
     * Auto-resume after a restart: every INTERRUPTED job that left a
     * checkpoint re-enters RUNNING and its segment loop starts again, so a
     * deploy or crash never silently freezes a long-running project. Same
     * legality rules as a manual resume: the checkpoint convention is
     * required and the per-user active-job cap is respected (INTERRUPTED
     * resumes never consume the timeout-resume budget). Jobs without a
     * checkpoint stay INTERRUPTED for the owner to restart by hand.
     * Called once on startup (after the Discord client is ready, so
     * completion notifications can reach the owner's DMs).
     * @param {Object} [params] - { client } (a live client or a DiscordGateway)
     * @returns {number[]} ids of the jobs resumed
     */
    async autoResumeInterrupted({ client = null } = {}) {
        if (!this.enabled) return [];
        const outcome = await db.withSingletonLock('observatory_auto_resume', () =>
            this._autoResumeInterruptedBody({ client })
        );
        if (!outcome.acquired) {
            logger.warn?.('[observatory] Auto-resume skipped: another process holds the singleton lock');
            return [];
        }
        return outcome.result;
    }

    async _autoResumeInterruptedBody({ client = null } = {}) {
        await this._ensureReaped();
        const rows = await db.all(
            `SELECT j.id, j.userId, j.legacyWorkspace, p.userId AS ownerId, p.slug
             FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.status = 'INTERRUPTED'
             ORDER BY j.id ASC`
        );
        const resumed = [];
        for (const row of rows) {
            try {
                const dir = this._projectDir(row.ownerId, row.slug);
                if (this._checkpointMtime(dir, row.id, row) === null) continue;
                const active = await db.get(
                    `SELECT COUNT(*) AS c FROM observatory_jobs
                     WHERE userId = @userId AND status = 'RUNNING'`,
                    { userId: row.userId }
                );
                if ((active?.c || 0) >= this.config.maxActiveJobsPerUser) continue;
                const leaseToken = makeLeaseToken();
                const claimed = (await db.run(
                    `UPDATE observatory_jobs
                     SET status = 'RUNNING', error = NULL, finishedAt = NULL,
                         lastHeartbeatAt = datetime('now'), runnerId = @runnerId,
                         leaseToken = @leaseToken, cancelRequested = 0
                     WHERE id = @id AND status = 'INTERRUPTED'`,
                    { id: row.id, runnerId: this.runnerId, leaseToken }
                )).changes > 0;
                if (!claimed) continue;
                await this._publishJobEvent(row.id, 'RUNNING');
                this._startJobLoop(row.id, { client, leaseToken });
                resumed.push(row.id);
                logger.info?.(`[observatory] Auto-resumed job #${row.id} (${row.slug}) from its checkpoint after a restart`);
            } catch (error) {
                logger.warn?.(`[observatory] Auto-resume of job #${row.id} failed: ${error.message}`);
            }
        }
        return resumed;
    }

    // --- Projects ------------------------------------------------------------

    /** Deterministic slug from a human name; throws on unusable input. */
    _slugify(name) {
        const slug = String(name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, SLUG_MAX_LENGTH)
            .replace(/-+$/g, '');
        if (!SLUG_PATTERN.test(slug)) {
            throw new ObservatoryError(400, 'BAD_NAME',
                'Project names need at least one letter or digit.');
        }
        return slug;
    }

    /** The workspace directory for one project (created on demand). */
    _projectDir(userId, slug) {
        if (!USER_ID_PATTERN.test(String(userId || ''))) {
            throw new ObservatoryError(400, 'BAD_USER', 'A valid user id is required.');
        }
        return path.join(PROJECTS_ROOT, String(userId), slug);
    }

    /** Recursive workspace size in MB (quota accounting). */
    _dirSizeMb(dir) {
        let bytes = 0;
        const walk = (current) => {
            let entries;
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.isFile()) {
                    try { bytes += fs.statSync(full).size; } catch { /* raced away */ }
                }
            }
        };
        walk(dir);
        return bytes / (1024 * 1024);
    }

    /** Enforce the per-project disk quota before spending compute on a run. */
    _checkQuota(dir) {
        const sizeMb = this._dirSizeMb(dir);
        if (sizeMb > this.config.maxProjectMb) {
            throw new ObservatoryError(413, 'QUOTA_EXCEEDED',
                `The project workspace is over its ${this.config.maxProjectMb} MB quota `
                + `(${sizeMb.toFixed(1)} MB). Delete files (or the project) to continue.`);
        }
        return sizeMb;
    }

    /**
     * Create a named project with a durable workspace.
     * @param {Object} params - { userId, name }
     * @returns {{ slug: string, name: string, createdAt: string }}
     */
    async createProject({ userId, name }) {
        await this._requireEnabled();
        const cleanName = String(name ?? '').trim().slice(0, MAX_NAME_LENGTH);
        if (!cleanName) {
            throw new ObservatoryError(400, 'BAD_NAME', 'A project needs a name.');
        }
        const slug = this._slugify(cleanName);
        const existing = await db.get(
            `SELECT COUNT(*) AS c FROM observatory_projects
             WHERE userId = @userId AND slug != @workshopSlug`,
            { userId, workshopSlug: WORKSHOP_SLUG }
        );
        if ((existing?.c || 0) >= this.config.maxProjectsPerUser) {
            throw new ObservatoryError(400, 'TOO_MANY_PROJECTS',
                `At most ${this.config.maxProjectsPerUser} projects - delete one first.`);
        }
        const duplicate = await db.get(
            'SELECT 1 AS ok FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        if (duplicate) {
            throw new ObservatoryError(409, 'DUPLICATE_PROJECT',
                `You already have a project called "${slug}".`);
        }

        // Same isolation posture as sandbox run dirs: owner-only.
        const dir = this._projectDir(userId, slug);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(path.dirname(dir), 0o700);
        fs.chmodSync(dir, 0o700);

        const row = await db.get(
            `INSERT INTO observatory_projects (userId, slug, name)
             VALUES (@userId, @slug, @name)
             RETURNING id, slug, name, userId, createdAt`,
            { userId, slug, name: cleanName }
        );
        return row;
    }

    /**
     * The Phase 2 inbox project for migrated Workshop pins. Created only
     * when needed, never counted against maxProjectsPerUser, and does not
     * require the Observatory to be enabled (assets are data).
     * @param {string} userId
     * @returns {Promise<{id: number, slug: string, name: string}>}
     */
    async ensureWorkshopProject(userId) {
        const existing = await db.get(
            `SELECT id, slug, name FROM observatory_projects
             WHERE userId = @userId AND slug = @slug`,
            { userId, slug: WORKSHOP_SLUG }
        );
        if (existing) {
            const dir = this._projectDir(userId, WORKSHOP_SLUG);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            return existing;
        }

        const dir = this._projectDir(userId, WORKSHOP_SLUG);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(path.dirname(dir), 0o700);
            fs.chmodSync(dir, 0o700);
        } catch { /* best-effort perms on some filesystems */ }

        try {
            const id = await db.insert(
                `INSERT INTO observatory_projects (userId, slug, name)
                 VALUES (@userId, @slug, @name)`,
                { userId, slug: WORKSHOP_SLUG, name: WORKSHOP_NAME }
            );
            return { id, slug: WORKSHOP_SLUG, name: WORKSHOP_NAME };
        } catch (error) {
            const raced = await db.get(
                `SELECT id, slug, name FROM observatory_projects
                 WHERE userId = @userId AND slug = @slug`,
                { userId, slug: WORKSHOP_SLUG }
            );
            if (raced) return raced;
            throw error;
        }
    }

    /**
     * The user's projects (owned first-class plus accepted memberships),
     * most recently touched first, with size and job counts (the tool's
     * `list` action and the portal pane). Every row carries ownerId +
     * ownerName so the UI can link unambiguously when two projects share
     * a slug.
     * @param {string} userId
     */
    async listProjects(userId) {
        await this._requireEnabled();
        const rows = await db.all(
            `SELECT p.id, p.slug, p.name, p.userId AS ownerId, p.createdAt, p.updatedAt,
                    CASE WHEN p.userId = @userId THEN 'owner' ELSE 'collaborator' END AS role,
                    (SELECT COUNT(*) FROM observatory_jobs j
                     WHERE j.projectId = p.id AND j.status = 'RUNNING') AS runningJobs,
                    (SELECT COUNT(*) FROM observatory_jobs j WHERE j.projectId = p.id) AS totalJobs,
                    EXISTS (SELECT 1 FROM observatory_share_links s WHERE s.projectId = p.id) AS shared
             FROM observatory_projects p
             WHERE p.userId = @userId
                OR EXISTS (SELECT 1 FROM project_members m
                           WHERE m.projectId = p.id AND m.userId = @userId)
             ORDER BY p.updatedAt DESC, p.id DESC`,
            { userId }
        );
        const names = new Map();
        for (const ownerId of new Set(rows.map(row => row.ownerId))) {
            names.set(ownerId, await this._displayName(ownerId));
        }
        return rows.map(row => ({
            id: row.id,
            slug: row.slug,
            name: row.name,
            ownerId: row.ownerId,
            ownerName: names.get(row.ownerId) || null,
            role: row.role,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            runningJobs: row.runningJobs,
            totalJobs: row.totalJobs,
            shared: Boolean(row.shared),
            sizeMb: Number(this._dirSizeMb(this._projectDir(row.ownerId, row.slug)).toFixed(2)),
            quotaMb: this.config.maxProjectMb
        }));
    }

    /**
     * Public project resolution for sibling services (e.g. the sandbox
     * data-fetch flow): same actor check and 404 as every tool action.
     * @returns {{ id:number, slug:string, name:string, dir:string, ownerId:string, role:string }}
     */
    async resolveProject({ userId, project, owner = null }) {
        await this._requireEnabled();
        return await this.resolveProjectForActor({ userId, project, owner });
    }

    /**
     * The one actor-resolution helper: owned projects first, then
     * memberships. Optional `owner` disambiguates a slug the actor can
     * see on more than one owner's project.
     * @param {Object} params - { userId, project, owner? }
     * @returns {{ id:number, slug:string, name:string, userId:string, ownerId:string, role:'owner'|'collaborator', dir:string }}
     */
    async resolveProjectForActor({ userId, project, owner = null } = {}) {
        const ref = String(project ?? '').trim();
        if (!ref) {
            throw new ObservatoryError(400, 'BAD_PROJECT', 'Which project? Give its name or slug.');
        }
        const slugRef = ref.toLowerCase();
        const ownerQual = owner != null && String(owner).trim() !== ''
            ? String(owner).trim()
            : null;
        const matchSql = '(p.slug = @slugRef OR p.name = @ref COLLATE NOCASE)';

        if (ownerQual) {
            const row = await db.get(
                `SELECT p.id, p.slug, p.name, p.userId
                 FROM observatory_projects p
                 WHERE p.userId = @ownerId AND ${matchSql}`,
                { ownerId: ownerQual, slugRef, ref }
            );
            if (!row) {
                throw new ObservatoryError(404, 'NO_SUCH_PROJECT',
                    `No project called "${ref}".`);
            }
            if (row.userId === userId) {
                return this._projectForActor(row, 'owner');
            }
            const member = await db.get(
                `SELECT 1 AS ok FROM project_members
                 WHERE projectId = @projectId AND userId = @userId`,
                { projectId: row.id, userId }
            );
            if (!member) {
                throw new ObservatoryError(404, 'NO_SUCH_PROJECT',
                    `No project called "${ref}".`);
            }
            return this._projectForActor(row, 'collaborator');
        }

        const owned = await db.get(
            `SELECT p.id, p.slug, p.name, p.userId
             FROM observatory_projects p
             WHERE p.userId = @userId AND ${matchSql}`,
            { userId, slugRef, ref }
        );
        if (owned) {
            return this._projectForActor(owned, 'owner');
        }

        const memberships = await db.all(
            `SELECT p.id, p.slug, p.name, p.userId
             FROM observatory_projects p
             JOIN project_members m ON m.projectId = p.id
             WHERE m.userId = @userId AND ${matchSql}
             ORDER BY p.id ASC`,
            { userId, slugRef, ref }
        );
        if (memberships.length === 0) {
            throw new ObservatoryError(404, 'NO_SUCH_PROJECT',
                `No project called "${ref}" - create it first (or check \`list\`).`);
        }
        if (memberships.length > 1) {
            throw new ObservatoryError(409, 'AMBIGUOUS_PROJECT',
                `More than one project is called "${ref}". Pass owner=<userId> to pick one.`);
        }
        return this._projectForActor(memberships[0], 'collaborator');
    }

    _projectForActor(row, role) {
        return {
            id: row.id,
            slug: row.slug,
            name: row.name,
            userId: row.userId,
            ownerId: row.userId,
            role,
            dir: this._projectDir(row.userId, row.slug)
        };
    }

    _assertOwner(row) {
        if (row.role !== 'owner') {
            throw new ObservatoryError(403, 'NOT_OWNER',
                'Only the project owner can do that.');
        }
        return row;
    }

    async _displayName(userId) {
        try {
            const nick = await db.get(
                'SELECT nickname FROM user_nicknames WHERE userId = @userId LIMIT 1',
                { userId }
            );
            if (nick?.nickname) return nick.nickname;
        } catch { /* table may be empty */ }
        return null;
    }

    /** Current workspace size in MB for a resolved project (quota math). */
    workspaceSizeMb(row) {
        return this._dirSizeMb(row.dir);
    }

    /** Resolve a project the actor can access by slug (or exact name), or 404. */
    async _requireProject(userId, projectRef, owner = null) {
        return await this.resolveProjectForActor({ userId, project: projectRef, owner });
    }

    /**
     * Delete a project: its jobs (cascade), its registry row, and its whole
     * workspace directory. Owner-reserved. Refused while a job is running.
     * @param {Object} params - { userId, project, owner?, gateway?, client? }
     */
    async deleteProject({ userId, project, owner = null, gateway = null, client = null }) {
        await this._requireEnabled();
        const row = this._assertOwner(await this._requireProject(userId, project, owner));
        const running = await db.get(
            `SELECT COUNT(*) AS c FROM observatory_jobs
             WHERE projectId = @projectId AND status = 'RUNNING'`,
            { projectId: row.id }
        );
        if ((running?.c || 0) > 0) {
            throw new ObservatoryError(409, 'JOB_ACTIVE',
                'A background job is still running in this project - cancel it first.');
        }
        const members = await db.all(
            'SELECT userId FROM project_members WHERE projectId = @id',
            { id: row.id }
        );
        await this._deleteProjectKnowledge(row);
        // The linked project parlor (messages, seats, member rows cascade
        // from its conversation row). Lazy require: parlorService is a
        // sibling feature, not a dependency of every project operation.
        try {
            await require('./parlorService').deleteProjectConversation(row.id);
        } catch { /* the discussion may never have been created */ }
        // Share links / members / invites cascade with the project row;
        // the dashboard file and workspace tree are removed by hand.
        await db.run('DELETE FROM observatory_projects WHERE id = @id', { id: row.id });
        try { fs.rmSync(row.dir, { recursive: true, force: true }); } catch { /* best effort */ }
        try { fs.rmSync(this._dashboardPath(row.ownerId, row.slug), { force: true }); } catch { /* best effort */ }
        await this.notifyProjectsGone(
            [{ name: row.name, slug: row.slug, memberIds: members.map(m => m.userId) }],
            gateway || client
        );
        return { deleted: true, slug: row.slug };
    }

    /**
     * DM collaborators that an owned project they sat on is gone.
     * Fire-and-forget per delivery; a closed DM is not an error.
     */
    async notifyProjectsGone(notices, gateway = null, client = null) {
        const resolved = toGateway(gateway || client);
        if (!resolved || !Array.isArray(notices) || notices.length === 0) return;
        for (const notice of notices) {
            const line = `🔭 The project "${notice.name || notice.slug}" has been deleted by its owner.`;
            for (const memberId of notice.memberIds || []) {
                try {
                    await resolved.sendDm(memberId, { content: line });
                } catch { /* sendDm never throws on LocalGateway; still guard */ }
            }
        }
    }

    /**
     * Workspace file listing. With no `path`, directories are walked
     * recursively (the project-detail / dashboard shape). With `path`,
     * only that directory is listed so the portal explorer can expand
     * lazily. Paths come back workspace-relative with '/' separators.
     * @param {Object} params - { userId, project, path }
     */
    async listFiles({ userId, project, path: relPath = undefined, owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const sizeMb = Number(this._dirSizeMb(row.dir).toFixed(2));
        const quotaMb = this.config.maxProjectMb;
        const describe = (rel, name, stat, isDir) => {
            const ext = path.extname(name).toLowerCase();
            return {
                path: rel,
                name,
                size: isDir ? 0 : stat.size,
                kind: isDir ? 'directory' : 'file',
                isImage: !isDir && IMAGE_EXTENSIONS.has(ext),
                isVideo: !isDir && VIDEO_EXTENSIONS.has(ext),
                modifiedAt: toUtcText(stat.mtimeMs)
            };
        };

        if (relPath !== undefined && relPath !== null) {
            const legal = legalizeWorkspacePath(row.dir, relPath, { allowEmpty: true });
            let stat;
            try { stat = fs.lstatSync(legal.absolutePath); } catch {
                throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
            }
            if (stat.isSymbolicLink()) {
                throw new ObservatoryError(400, 'BAD_PATH',
                    'Symbolic links are not allowed in the project workspace.');
            }
            if (stat.isFile()) {
                return {
                    project: row.slug,
                    path: legal.relativePath,
                    sizeMb,
                    quotaMb,
                    totalFiles: 1,
                    files: [describe(legal.relativePath, path.basename(legal.relativePath), stat, false)],
                    entries: [describe(legal.relativePath, path.basename(legal.relativePath), stat, false)]
                };
            }
            if (!stat.isDirectory()) {
                throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
            }
            let dirents;
            try {
                dirents = fs.readdirSync(legal.absolutePath, { withFileTypes: true });
            } catch {
                throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
            }
            const entries = [];
            for (const entry of dirents) {
                if (entry.isSymbolicLink()) continue;
                const childRel = legal.relativePath
                    ? `${legal.relativePath}/${entry.name}`
                    : entry.name;
                let childStat;
                try { childStat = fs.statSync(path.join(legal.absolutePath, entry.name)); } catch {
                    continue;
                }
                entries.push(describe(childRel, entry.name, childStat, entry.isDirectory()));
            }
            entries.sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            return {
                project: row.slug,
                path: legal.relativePath,
                sizeMb,
                quotaMb,
                totalFiles: entries.filter(e => e.kind === 'file').length,
                files: entries.filter(e => e.kind === 'file'),
                entries
            };
        }

        const files = [];
        const walk = (current, rel) => {
            let entries;
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) walk(full, childRel);
                else if (entry.isFile()) {
                    let stat;
                    try { stat = fs.statSync(full); } catch { continue; }
                    files.push({
                        ...describe(childRel, entry.name, stat, false),
                        mtime: stat.mtimeMs
                    });
                }
            }
        };
        walk(row.dir, '');
        files.sort((a, b) => b.mtime - a.mtime);
        return {
            project: row.slug,
            sizeMb,
            quotaMb,
            totalFiles: files.length,
            files: files.slice(0, this.config.maxWorkspaceFiles)
                .map(({ mtime, ...rest }) => rest)
        };
    }

    /**
     * Resolve one workspace-relative path to an absolute file inside the
     * project (containment-checked - the portal's file/video serving).
     * @param {Object} params - { userId, project, relPath }
     * @returns {{ path: string, name: string }}
     */
    async resolveFile({ userId, project, relPath, owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const resolved = path.resolve(row.dir, String(relPath || ''));
        if (resolved !== row.dir && !resolved.startsWith(row.dir + path.sep)) {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }
        let stat;
        try { stat = fs.statSync(resolved); } catch { stat = null; }
        if (!stat?.isFile()) {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }
        return { path: resolved, name: path.basename(resolved) };
    }

    /**
     * Legalize a workspace-relative path for the owner-only reader and
     * writers. Absolute paths, NUL, empty segments, `.`, `..`, and
     * escaping (or any) symlinks are refused before a byte is written.
     * @param {string} workspaceDir
     * @param {string} relativePath
     * @param {{ allowEmpty?: boolean, mustExist?: boolean }} [opts]
     * @returns {{ relativePath: string, absolutePath: string }}
     */
    legalizeWorkspacePath(workspaceDir, relativePath, opts = {}) {
        return legalizeWorkspacePath(workspaceDir, relativePath, opts);
    }

    /** @deprecated use legalizeWorkspacePath — kept as the string-only step. */
    _normalizeWorkspaceReadPath(relativePath) {
        return normalizeWorkspaceRelPath(relativePath);
    }

    /**
     * Read one workspace file the user owns. Used by the applet capability
     * bridge and the portal explorer — never expose $GOOBSTER_PROJECT_DIR
     * or any absolute path.
     *
     * Confirms project ownership, rejects traversal / symlinks /
     * directories / oversized files. Applet reads (`purpose: 'applet'`,
     * the default) also refuse unsupported types; portal reads return
     * any file with a guessed MIME.
     *
     * @param {Object} params - { userId, slug, relativePath, purpose }
     * @returns {{ relativePath: string, name: string, mime: string, bytes: Buffer, size: number }}
     */
    async readWorkspaceFile({ userId, slug, relativePath, purpose = 'applet', owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, slug, owner);
        const { relativePath: rel, absolutePath: resolved } = legalizeWorkspacePath(
            row.dir, relativePath, { mustExist: true }
        );

        let lstat;
        try { lstat = fs.lstatSync(resolved); } catch {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }
        if (lstat.isDirectory()) {
            throw new ObservatoryError(400, 'NOT_A_FILE', 'That path is a directory.');
        }
        if (!lstat.isFile()) {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }

        const ext = path.extname(resolved).toLowerCase();
        const portal = purpose === 'portal';
        const mime = portal
            ? (WORKSPACE_READ_MIME[ext] || PORTAL_READ_MIME[ext] || 'application/octet-stream')
            : WORKSPACE_READ_MIME[ext];
        if (!mime) {
            throw new ObservatoryError(415, 'UNSUPPORTED_TYPE',
                'That file type is not readable through the applet bridge.');
        }

        const maxMb = Number(this.config.maxWorkspaceReadMb) > 0
            ? Number(this.config.maxWorkspaceReadMb)
            : 8;
        const maxBytes = Math.floor(maxMb * 1024 * 1024);
        if (lstat.size > maxBytes) {
            throw new ObservatoryError(413, 'FILE_TOO_LARGE',
                `That file is larger than the ${maxMb} MB read cap.`);
        }

        const bytes = fs.readFileSync(resolved);
        return {
            relativePath: rel,
            name: path.basename(rel),
            mime,
            bytes,
            size: bytes.length
        };
    }

    /**
     * Read a line window of a workspace text file for the observatory tool.
     * Same containment rules as readWorkspaceFile; any text file is allowed
     * (not just the applet MIME allowlist). Images, video, PDFs, and
     * NUL-containing binaries are refused — use `files` for those.
     *
     * @param {Object} params - { userId, slug, relativePath, offset, limit, owner }
     * @returns {{
     *   relativePath: string, name: string, size: number,
     *   content: string, startLine: number, endLine: number,
     *   totalLines: number, truncated: boolean, nextOffset: number|null,
     *   charCapped: boolean
     * }}
     */
    async readWorkspaceText({
        userId, slug, relativePath, offset = 1, limit, owner = null
    }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, slug, owner);
        const { relativePath: rel, absolutePath: resolved } = legalizeWorkspacePath(
            row.dir, relativePath, { mustExist: true }
        );

        let lstat;
        try { lstat = fs.lstatSync(resolved); } catch {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }
        if (lstat.isDirectory()) {
            throw new ObservatoryError(400, 'NOT_A_FILE', 'That path is a directory.');
        }
        if (!lstat.isFile()) {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }

        const ext = path.extname(resolved).toLowerCase();
        const rasterOrVideo = (IMAGE_EXTENSIONS.has(ext) && ext !== '.svg')
            || VIDEO_EXTENSIONS.has(ext)
            || ext === '.pdf';
        if (rasterOrVideo) {
            throw new ObservatoryError(415, 'NOT_TEXT',
                'That file is not text. Use action "files" for media, or read a .txt/.py/.md/.json companion.');
        }

        const maxMb = Number(this.config.maxWorkspaceReadMb) > 0
            ? Number(this.config.maxWorkspaceReadMb)
            : 8;
        const maxBytes = Math.floor(maxMb * 1024 * 1024);
        if (lstat.size > maxBytes) {
            throw new ObservatoryError(413, 'FILE_TOO_LARGE',
                `That file is larger than the ${maxMb} MB read cap. `
                + 'Split it, or `run` a sed/head over a range and write the slice to a smaller file.');
        }

        const bytes = fs.readFileSync(resolved);
        const sniffLen = Math.min(bytes.length, 8192);
        for (let i = 0; i < sniffLen; i++) {
            if (bytes[i] === 0) {
                throw new ObservatoryError(415, 'NOT_TEXT',
                    'That file looks binary (NUL byte). Use action "files" for its path and size.');
            }
        }

        const text = bytes.toString('utf8');
        const win = windowLines(text, { offset, limit });
        return {
            relativePath: rel,
            name: path.basename(rel),
            size: bytes.length,
            ...win
        };
    }

    /**
     * Write one workspace file the owner just uploaded or edited.
     * Directories are created from the path. Quota and maxUploadMb are
     * checked before any byte is written. Same sandbox the runs write to.
     * @param {Object} params - { userId, slug, relativePath, bytes }
     */
    async writeWorkspaceFile({ userId, slug, relativePath, bytes, owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, slug, owner);
        const { relativePath: rel, absolutePath: resolved } = legalizeWorkspacePath(
            row.dir, relativePath
        );
        if (resolved === path.resolve(row.dir)) {
            throw new ObservatoryError(400, 'BAD_PATH', 'Cannot overwrite the workspace root.');
        }
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes == null ? '' : String(bytes));
        const maxUploadMb = Number(this.config.maxUploadMb) > 0 ? Number(this.config.maxUploadMb) : 50;
        const maxUploadBytes = Math.floor(maxUploadMb * 1024 * 1024);
        if (buf.length > maxUploadBytes) {
            throw new ObservatoryError(413, 'FILE_TOO_LARGE',
                `That upload is larger than the ${maxUploadMb} MB cap.`);
        }

        let existingBytes = 0;
        try {
            const existing = fs.lstatSync(resolved);
            if (existing.isSymbolicLink()) {
                throw new ObservatoryError(400, 'BAD_PATH',
                    'Symbolic links are not allowed in the project workspace.');
            }
            if (existing.isDirectory()) {
                throw new ObservatoryError(400, 'NOT_A_FILE', 'That path is a directory.');
            }
            if (existing.isFile()) existingBytes = existing.size;
        } catch (error) {
            if (error?.code === 'BAD_PATH' || error?.code === 'NOT_A_FILE') throw error;
            /* missing — we will create it */
        }

        const usedMb = this._dirSizeMb(row.dir);
        const nextMb = usedMb - (existingBytes / (1024 * 1024)) + (buf.length / (1024 * 1024));
        if (nextMb > this.config.maxProjectMb) {
            throw new ObservatoryError(413, 'QUOTA_EXCEEDED',
                `The project workspace is over its ${this.config.maxProjectMb} MB quota `
                + `(${usedMb.toFixed(1)} MB). Delete files (or the project) to continue.`);
        }

        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, buf);
        await this._touchProject(row.id);
        require('./eventBusService').publishProjectChange({
            userId, slug: row.slug, reason: 'workspace', projectId: row.id
        });
        return {
            relativePath: rel,
            name: path.basename(rel),
            size: buf.length
        };
    }

    /**
     * Delete one workspace file (or an empty directory) the owner owns.
     * @param {Object} params - { userId, slug, relativePath }
     */
    async deleteWorkspaceFile({ userId, slug, relativePath, owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, slug, owner);
        const { relativePath: rel, absolutePath: resolved } = legalizeWorkspacePath(
            row.dir, relativePath, { mustExist: true }
        );
        if (resolved === path.resolve(row.dir)) {
            throw new ObservatoryError(400, 'BAD_PATH', 'Cannot delete the workspace root.');
        }
        const lst = fs.lstatSync(resolved);
        if (lst.isDirectory()) {
            let leftover;
            try { leftover = fs.readdirSync(resolved); } catch { leftover = ['?']; }
            if (leftover.length > 0) {
                throw new ObservatoryError(400, 'NOT_EMPTY',
                    'That directory is not empty.');
            }
            fs.rmdirSync(resolved);
        } else {
            fs.unlinkSync(resolved);
        }
        await this._touchProject(row.id);
        require('./eventBusService').publishProjectChange({
            userId, slug: row.slug, reason: 'workspace', projectId: row.id
        });
        return { deleted: true, relativePath: rel };
    }

    /** Latest job-owned checkpoint, then the legacy project-root file. */
    _readCheckpoint(dir) {
        const candidates = [];
        try {
            const runs = path.join(dir, RUNS_DIR);
            const ids = fs.readdirSync(runs)
                .filter(name => /^\d+$/.test(name))
                .map(Number)
                .sort((a, b) => b - a);
            for (const id of ids) candidates.push(path.join(runs, String(id), CHECKPOINT_FILE));
        } catch { /* no runs yet */ }
        candidates.push(path.join(dir, CHECKPOINT_FILE));
        for (const file of candidates) {
            try {
                const raw = fs.readFileSync(file, 'utf8');
                return raw.length > MAX_CHECKPOINT_CHARS
                    ? `${raw.slice(0, MAX_CHECKPOINT_CHARS)}\n… [truncated]`
                    : raw;
            } catch { /* try next */ }
        }
        return null;
    }

    /**
     * The standardized "one project" object behind the portal's project
     * view: the registry row with live status counts, the project's jobs
     * WITH their output tails, the bounded workspace listing, and the
     * current checkpoint - the same facts the shareable dashboard snapshot
     * renders, but as live data for one canonical client-side view.
     * @param {Object} params - { userId, project }
     */
    async getProjectDetail({ userId, project, owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const registry = await db.get(
            `SELECT p.id, p.slug, p.name, p.userId AS ownerId, p.createdAt, p.updatedAt,
                    (SELECT COUNT(*) FROM observatory_jobs j WHERE j.projectId = p.id) AS totalJobs,
                    (SELECT COUNT(*) FROM observatory_jobs j
                     WHERE j.projectId = p.id AND j.status = 'RUNNING') AS runningJobs,
                    EXISTS (SELECT 1 FROM observatory_share_links s WHERE s.projectId = p.id) AS shared
             FROM observatory_projects p WHERE p.id = @id`,
            { id: row.id }
        );
        const listing = await this.listFiles({
            userId, project: row.slug, owner: row.ownerId
        });
        return {
            project: {
                id: registry.id,
                slug: registry.slug,
                name: registry.name,
                ownerId: registry.ownerId,
                ownerName: await this._displayName(registry.ownerId),
                role: row.role,
                createdAt: registry.createdAt,
                updatedAt: registry.updatedAt,
                shared: Boolean(registry.shared),
                runningJobs: registry.runningJobs,
                totalJobs: registry.totalJobs,
                sizeMb: listing.sizeMb,
                quotaMb: listing.quotaMb
            },
            jobs: await this.listJobs({
                userId, project: row.slug, includeTails: true, owner: row.ownerId
            }),
            files: listing.files,
            totalFiles: listing.totalFiles,
            checkpoint: this._readCheckpoint(row.dir)
        };
    }

    /**
     * Compact, size-bounded snapshot of one project for the chat preamble.
     * Long lists are truncated so the model sees the shape without a
     * second tool round, and without blowing the prompt.
     * @param {Object} params - { userId, project, maxAssets, maxTriggers, maxFiles }
     * @returns {{ text: string, truncated: { assets: boolean, triggers: boolean, files: boolean } }}
     */
    async buildChatManifest({
        userId,
        project,
        owner = null,
        maxAssets = MANIFEST_MAX_ASSETS,
        maxTriggers = MANIFEST_MAX_TRIGGERS,
        maxFiles = MANIFEST_MAX_FILES
    } = {}) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const projectAssetService = require('./projectAssetService');
        const projectTriggerService = require('./projectTriggerService');
        const assets = await projectAssetService.list({
            userId, project: row.slug, owner: row.ownerId
        });
        const triggers = await projectTriggerService.list({
            userId, project: row.slug, owner: row.ownerId
        });
        const jobs = await this.listJobs({
            userId, project: row.slug, owner: row.ownerId
        });
        let workspace;
        try {
            workspace = await this.listFiles({
                userId, project: row.slug, path: '', owner: row.ownerId
            });
        } catch {
            workspace = { entries: [] };
        }
        const assetCap = Math.max(1, Number(maxAssets) || MANIFEST_MAX_ASSETS);
        const triggerCap = Math.max(1, Number(maxTriggers) || MANIFEST_MAX_TRIGGERS);
        const fileCap = Math.max(1, Number(maxFiles) || MANIFEST_MAX_FILES);
        const knowledgeCap = MANIFEST_MAX_KNOWLEDGE;
        const shownAssets = assets.slice(0, assetCap);
        const shownTriggers = triggers.slice(0, triggerCap);
        const entries = workspace.entries || [];
        const shownFiles = entries.slice(0, fileCap);
        const latest = jobs[0] || null;
        const coords = this.knowledgeCoords(row);
        let knowledgeText = '(none)';
        let knowledgeTruncated = false;
        try {
            const excerpt = await knowledgeGraphService.describeForPrompt({
                guildId: coords.guildId,
                scopeKey: coords.scopeKey,
                limit: knowledgeCap
            });
            const tags = await knowledgeGraphService.listScopeTags({
                guildId: coords.guildId,
                scopeKey: coords.scopeKey
            });
            const tagSummary = (tags || []).slice(0, knowledgeCap).map(t => t.name).join(', ');
            const parts = [];
            if (excerpt) parts.push(excerpt);
            if (tagSummary) parts.push(`Tags: ${tagSummary}${(tags || []).length > knowledgeCap ? ` … +${tags.length - knowledgeCap} more` : ''}`);
            if (parts.length) knowledgeText = parts.join('\n');
            knowledgeTruncated = (tags || []).length > knowledgeCap;
        } catch { /* knowledge is optional in the preamble */ }
        const lines = [
            `Project manifest for "${row.name}" (slug: ${row.slug}):`,
            `Assets (${assets.length}): ${shownAssets.length
                ? shownAssets.map(a => `${a.slug} ${a.kind} ${a.language || ''} v${a.currentVersion || a.version || '?'}`
                    .replace(/\s+/g, ' ').trim()).join('; ')
                : '(none)'}`
                + (assets.length > assetCap ? `; … +${assets.length - assetCap} more` : ''),
            `Triggers (${triggers.length}): ${shownTriggers.length
                ? shownTriggers.map(t => `${t.name} ${t.kind} ${t.isEnabled ? 'enabled' : 'disabled'}`).join('; ')
                : '(none)'}`
                + (triggers.length > triggerCap ? `; … +${triggers.length - triggerCap} more` : ''),
            latest
                ? `Latest job: #${latest.id} ${latest.status}${latest.finishedAt ? ` finished ${latest.finishedAt}` : ''}`
                : 'Latest job: (none)',
            `Workspace / (${entries.length}): ${shownFiles.length
                ? shownFiles.map(f => f.kind === 'directory' ? `${f.name}/` : f.name).join(' ')
                : '(empty)'}`
                + (entries.length > fileCap ? ` … +${entries.length - fileCap} more` : ''),
            `Knowledge:\n${knowledgeText}`
        ];
        try {
            const missionText = await require('./projectMissionService').describeForManifest({
                userId, project: row.slug, owner: row.ownerId
            });
            if (missionText) lines.splice(1, 0, missionText);
        } catch { /* mission preamble is best-effort */ }
        return {
            text: lines.join('\n'),
            truncated: {
                assets: assets.length > assetCap,
                triggers: triggers.length > triggerCap,
                files: entries.length > fileCap,
                knowledge: knowledgeTruncated
            }
        };
    }

    // --- Project knowledge (kg_* scope PROJECT:<id>) -------------------------

    knowledgeCoords(row) {
        return {
            guildId: dmScopeId(row.ownerId || row.userId),
            scopeKey: knowledgeGraphService.projectScopeKey(row.id),
            ownerId: row.ownerId || row.userId,
            projectId: row.id
        };
    }

    async _deleteProjectKnowledge(row) {
        const coords = this.knowledgeCoords(row);
        await knowledgeGraphService.deleteScope({
            guildId: coords.guildId,
            scopeKey: coords.scopeKey
        });
    }

    /**
     * Route a web conversation to its project knowledge scope when the
     * title is `🔭 <project name>` (not the generic Observatory thread).
     * Returns null for every other conversation.
     */
    async resolveKnowledgeScopeForChannel(channelId) {
        if (!channelId) return null;
        const conv = await db.get(
            'SELECT userId, title FROM web_conversations WHERE channelId = @channelId',
            { channelId }
        );
        if (!conv?.title || !String(conv.title).startsWith(PROJECT_CONV_PREFIX)) return null;
        const name = String(conv.title).slice(PROJECT_CONV_PREFIX.length).trim();
        if (!name || String(conv.title).trim() === GENERIC_OBS_TITLE) return null;
        try {
            const resolved = await this.resolveProjectForActor({
                userId: conv.userId,
                project: name
            });
            return this.knowledgeCoords(resolved);
        } catch {
            return null;
        }
    }

    /**
     * Store a distilled note (and optional tags/edges) in the project
     * scope. Every write goes through the legalizer.
     */
    async noteKnowledge({
        userId, project, owner = null, label, content = '', tags = [], edges = []
    } = {}) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const coords = this.knowledgeCoords(row);
        const title = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!title) {
            throw new ObservatoryError(400, 'BAD_LABEL', 'A knowledge note needs a title.');
        }
        const body = String(content || '').trim().slice(0, 1000);
        const tagList = Array.isArray(tags)
            ? tags
            : String(tags || '').split(/[,;]/);
        const cleanedTags = [...new Set(
            tagList.map(t => String(t || '').trim().toLowerCase()).filter(Boolean)
        )].slice(0, 8);
        const linkMutations = [];
        for (const edge of (Array.isArray(edges) ? edges : [])) {
            const target = String(edge?.target || '').trim();
            if (!target) continue;
            linkMutations.push({
                source: String(edge.source || title).trim(),
                target,
                relation: edge.relation || 'relates_to',
                relationKind: edge.relationKind || 'associative',
                weight: edge.weight ?? 0.7
            });
        }
        return knowledgeGraphService.applyMutations({
            guildId: coords.guildId,
            scopeKey: coords.scopeKey,
            subjectType: 'USER',
            subjectId: row.ownerId,
            source: 'tool',
            mutations: {
                upsert: [{
                    type: 'concept',
                    label: title,
                    content: body,
                    salience: 0.7,
                    confidence: 0.8,
                    tags: cleanedTags
                }],
                link: linkMutations
            }
        });
    }

    /** Scoped retrieval for the project graph. */
    async recallKnowledge({ userId, project, owner = null, query = '', limit = 10 } = {}) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const coords = this.knowledgeCoords(row);
        return knowledgeGraphService.describeForPrompt({
            guildId: coords.guildId,
            scopeKey: coords.scopeKey,
            query: query || null,
            limit: Math.max(1, Math.min(Number(limit) || 10, 20))
        });
    }

    /** Portal Knowledge-tab graph (Spitball Map shape). */
    async getKnowledgeGraph({ userId, project, owner = null } = {}) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const coords = this.knowledgeCoords(row);
        const view = await knowledgeGraphService.getScopeGraphView({
            guildId: coords.guildId,
            scopeKey: coords.scopeKey,
            kind: 'project'
        });
        const { withTagLinks } = require('../utils/graphFilter');
        const graph = withTagLinks(view, true);
        const tags = await knowledgeGraphService.listScopeTags({
            guildId: coords.guildId,
            scopeKey: coords.scopeKey
        });
        return {
            project: {
                id: row.id,
                slug: row.slug,
                name: row.name,
                ownerId: row.ownerId,
                role: row.role
            },
            nodes: graph.nodes,
            edges: graph.edges,
            tags,
            counts: view.counts
        };
    }

    async listKnowledgeNotes({ userId, project, owner = null, q = null, limit = 100 } = {}) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const coords = this.knowledgeCoords(row);
        const params = {
            guildId: coords.guildId,
            scopeKey: coords.scopeKey,
            limit: Math.min(Math.max(Number(limit) || 100, 1), 500)
        };
        let where = 'n.guildId = @guildId AND n.scopeKey = @scopeKey';
        if (q) {
            where += ' AND (n.label LIKE @q ESCAPE \'#\' OR n.content LIKE @q ESCAPE \'#\')';
            params.q = `%${String(q).trim().replace(/[#%_]/g, '#$&')}%`;
        }
        const notes = await db.all(
            `SELECT n.id, n.type, n.label, n.content, n.salience, n.confidence,
                    n.source, n.createdAt, n.updatedAt
             FROM kg_nodes n WHERE ${where}
             ORDER BY n.updatedAt DESC, n.id DESC LIMIT @limit`,
            params
        );
        const tagMap = await knowledgeGraphService.getTagsForNodes(notes.map(n => n.id));
        return notes.map(n => ({
            id: n.id,
            type: n.type,
            label: n.label,
            content: n.content || '',
            salience: n.salience,
            confidence: n.confidence,
            source: n.source,
            tags: tagMap.get(n.id) || [],
            createdAt: n.createdAt,
            updatedAt: n.updatedAt
        }));
    }

    // --- The dashboard artifact -------------------------------------------------

    /** Where one project's generated dashboard lives (never in the workspace). */
    _dashboardPath(userId, slug) {
        return path.join(DASHBOARDS_ROOT, String(userId), `${slug}.html`);
    }

    /**
     * Build and write the project's self-contained HTML dashboard - the
     * artifact produced as the final step of every Observatory run. Media
     * is inlined as base64 data URLs (extension-checked, size-capped) so
     * the single file can be explored, downloaded, or shared as-is.
     * @param {Object} params - { userId, project }
     * @returns {{ path: string, name: string, sizeBytes: number, generatedAt: string }}
     */
    async generateDashboard({ userId, project, owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const registry = await db.get(
            `SELECT slug, name, createdAt, updatedAt FROM observatory_projects WHERE id = @id`,
            { id: row.id }
        );
        const listing = await this.listFiles({
            userId, project: row.slug, owner: row.ownerId
        });
        const jobs = await this.listJobs({
            userId, project: row.slug, includeTails: true, owner: row.ownerId
        });

        const inline = async (relPath, maxBytes) => {
            try {
                const resolved = await this.resolveFile({
                    userId, project: row.slug, relPath, owner: row.ownerId
                });
                const stat = fs.statSync(resolved.path);
                if (stat.size === 0 || stat.size > maxBytes) return null;
                const mime = MEDIA_MIME[path.extname(resolved.path).toLowerCase()];
                if (!mime) return null;
                return {
                    name: relPath,
                    dataUrl: `data:${mime};base64,${fs.readFileSync(resolved.path).toString('base64')}`
                };
            } catch {
                return null;
            }
        };

        // Newest media first (the listing is already newest-first)
        const imageFiles = listing.files.filter(f => f.isImage);
        const images = [];
        for (const file of imageFiles) {
            if (images.length >= MAX_INLINE_IMAGES) break;
            const inlined = await inline(file.path, MAX_INLINE_IMAGE_BYTES);
            if (inlined) images.push(inlined);
        }
        const videoFile = listing.files.find(f => f.isVideo);
        const video = videoFile ? await inline(videoFile.path, MAX_INLINE_VIDEO_BYTES) : null;
        const mediaTotal = imageFiles.length + listing.files.filter(f => f.isVideo).length;
        const skippedMedia = mediaTotal - images.length - (video ? 1 : 0);

        const checkpoint = this._readCheckpoint(row.dir);

        const generatedAt = toUtcText(Date.now());
        const html = buildDashboard({
            project: registry,
            sizeMb: listing.sizeMb,
            quotaMb: listing.quotaMb,
            jobs,
            files: listing.files,
            totalFiles: listing.totalFiles,
            images,
            video,
            skippedMedia,
            checkpoint,
            generatedAt
        });

        const outPath = this._dashboardPath(row.ownerId, row.slug);
        fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(outPath, html, { mode: 0o600 });
        return {
            path: outPath,
            name: `${row.slug}-dashboard.html`,
            sizeBytes: Buffer.byteLength(html),
            generatedAt
        };
    }

    /** Regenerate best-effort (the final step of runs/jobs must never fail them). */
    async _refreshDashboard(userId, slug, owner = null) {
        try {
            await this.generateDashboard({ userId, project: slug, owner: owner || userId });
        } catch (error) {
            logger.warn?.(`[observatory] Dashboard refresh for ${slug} failed: ${error.message}`);
        }
    }

    /** True when the stored dashboard predates the project's last activity. */
    async _dashboardStale(userId, row) {
        let stat;
        try {
            stat = fs.statSync(this._dashboardPath(userId, row.slug));
        } catch {
            return true;
        }
        const registry = await db.get(
            'SELECT updatedAt FROM observatory_projects WHERE id = @id', { id: row.id }
        );
        const updatedMs = new Date(`${String(registry?.updatedAt || '').replace(' ', 'T')}Z`).getTime();
        return !Number.isFinite(updatedMs) || stat.mtimeMs < updatedMs;
    }

    /**
     * The dashboard HTML for the owner (regenerated when stale or forced).
     * @param {Object} params - { userId, project, force }
     * @returns {{ html: string, path: string }}
     */
    async getDashboard({ userId, project, force = false, owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        if (force || await this._dashboardStale(row.ownerId, row)) {
            await this.generateDashboard({
                userId, project: row.slug, owner: row.ownerId
            });
        }
        const outPath = this._dashboardPath(row.ownerId, row.slug);
        return { html: fs.readFileSync(outPath, 'utf8'), path: outPath };
    }

    // --- Dashboard share links ---------------------------------------------------

    /**
     * Create (or return the existing) read-only share link for a project's
     * dashboard. One active link per project; the unguessable token is the
     * capability and grants the rendered dashboard page, nothing else.
     * @param {Object} params - { userId, project }
     * @returns {{ token: string, url: string, createdAt: string }}
     */
    async createShareLink({ userId, project, owner = null }) {
        await this._requireEnabled();
        const row = this._assertOwner(await this._requireProject(userId, project, owner));
        const existing = await db.get(
            'SELECT token, createdAt FROM observatory_share_links WHERE projectId = @projectId',
            { projectId: row.id }
        );
        if (existing) {
            return { token: existing.token, url: `/app/observatory/share/${existing.token}`, createdAt: existing.createdAt };
        }
        const token = crypto.randomBytes(20).toString('hex');
        const created = await db.get(
            `INSERT INTO observatory_share_links (userId, projectId, token)
             VALUES (@userId, @projectId, @token)
             RETURNING token, createdAt`,
            { userId: row.ownerId, projectId: row.id, token }
        );
        return { token: created.token, url: `/app/observatory/share/${created.token}`, createdAt: created.createdAt };
    }

    /**
     * The share state of one project (for the portal's share dialog).
     * @param {Object} params - { userId, project }
     */
    async getShareLink({ userId, project, owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const link = await db.get(
            'SELECT token, createdAt FROM observatory_share_links WHERE projectId = @projectId',
            { projectId: row.id }
        );
        if (!link) return { shared: false };
        return { shared: true, token: link.token, url: `/app/observatory/share/${link.token}`, createdAt: link.createdAt };
    }

    /**
     * Revoke a project's share link - the URL stops working instantly.
     * @param {Object} params - { userId, project }
     */
    async revokeShareLink({ userId, project, owner = null }) {
        await this._requireEnabled();
        const row = this._assertOwner(await this._requireProject(userId, project, owner));
        const result = await db.run(
            'DELETE FROM observatory_share_links WHERE projectId = @projectId AND userId = @ownerId',
            { projectId: row.id, ownerId: row.ownerId }
        );
        return { revoked: result.changes > 0 };
    }

    /**
     * Resolve a public share token into the dashboard HTML. No auth - the
     * unguessable token is the capability. The page is regenerated when
     * stale, so a shared link always shows the project's current state;
     * being self-contained, it exposes no other file or route. Control
     * buttons render inert for viewers (the owner-session probe fails).
     * @param {string} token
     * @returns {{ html: string, name: string }}
     */
    async getSharedDashboard(token) {
        await this._requireEnabled();
        const clean = String(token || '').trim().toLowerCase();
        if (!SHARE_TOKEN_PATTERN.test(clean)) {
            throw new ObservatoryError(404, 'NOT_FOUND', 'This share link does not exist (or was revoked).');
        }
        const link = await db.get(
            `SELECT s.userId, p.slug, p.name
             FROM observatory_share_links s
             JOIN observatory_projects p ON p.id = s.projectId
             WHERE s.token = @token`,
            { token: clean }
        );
        if (!link) {
            throw new ObservatoryError(404, 'NOT_FOUND', 'This share link does not exist (or was revoked).');
        }
        const { html } = await this.getDashboard({ userId: link.userId, project: link.slug });
        return { html, name: link.name };
    }

    // --- Runs and jobs ---------------------------------------------------------

    /** Touch a project's updatedAt (runs and jobs keep it fresh). */
    async _touchProject(projectId) {
        await db.run(
            `UPDATE observatory_projects SET updatedAt = datetime('now') WHERE id = @projectId`,
            { projectId }
        );
    }

    /** Per-job run tree: `runs/<jobId>/` under the project workspace. */
    _runDir(projectDir, jobId) {
        return path.join(projectDir, RUNS_DIR, String(jobId));
    }

    _ensureRunDir(projectDir, jobId) {
        const dir = this._runDir(projectDir, jobId);
        fs.mkdirSync(path.join(dir, FRAMES_DIR), { recursive: true, mode: 0o700 });
        return dir;
    }

    /** True only for jobs that existed before per-run directories. */
    _usesLegacyWorkspace(job) {
        return !!(job && Number(job.legacyWorkspace));
    }

    /**
     * Checkpoint path: the job-owned file. Project-root `checkpoint.json`
     * is used only when `job.legacyWorkspace` is set.
     */
    _checkpointPath(projectDir, jobId = null, job = null) {
        if (jobId != null) {
            const owned = path.join(this._runDir(projectDir, jobId), CHECKPOINT_FILE);
            try {
                if (fs.existsSync(owned)) return owned;
            } catch { /* fall through */ }
            if (!this._usesLegacyWorkspace(job)) return owned;
        }
        return path.join(projectDir, CHECKPOINT_FILE);
    }

    /** Current mtime of the job's (or legacy project) checkpoint, or null. */
    _checkpointMtime(projectDir, jobId = null, job = null) {
        try {
            return fs.statSync(this._checkpointPath(projectDir, jobId, job)).mtimeMs;
        } catch {
            return null;
        }
    }

    _framesDir(projectDir, jobId = null) {
        if (jobId != null) return path.join(this._runDir(projectDir, jobId), FRAMES_DIR);
        return path.join(projectDir, FRAMES_DIR);
    }

    /**
     * Job-owned frames when present. Project-root frames/ only for
     * explicitly identified legacy jobs.
     */
    _resolveFramesDir(projectDir, jobId = null, job = null) {
        if (jobId != null) {
            const owned = this._framesDir(projectDir, jobId);
            if (this._readFrameNames(owned).length) return owned;
            if (!this._usesLegacyWorkspace(job)) return owned;
        }
        return path.join(projectDir, FRAMES_DIR);
    }

    _readFrameNames(framesDir) {
        let entries;
        try {
            entries = fs.readdirSync(framesDir);
        } catch {
            return [];
        }
        return entries.filter(name => FRAME_PATTERN.test(name)).sort();
    }

    async _assertNoActiveJob(projectId) {
        const row = await db.get(
            `SELECT id FROM observatory_jobs
             WHERE projectId = @projectId AND status = 'RUNNING'`,
            { projectId }
        );
        if (row) {
            throw new ObservatoryError(409, 'PROJECT_BUSY',
                `Project already has running job #${row.id}. Wait for it to finish or cancel it.`);
        }
    }

    /**
     * Insert a RUNNING job (the durable project claim). Unique index
     * `uq_observatory_jobs_one_active` is the race-safe gate.
     */
    async _insertRunningJob({
        projectId, userId, language, code, assetVersionId, startedBy,
        triggerId, executionAttemptId, leaseToken
    }) {
        try {
            return await db.get(
                `INSERT INTO observatory_jobs
                    (projectId, userId, language, code, lastHeartbeatAt, runnerId,
                     assetVersionId, startedBy, triggerId, executionAttemptId,
                     leaseToken, cancelRequested, legacyWorkspace)
                 VALUES (@projectId, @userId, @language, @code, datetime('now'), @runnerId,
                         @assetVersionId, @startedBy, @triggerId, @executionAttemptId,
                         @leaseToken, 0, 0)
                 RETURNING id`,
                {
                    projectId,
                    userId,
                    language,
                    code,
                    runnerId: this.runnerId,
                    assetVersionId: assetVersionId == null ? null : Number(assetVersionId),
                    startedBy: startedBy || null,
                    triggerId: triggerId == null ? null : Number(triggerId),
                    executionAttemptId: executionAttemptId || null,
                    leaseToken
                }
            );
        } catch (error) {
            if (this._isUniqueViolation(error)) {
                throw new ObservatoryError(409, 'PROJECT_BUSY',
                    'Project already has a running job. Wait for it to finish or cancel it.');
            }
            throw error;
        }
    }

    _isUniqueViolation(error) {
        return String(error?.message || '').includes('UNIQUE');
    }

    /**
     * Run a snippet inside a project. Foreground runs behave exactly like
     * `runCode` plus the workspace mount; `background: true` detaches the
     * run into a checkpointable job and returns its id immediately.
     * @param {Object} params
     * @param {string} params.userId
     * @param {string} params.project - slug or name
     * @param {string} params.language - python | javascript | bash (+ aliases)
     * @param {string} params.code
     * @param {string} [params.stdin]
     * @param {boolean} [params.background]
     * @param {Object} [params.client] - client or DiscordGateway, for the completion
     *   notification (a follow-up delivered to the user's Discord DM).
     * @param {AbortSignal} [params.signal] - cancels a FOREGROUND run early
     *   (the chat turn's Stop button / watchdog). Background jobs ignore it:
     *   they deliberately outlive the turn that started them.
     * @param {number|null} [params.assetVersionId] - stored script version this
     *   job executed (NULL for ad-hoc inline code).
     * @param {string|null} [params.startedBy] - 'chat' | 'portal' | 'trigger' | 'resume'
     * @param {number|null} [params.triggerId] - project_triggers.id when startedBy='trigger'
     */
    async run({
        userId, project, language, code, stdin = '', background = false, client = null, signal = null,
        assetVersionId = null, startedBy = null, triggerId = null, owner = null,
        executionAttemptId = null
    }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        this._checkQuota(row.dir);

        if (!background) {
            const langKey = this.sandbox._normalizeLanguage(language);
            if (!langKey) {
                throw new ObservatoryError(400, 'BAD_LANGUAGE',
                    `Unsupported language "${language}". Supported: ${this.sandbox.languages.join(', ')}.`);
            }
            if (typeof code !== 'string' || code.trim() === '') {
                throw new ObservatoryError(400, 'EMPTY_CODE', 'No code was provided to run.');
            }
            const leaseToken = makeLeaseToken();
            const job = await this._insertRunningJob({
                projectId: row.id,
                userId,
                language: langKey,
                code,
                assetVersionId,
                startedBy: startedBy || 'foreground',
                triggerId,
                executionAttemptId,
                leaseToken
            });
            try {
                const result = await this.sandbox.run({
                    language, code, stdin, userId, projectDir: row.dir, signal
                });
                const status = result.ok
                    ? 'COMPLETED'
                    : (result.timedOut ? 'TIMED_OUT' : 'FAILED');
                await this._finishJob(job.id, status, {
                    exitCode: result.exitCode,
                    error: result.ok ? null : (result.stderr || result.error || null)
                }, leaseToken, { silent: true });
                await this._touchProject(row.id);
                await this._refreshDashboard(userId, row.slug, row.ownerId);
                return { mode: 'foreground', project: row.slug, result };
            } catch (error) {
                await this._finishJob(job.id, 'FAILED', { error: error.message }, leaseToken, { silent: true });
                throw error;
            }
        }

        // Background job: validate what we can BEFORE creating the row, so a
        // bad language never becomes a failed job.
        const langKey = this.sandbox._normalizeLanguage(language);
        if (!langKey) {
            throw new ObservatoryError(400, 'BAD_LANGUAGE',
                `Unsupported language "${language}". Supported: ${this.sandbox.languages.join(', ')}.`);
        }
        if (typeof code !== 'string' || code.trim() === '') {
            throw new ObservatoryError(400, 'EMPTY_CODE', 'No code was provided to run.');
        }
        const active = await db.get(
            `SELECT COUNT(*) AS c FROM observatory_jobs
             WHERE userId = @userId AND status = 'RUNNING'`,
            { userId }
        );
        if ((active?.c || 0) >= this.config.maxActiveJobsPerUser) {
            throw new ObservatoryError(429, 'TOO_MANY_JOBS',
                `At most ${this.config.maxActiveJobsPerUser} background job(s) at once - `
                + 'wait for one to finish or cancel it.');
        }
        const leaseToken = makeLeaseToken();
        const job = await this._insertRunningJob({
            projectId: row.id,
            userId,
            language: langKey,
            code,
            assetVersionId,
            startedBy: startedBy || null,
            triggerId,
            executionAttemptId,
            leaseToken
        });
        this._ensureRunDir(row.dir, job.id);
        await this._touchProject(row.id);
        await this._publishJobEvent(job.id, 'RUNNING');
        this._startJobLoop(job.id, { client, leaseToken });
        return {
            mode: 'background',
            project: row.slug,
            jobId: job.id,
            status: 'RUNNING',
            maxResumes: this.config.maxResumes
        };
    }

    async _touchLease(jobId, leaseToken) {
        if (!leaseToken) return false;
        try {
            const out = await db.run(
                `UPDATE observatory_jobs
                 SET lastHeartbeatAt = datetime('now'), runnerId = @runnerId
                 WHERE id = @jobId AND status = 'RUNNING' AND leaseToken = @leaseToken`,
                { jobId, runnerId: this.runnerId, leaseToken }
            );
            return out.changes > 0;
        } catch {
            return false;
        }
    }

    async _ownsLease(jobId, leaseToken) {
        if (!leaseToken) return false;
        const row = await db.get(
            `SELECT leaseToken, status, cancelRequested FROM observatory_jobs WHERE id = @jobId`,
            { jobId }
        );
        return !!(row && row.status === 'RUNNING' && row.leaseToken === leaseToken);
    }

    /** Spawn (never await) the segment loop for one RUNNING job row. */
    _startJobLoop(jobId, { client = null, leaseToken } = {}) {
        if (!leaseToken) {
            throw new Error(`observatory job #${jobId} cannot start without a lease token`);
        }
        const controller = new AbortController();
        const heartbeat = setInterval(() => {
            this._touchLease(jobId, leaseToken).then((ok) => {
                if (!ok) controller.abort();
            });
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
        const cancelPoll = setInterval(() => {
            this._ownsLease(jobId, leaseToken).then(async (owned) => {
                if (!owned) {
                    controller.abort();
                    return;
                }
                const row = await db.get(
                    'SELECT cancelRequested FROM observatory_jobs WHERE id = @jobId',
                    { jobId }
                );
                if (Number(row?.cancelRequested) === 1) controller.abort();
            }).catch(() => { /* poll is best-effort */ });
        }, 1000);
        cancelPoll.unref?.();
        this._jobs.set(jobId, { controller, heartbeat, cancelPoll, leaseToken });
        this._touchLease(jobId, leaseToken);
        this._jobLoop(jobId, controller, client, leaseToken)
            .catch(error => logger.error?.(`[observatory] Job #${jobId} loop crashed: ${error.message}`))
            .finally(() => {
                clearInterval(heartbeat);
                clearInterval(cancelPoll);
                this._jobs.delete(jobId);
            });
    }

    /** Abortable sleep for the busy-sandbox backoff. */
    _sleep(ms, signal) {
        return new Promise(resolve => {
            const timer = setTimeout(done, ms);
            timer.unref?.();
            function done() {
                signal?.removeEventListener?.('abort', done);
                clearTimeout(timer);
                resolve();
            }
            signal?.addEventListener?.('abort', done, { once: true });
        });
    }

    /**
     * One sandbox segment for a job, deferring (not failing) while the
     * sandbox is at its concurrency cap. Only the job's FIRST segment
     * counts against the user's sandbox rate limit - resumes are
     * service-initiated and bounded by maxResumes instead.
     */
    async _runSegment(job, projectDir, signal) {
        for (let attempt = 0; ; attempt++) {
            if (signal.aborted) return { aborted: true, ok: false, timedOut: false, files: [], stdout: '', stderr: '', exitCode: null };
            try {
                return await this.sandbox.run({
                    language: job.language,
                    code: job.code,
                    userId: job.segments === 0 ? job.userId : null,
                    projectDir,
                    runDir: this._runDir(projectDir, job.id),
                    signal
                });
            } catch (error) {
                if (error?.code === 'BUSY' && attempt < MAX_BUSY_RETRIES) {
                    await this._sleep(BUSY_RETRY_MS, signal);
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * Mark a job terminal. Requires the attempt's lease token so a
     * recovered stalled worker cannot finish a job another process stole.
     */
    async _finishJob(jobId, status, { exitCode = null, error = null } = {}, leaseToken = null, { silent = false } = {}) {
        if (!leaseToken) return false;
        const finished = (await db.run(
            `UPDATE observatory_jobs
             SET status = @status, exitCode = @exitCode, error = @error,
                 finishedAt = datetime('now'), lastHeartbeatAt = datetime('now')
             WHERE id = @jobId AND status = 'RUNNING' AND leaseToken = @leaseToken`,
            { jobId, status, exitCode, error, leaseToken }
        )).changes > 0;
        if (finished && !silent) await this._publishJobEvent(jobId, status);
        return finished;
    }

    /**
     * Announce a job state change on the domain event bus. This is what lets
     * a watch ("when this run finishes, inspect the result") react to the
     * outcome instead of a timer, and what lets the attention system bring a
     * sweep forward. Fire-and-forget: the bus must never break the job.
     */
    async _publishJobEvent(jobId, status) {
        try {
            const domainEventBus = require('./domainEventBus');
            const TOPICS = domainEventBus.TOPICS;
            const topic = status === 'COMPLETED' ? TOPICS.OBSERVATORY_JOB_COMPLETED
                : status === 'RUNNING' ? TOPICS.OBSERVATORY_JOB_STARTED
                    : status === 'INTERRUPTED' ? TOPICS.OBSERVATORY_JOB_INTERRUPTED
                        : TOPICS.OBSERVATORY_JOB_FAILED;
            const row = await db.get(
                `SELECT j.userId, j.projectId, p.slug FROM observatory_jobs j
                 JOIN observatory_projects p ON p.id = j.projectId
                 WHERE j.id = @jobId`,
                { jobId }
            );
            if (!row) return;
            domainEventBus.publish(topic, {
                userId: row.userId,
                jobId,
                projectId: row.projectId,
                project: row.slug,
                status
            });
            try {
                await require('./projectMissionService').onJobSettled({ jobId, status });
            } catch (error) {
                logger.warn?.(`[observatory] Mission hook for job #${jobId} failed: ${error.message}`);
            }
            require('./eventBusService').publishProjectChange({
                userId: row.userId,
                slug: row.slug,
                reason: 'job',
                projectId: row.projectId
            });
        } catch (error) {
            logger.warn?.(`[observatory] Job event for #${jobId} not published: ${error.message}`);
        }
    }

    /**
     * The job engine: run segments until the snippet exits, fails, is
     * cancelled, or exhausts its checkpoint-resume budget. Each segment is
     * one fully-legalized sandbox run.
     */
    async _jobLoop(jobId, controller, client, leaseToken) {
        const tail = (text) => {
            const s = String(text || '');
            return s.length > TAIL_CHARS ? `…${s.slice(-TAIL_CHARS)}` : s;
        };

        for (;;) {
            const job = await db.get('SELECT * FROM observatory_jobs WHERE id = @jobId', { jobId });
            if (!job || job.status !== 'RUNNING' || job.leaseToken !== leaseToken) return;
            if (Number(job.cancelRequested) === 1) {
                await this._finishJob(jobId, 'CANCELLED', {}, leaseToken);
                return;
            }
            const projectRow = await db.get(
                'SELECT userId, slug, name FROM observatory_projects WHERE id = @projectId',
                { projectId: job.projectId }
            );
            if (!projectRow) {
                await this._finishJob(jobId, 'FAILED', { error: 'The project was deleted mid-job.' }, leaseToken);
                return;
            }
            const dir = this._projectDir(projectRow.userId, projectRow.slug);
            this._ensureRunDir(dir, jobId);

            try {
                this._checkQuota(dir);
            } catch (error) {
                await this._finishJob(jobId, 'FAILED', { error: error.message }, leaseToken);
                break;
            }

            const checkpointBefore = this._checkpointMtime(dir, jobId, job);
            let result;
            try {
                result = await this._runSegment(job, dir, controller.signal);
            } catch (error) {
                if (!await this._ownsLease(jobId, leaseToken)) return;
                await this._finishJob(jobId, 'FAILED', { error: error.message }, leaseToken);
                break;
            }

            const checkpointAfter = this._checkpointMtime(dir, jobId, job);
            const applied = (await db.run(
                `UPDATE observatory_jobs
                 SET segments = segments + 1, stdoutTail = @stdoutTail, stderrTail = @stderrTail,
                     checkpointAt = @checkpointAt, lastHeartbeatAt = datetime('now')
                 WHERE id = @jobId AND status = 'RUNNING' AND leaseToken = @leaseToken`,
                {
                    jobId,
                    leaseToken,
                    stdoutTail: tail(result.stdout),
                    stderrTail: tail(result.stderr),
                    checkpointAt: checkpointAfter ? toUtcText(checkpointAfter) : null
                }
            )).changes > 0;
            if (!applied) return;
            await this._touchProject(job.projectId);

            if (controller.signal.aborted || result.aborted) {
                if (!await this._ownsLease(jobId, leaseToken)) return;
                const latest = await db.get(
                    'SELECT cancelRequested FROM observatory_jobs WHERE id = @jobId',
                    { jobId }
                );
                if (Number(latest?.cancelRequested) === 1 || result.aborted || controller.signal.aborted) {
                    await this._finishJob(jobId, 'CANCELLED', { exitCode: result.exitCode }, leaseToken);
                }
                break;
            }
            if (result.ok) {
                await this._finishJob(jobId, 'COMPLETED', { exitCode: 0 }, leaseToken);
                break;
            }
            if (result.timedOut) {
                const progressed = checkpointAfter !== null
                    && (checkpointBefore === null || checkpointAfter > checkpointBefore);
                if (progressed && job.resumeCount < this.config.maxResumes) {
                    const bumped = (await db.run(
                        `UPDATE observatory_jobs SET resumeCount = resumeCount + 1
                         WHERE id = @jobId AND status = 'RUNNING' AND leaseToken = @leaseToken`,
                        { jobId, leaseToken }
                    )).changes > 0;
                    if (!bumped) return;
                    continue; // next segment picks the checkpoint back up
                }
                await this._finishJob(jobId, 'TIMED_OUT', {
                    exitCode: result.exitCode,
                    error: progressed
                        ? `Out of resume budget (${this.config.maxResumes}).`
                        : 'The run hit the time limit without writing a new checkpoint.json, so it cannot be resumed.'
                }, leaseToken);
                break;
            }
            await this._finishJob(jobId, 'FAILED', {
                exitCode: result.exitCode,
                error: `The code exited with code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ''}.`
            }, leaseToken);
            break;
        }

        // Terminal: best-effort frame render, then the dashboard artifact,
        // then the completion follow-up.
        try {
            await this._autoRender(jobId);
        } catch (error) {
            logger.warn?.(`[observatory] Auto-render for job #${jobId} failed: ${error.message}`);
        }
        const owner = await db.get(
            `SELECT p.userId, p.slug FROM observatory_jobs j
             JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.id = @jobId`,
            { jobId }
        );
        if (owner) await this._refreshDashboard(owner.userId, owner.slug);
        try {
            await this._notifyJobFinished(jobId, client);
        } catch (error) {
            logger.warn?.(`[observatory] Notification for job #${jobId} failed: ${error.message}`);
        }
        try {
            const projectTriggerService = require('./projectTriggerService');
            await projectTriggerService.evaluateJobSettled(jobId, { client });
        } catch (error) {
            logger.warn?.(`[observatory] Trigger evaluation for job #${jobId} failed: ${error.message}`);
        }
    }

    /**
     * If the job's project accumulated numbered frames, stitch them into a
     * video automatically so "your galaxy merger" arrives as an mp4, not a
     * pile of PNGs. Best effort - a render failure never fails the job.
     */
    async _autoRender(jobId) {
        const job = await db.get(
            `SELECT j.id, j.status, j.legacyWorkspace, p.userId, p.slug
             FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.id = @jobId`,
            { jobId }
        );
        if (!job || job.status !== 'COMPLETED') return;
        const dir = this._projectDir(job.userId, job.slug);
        if (this._listFrames(dir, job.id, job).length < 2) return;
        if (!commandExists(this.config.ffmpegCommand)) return;
        const render = this._renderSync(dir, null, job.id, job);
        if (render) {
            await db.run(
                'UPDATE observatory_jobs SET renderPath = @renderPath WHERE id = @jobId',
                { jobId, renderPath: render.relPath }
            );
        }
    }

    /** Numbered frames in the job's (or legacy project) frames/ directory. */
    _listFrames(projectDir, jobId = null, job = null) {
        return this._readFrameNames(this._resolveFramesDir(projectDir, jobId, job));
    }

    /**
     * Stitch frames/frame_*.png into renders/render_<n>.mp4 via system
     * ffmpeg (frames are padded to even dimensions for yuv420p). Returns
     * null on failure; throws nothing - callers decide how loud to be.
     */
    _renderSync(dir, fps = null, jobId = null, job = null) {
        const frames = this._listFrames(dir, jobId, job);
        if (frames.length < 2) return null;
        const rate = Math.min(120, Math.max(1, Number(fps) || this.config.renderFps));
        const rendersDir = path.join(dir, RENDERS_DIR);
        fs.mkdirSync(rendersDir, { recursive: true, mode: 0o700 });
        const fileName = `render_${Date.now()}.mp4`;
        const outPath = path.join(rendersDir, fileName);
        const res = spawnSync(this.config.ffmpegCommand, [
            '-y',
            '-framerate', String(rate),
            '-pattern_type', 'glob',
            '-i', path.join(this._resolveFramesDir(dir, jobId, job), 'frame_*.png'),
            '-frames:v', String(this.config.maxRenderFrames),
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-pix_fmt', 'yuv420p',
            outPath
        ], { timeout: RENDER_TIMEOUT_MS, stdio: ['ignore', 'ignore', 'pipe'] });
        if (res.status !== 0 || !fs.existsSync(outPath)) {
            logger.warn?.(`[observatory] ffmpeg render failed: ${String(res.stderr || '').slice(-500)}`);
            try { fs.rmSync(outPath, { force: true }); } catch { /* nothing to clean */ }
            return null;
        }
        return {
            path: outPath,
            relPath: `${RENDERS_DIR}/${fileName}`,
            frames: Math.min(frames.length, this.config.maxRenderFrames),
            fps: rate,
            sizeBytes: fs.statSync(outPath).size
        };
    }

    /**
     * Explicit render (the tool's `render` action): stitch the project's
     * frames now, at an optional framerate.
     * @param {Object} params - { userId, project, fps }
     */
    async render({ userId, project, fps = null, owner = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project, owner);
        const latestJob = await db.get(
            `SELECT id FROM observatory_jobs
             WHERE projectId = @projectId
             ORDER BY id DESC LIMIT 1`,
            { projectId: row.id }
        );
        const jobFrames = latestJob ? this._listFrames(row.dir, latestJob.id) : [];
        const renderJobId = jobFrames.length >= 2 ? latestJob.id : null;
        const frames = renderJobId != null ? jobFrames : this._listFrames(row.dir, null);
        if (frames.length < 2) {
            throw new ObservatoryError(400, 'NO_FRAMES',
                `Rendering needs at least 2 numbered frames in ${RUNS_DIR}/<jobId>/${FRAMES_DIR}/ `
                + `or ${FRAMES_DIR}/ (frame_0001.png, frame_0002.png, ...).`);
        }
        if (!commandExists(this.config.ffmpegCommand)) {
            throw new ObservatoryError(503, 'FFMPEG_MISSING',
                'ffmpeg is not installed on this server, so frames cannot be stitched into a video. '
                + 'The individual frames are still in the project workspace.');
        }
        const render = this._renderSync(row.dir, fps, renderJobId);
        if (!render) {
            throw new ObservatoryError(500, 'RENDER_FAILED',
                'ffmpeg could not stitch the frames (are they valid PNGs of equal size?).');
        }
        await this._touchProject(row.id);
        return { project: row.slug, ...render };
    }

    /**
     * Completion notification, riding the existing follow-up machinery: a
     * followups row due NOW in the user's DM scope, delivered (and phrased)
     * by heartbeatService's minute loop. Without a reachable gateway (no
     * DM channel to target) the job record itself remains the status
     * surface.
     */
    async _notifyJobFinished(jobId, clientOrGateway) {
        const job = await db.get(
            `SELECT j.*, p.name AS projectName, p.slug AS projectSlug
             FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.id = @jobId`,
            { jobId }
        );
        if (!job || job.status === 'RUNNING') return;
        const gateway = toGateway(clientOrGateway);
        if (!gateway) return;
        let channelId = null;
        try {
            channelId = await gateway.resolveDmChannelId(job.userId);
        } catch { /* gateway unreachable - the job record stays the status surface */ }
        if (!channelId) return; // DMs closed - the portal/status action still has the record
        const outcome = {
            COMPLETED: 'finished successfully',
            FAILED: 'failed',
            TIMED_OUT: 'stopped at its time/resume budget',
            CANCELLED: 'was cancelled',
            INTERRUPTED: 'was interrupted by a restart'
        }[job.status] || job.status;
        const note = (`Observatory job #${job.id} in project "${job.projectName}" ${outcome} `
            + `after ${job.segments} segment(s) (${job.resumeCount} checkpoint resume(s)).`
            + `${job.renderPath ? ' A rendered video is waiting in the project workspace.' : ''}`
            + `${job.error ? ` Detail: ${job.error}` : ''}`).slice(0, 500);
        await db.run(
            `INSERT INTO followups (guildId, channelId, userId, note, dueAt)
             VALUES (@scope, @channelId, @userId, @note, datetime('now'))`,
            { scope: dmScopeId(job.userId), channelId, userId: job.userId, note }
        );
    }

    /**
     * One job the user owns, with its project context (the `status` action).
     * @param {Object} params - { userId, jobId }
     */
    async getJob({ userId, jobId }) {
        await this._requireEnabled();
        const job = await db.get(
            `SELECT j.id, j.status, j.language, j.segments, j.resumeCount, j.exitCode,
                    j.stdoutTail, j.stderrTail, j.checkpointAt, j.renderPath, j.error,
                    j.createdAt, j.finishedAt, j.lastHeartbeatAt, j.userId AS actorId,
                    j.leaseToken, j.cancelRequested, j.legacyWorkspace,
                    p.slug AS project, p.name AS projectName, p.userId AS ownerId
             FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.id = @jobId`,
            { jobId: Number(jobId) }
        );
        if (!job) {
            throw new ObservatoryError(404, 'NO_SUCH_JOB', 'No such job.');
        }
        try {
            await this.resolveProjectForActor({
                userId, project: job.project, owner: job.ownerId
            });
        } catch (error) {
            if (error.code === 'NO_SUCH_PROJECT' || error.code === 'BAD_PROJECT') {
                throw new ObservatoryError(404, 'NO_SUCH_JOB', 'No such job.');
            }
            throw error;
        }
        return job;
    }

    /**
     * The user's jobs, newest first (optionally one project's). Output
     * tails are opt-in: the portal and the dashboard want them, the
     * tool's compact `status` listing does not.
     * @param {Object} params - { userId, project, includeTails }
     */
    async listJobs({ userId, project = null, includeTails = false, owner = null }) {
        await this._requireEnabled();
        const projectRow = project ? await this._requireProject(userId, project, owner) : null;
        if (projectRow) {
            return await db.all(
                `SELECT j.id, j.status, j.language, j.segments, j.resumeCount, j.exitCode,
                        j.checkpointAt, j.renderPath, j.error, j.createdAt, j.finishedAt,
                        j.lastHeartbeatAt, j.userId AS actorId, p.slug AS project
                        ${includeTails ? ', j.stdoutTail, j.stderrTail' : ''}
                 FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
                 WHERE j.projectId = @projectId
                 ORDER BY j.id DESC LIMIT 25`,
                { projectId: projectRow.id }
            );
        }
        return await db.all(
            `SELECT j.id, j.status, j.language, j.segments, j.resumeCount, j.exitCode,
                    j.checkpointAt, j.renderPath, j.error, j.createdAt, j.finishedAt,
                    j.lastHeartbeatAt, j.userId AS actorId, p.slug AS project
                    ${includeTails ? ', j.stdoutTail, j.stderrTail' : ''}
             FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.userId = @userId
             ORDER BY j.id DESC LIMIT 25`,
            { userId }
        );
    }

    /**
     * Request cancellation. The RUNNING claim stays until the owning
     * worker stops its sandbox segment and acknowledges, or a stale
     * lease is reaped. A second process cannot release the project
     * while the owner may still be writing.
     * @param {Object} params - { userId, jobId }
     */
    async cancel({ userId, jobId }) {
        await this._requireEnabled();
        const job = await this.getJob({ userId, jobId });
        if (job.status !== 'RUNNING') {
            throw new ObservatoryError(409, 'NOT_RUNNING', `Job #${job.id} is ${job.status}, not running.`);
        }
        await db.run(
            `UPDATE observatory_jobs SET cancelRequested = 1
             WHERE id = @jobId AND status = 'RUNNING'`,
            { jobId: job.id }
        );
        const handle = this._jobs.get(Number(jobId));
        if (handle) {
            handle.controller.abort();
        }
        return { cancelled: true, jobId: job.id };
    }

    /**
     * Resume an INTERRUPTED (bot restart) or TIMED_OUT (budget exhausted)
     * job from its checkpoint: the job re-enters RUNNING and the segment
     * loop starts again. Requires the checkpoint convention - without a
     * checkpoint.json a restart would start from scratch, which is a new
     * run, not a resume.
     * @param {Object} params - { userId, jobId, client } (client or DiscordGateway)
     */
    async resume({ userId, jobId, client = null }) {
        await this._requireEnabled();
        const job = await this.getJob({ userId, jobId });
        if (job.status !== 'INTERRUPTED' && job.status !== 'TIMED_OUT') {
            throw new ObservatoryError(409, 'NOT_RESUMABLE',
                `Job #${job.id} is ${job.status} - only interrupted or timed-out jobs can be resumed.`);
        }
        const projectRow = await this._requireProject(userId, job.project, job.ownerId);
        if (this._checkpointMtime(projectRow.dir, job.id, job) === null) {
            throw new ObservatoryError(409, 'NO_CHECKPOINT',
                `Job #${job.id} left no ${CHECKPOINT_FILE} in runs/${job.id}/ or the project workspace, so there is nothing to resume from.`);
        }
        if (job.status === 'TIMED_OUT' && job.resumeCount >= this.config.maxResumes) {
            throw new ObservatoryError(409, 'RESUME_BUDGET',
                `Job #${job.id} already used all ${this.config.maxResumes} checkpoint resumes.`);
        }
        const active = await db.get(
            `SELECT COUNT(*) AS c FROM observatory_jobs
             WHERE userId = @userId AND status = 'RUNNING'`,
            { userId }
        );
        if ((active?.c || 0) >= this.config.maxActiveJobsPerUser) {
            throw new ObservatoryError(429, 'TOO_MANY_JOBS',
                `At most ${this.config.maxActiveJobsPerUser} background job(s) at once.`);
        }
        await this._assertNoActiveJob(projectRow.id);
        const leaseToken = makeLeaseToken();
        const claimed = (await db.run(
            `UPDATE observatory_jobs
             SET status = 'RUNNING', error = NULL, finishedAt = NULL,
                 lastHeartbeatAt = datetime('now'), startedBy = 'resume',
                 runnerId = @runnerId, leaseToken = @leaseToken, cancelRequested = 0
                 ${job.status === 'TIMED_OUT' ? ', resumeCount = resumeCount + 1' : ''}
             WHERE id = @jobId AND status IN ('INTERRUPTED', 'TIMED_OUT')`,
            { jobId: job.id, runnerId: this.runnerId, leaseToken }
        )).changes > 0;
        if (!claimed) {
            throw new ObservatoryError(409, 'NOT_RESUMABLE',
                `Job #${job.id} could not be claimed (already running or settled).`);
        }
        await this._publishJobEvent(job.id, 'RUNNING');
        this._startJobLoop(job.id, { client, leaseToken });
        return { resumed: true, jobId: job.id, status: 'RUNNING' };
    }

    // --- Members & invitations ------------------------------------------------

    async _inviteById(inviteId) {
        return await db.get(
            `SELECT i.id, i.projectId, i.inviterId, i.inviterName, i.inviteeId,
                    i.inviteeName, i.status, i.createdAt, p.name, p.slug, p.userId AS ownerId
             FROM project_invites i
             JOIN observatory_projects p ON p.id = i.projectId
             WHERE i.id = @inviteId`,
            { inviteId: Number(inviteId) }
        );
    }

    async _collaboratorCount(projectId) {
        return (await db.get(
            'SELECT COUNT(*) AS c FROM project_members WHERE projectId = @projectId',
            { projectId }
        )).c;
    }

    async _notifyProjectHumans({ projectId, kind, exclude = null, include = [], extra = {} }) {
        try {
            const owner = (await db.get(
                'SELECT userId FROM observatory_projects WHERE id = @projectId',
                { projectId }
            ))?.userId;
            const members = await db.all(
                'SELECT userId FROM project_members WHERE projectId = @projectId',
                { projectId }
            );
            const recipients = new Set(
                [owner, ...members.map(row => row.userId), ...include].filter(Boolean).map(String)
            );
            if (exclude) recipients.delete(String(exclude));
            const eventBus = require('./eventBusService');
            for (const uid of recipients) {
                eventBus.publish(kind, { userId: uid, projectId, ...extra });
            }
        } catch { /* events are cosmetic */ }
    }

    /**
     * Roster of one project: owner, accepted members, and (owner only)
     * pending invitations.
     */
    async listMembers({ userId, project, owner = null }) {
        const row = await this.resolveProjectForActor({ userId, project, owner });
        const members = await db.all(
            `SELECT userId, userName, role, invitedBy, joinedAt
             FROM project_members WHERE projectId = @projectId ORDER BY joinedAt ASC, userId ASC`,
            { projectId: row.id }
        );
        const invites = row.role === 'owner'
            ? await db.all(
                `SELECT id, inviteeId, inviteeName, status, createdAt FROM project_invites
                 WHERE projectId = @projectId AND status = 'pending' ORDER BY id`,
                { projectId: row.id }
            )
            : [];
        return {
            ownerId: row.ownerId,
            ownerName: await this._displayName(row.ownerId),
            role: row.role,
            maxMembers: this.config.maxMembersPerProject,
            members,
            invites
        };
    }

    /**
     * The project parlor (§14): get-or-create the project's shared
     * discussion for any member. The parlor side seats the built-in
     * Goobster persona and mirrors the current roster; here we only
     * resolve access and hand over the facts.
     */
    async getProjectParlor({ userId, project, owner = null }) {
        await this._requireEnabled();
        const row = await this.resolveProjectForActor({ userId, project, owner });
        const members = await db.all(
            'SELECT userId, userName FROM project_members WHERE projectId = @id',
            { id: row.id }
        );
        const parlorService = require('./parlorService');
        const conversation = await parlorService.ensureProjectConversation({
            project: { id: row.id, ownerId: row.ownerId, name: row.name },
            members
        });
        return {
            conversation: {
                id: conversation.id,
                title: conversation.title,
                ownerId: conversation.ownerId,
                projectId: conversation.projectId
            },
            role: row.role
        };
    }

    /** Pending project invitations addressed to this user. */
    async listInvites(userId) {
        return await db.all(
            `SELECT i.id, i.projectId, i.inviterId, i.inviterName, i.createdAt,
                    p.slug, p.name, p.userId AS ownerId
             FROM project_invites i
             JOIN observatory_projects p ON p.id = i.projectId
             WHERE i.inviteeId = @userId AND i.status = 'pending'
             ORDER BY i.id DESC`,
            { userId }
        );
    }

    async listInvitable({ gateway = null, client = null, userId, project, owner = null, q = null }) {
        const row = this._assertOwner(
            await this.resolveProjectForActor({ userId, project, owner })
        );
        const exclude = [
            row.ownerId,
            ...(await db.all(
                'SELECT userId FROM project_members WHERE projectId = @projectId',
                { projectId: row.id }
            )).map(m => m.userId),
            ...(await db.all(
                `SELECT inviteeId FROM project_invites
                 WHERE projectId = @projectId AND status = 'pending'`,
                { projectId: row.id }
            )).map(m => m.inviteeId)
        ];
        const friendService = require('./friendService');
        return await friendService.listInvitable({
            gateway: gateway || client, userId: row.ownerId, q, exclude
        });
    }

    /**
     * Owner invites a Discord friend. Creates the pending invite, then
     * (when a gateway is reachable) DMs Accept/Decline buttons. A failed
     * DM is not an error — the invite still appears in the portal list.
     */
    async invite({
        gateway = null, client = null, userId, ownerName = null,
        project, owner = null, inviteeId
    }) {
        const row = this._assertOwner(
            await this.resolveProjectForActor({ userId, project, owner })
        );
        const invitee = String(inviteeId ?? '').trim();
        if (!SNOWFLAKE_PATTERN.test(invitee)) {
            throw new ObservatoryError(400, 'BAD_USER_ID',
                'That does not look like a Discord user id (a 5-20 digit number).');
        }
        if (invitee === row.ownerId) {
            throw new ObservatoryError(400, 'CANNOT_INVITE_SELF',
                'You already own this project.');
        }
        const alreadyMember = await db.get(
            `SELECT 1 AS ok FROM project_members
             WHERE projectId = @projectId AND userId = @invitee`,
            { projectId: row.id, invitee }
        );
        if (alreadyMember) {
            throw new ObservatoryError(409, 'ALREADY_MEMBER',
                'They already joined this project.');
        }
        const alreadyInvited = await db.get(
            `SELECT 1 AS ok FROM project_invites
             WHERE projectId = @projectId AND inviteeId = @invitee AND status = 'pending'`,
            { projectId: row.id, invitee }
        );
        if (alreadyInvited) {
            throw new ObservatoryError(409, 'ALREADY_INVITED',
                'They already have a pending invitation.');
        }
        const pendingCount = (await db.get(
            `SELECT COUNT(*) AS c FROM project_invites
             WHERE projectId = @projectId AND status = 'pending'`,
            { projectId: row.id }
        )).c;
        if (await this._collaboratorCount(row.id) + pendingCount >= this.config.maxMembersPerProject) {
            throw new ObservatoryError(400, 'PROJECT_FULL',
                `At most ${this.config.maxMembersPerProject} collaborators per project `
                + '(counting pending invitations).');
        }

        const resolvedGateway = toGateway(gateway || client);
        let inviteeUser = null;
        if (resolvedGateway) {
            let reachable = true;
            try {
                inviteeUser = await resolvedGateway.getUser(invitee);
            } catch (error) {
                if (!isGatewayUnavailable(error)) throw error;
                reachable = false;
            }
            if (reachable && !inviteeUser) {
                throw new ObservatoryError(404, 'NO_SUCH_USER', 'No Discord user with that id.');
            }
            if (inviteeUser?.bot) {
                throw new ObservatoryError(400, 'CANNOT_INVITE_BOT',
                    'Bots cannot join projects.');
            }
        }

        const inviteeName = inviteeUser
            ? (inviteeUser.globalName || inviteeUser.username)
            : null;
        const invite = await db.get(
            `INSERT INTO project_invites (projectId, inviterId, inviterName, inviteeId, inviteeName)
             VALUES (@projectId, @inviterId, @inviterName, @inviteeId, @inviteeName)
             RETURNING id, projectId, inviterId, inviterName, inviteeId, inviteeName, status, createdAt`,
            {
                projectId: row.id,
                inviterId: row.ownerId,
                inviterName: ownerName || null,
                inviteeId: invitee,
                inviteeName
            }
        );

        let dmSent = false;
        if (inviteeUser) {
            const delivery = await resolvedGateway.sendDm(invitee, this._inviteMessage({
                inviteId: invite.id,
                inviterName: ownerName,
                name: row.name
            }));
            dmSent = delivery.ok === true;
        }
        try {
            require('./eventBusService').publish('project-invite', {
                userId: invitee, projectId: row.id
            });
        } catch { /* cosmetic */ }
        return { invite, dmSent, inviteeName };
    }

    _inviteMessage({ inviteId, inviterName, name }) {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
        let appUrl = null;
        try {
            const publicUrl = require('../../../config.json').webapp?.publicUrl;
            if (typeof publicUrl === 'string' && publicUrl) {
                appUrl = `${publicUrl.replace(/\/+$/, '')}/app/`;
            }
        } catch { /* no config.json (tests) */ }

        const embed = new EmbedBuilder()
            .setColor(0x7c8cff)
            .setTitle('🔭 An invitation to a Project')
            .setDescription(
                `**${inviterName || 'A friend'}** invited you to collaborate on their Observatory project` +
                `${name ? ` **"${name}"**` : ''}.\n\n` +
                'Accept to join; you can browse, edit, and run the project from the web app' +
                `${appUrl ? ` at ${appUrl}` : ''} (Observatory tab).`
            );
        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`accept_projectinvite_${inviteId}`)
                .setLabel('Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`decline_projectinvite_${inviteId}`)
                .setLabel('Decline').setStyle(ButtonStyle.Secondary)
        );
        return { embeds: [embed], components: [buttons] };
    }

    async respondInvite({ userId, userName = null, inviteId, accept }) {
        const invite = await this._inviteById(inviteId);
        if (!invite || invite.inviteeId !== userId) {
            throw new ObservatoryError(404, 'NO_SUCH_INVITE', 'No such invitation.');
        }
        if (invite.status !== 'pending') {
            throw new ObservatoryError(409, 'INVITE_SETTLED',
                'This invitation was already settled.');
        }
        const result = await db.transaction(async (tx) => {
            if (accept) {
                const count = (await tx.get(
                    'SELECT COUNT(*) AS c FROM project_members WHERE projectId = @projectId',
                    { projectId: invite.projectId }
                )).c;
                if (count >= this.config.maxMembersPerProject) {
                    throw new ObservatoryError(400, 'PROJECT_FULL',
                        `This project is full (${this.config.maxMembersPerProject} collaborators).`);
                }
                await tx.run(
                    `INSERT INTO project_members (projectId, userId, userName, invitedBy)
                     VALUES (@projectId, @userId, @userName, @invitedBy) ON CONFLICT DO NOTHING`,
                    {
                        projectId: invite.projectId,
                        userId,
                        userName: userName || null,
                        invitedBy: invite.inviterId
                    }
                );
            }
            const status = accept ? 'accepted' : 'declined';
            await tx.run(
                `UPDATE project_invites SET status = @status, respondedAt = datetime('now')
                 WHERE id = @id`,
                { status, id: invite.id }
            );
            return {
                status,
                projectId: invite.projectId,
                slug: invite.slug,
                name: invite.name,
                ownerId: invite.ownerId
            };
        });
        if (result.status === 'accepted') {
            // Mirror the new member into the project parlor (no-op until
            // the discussion exists). Best-effort: the membership change
            // must never fail on chat plumbing.
            try {
                await require('./parlorService').syncProjectMembership({
                    projectId: invite.projectId,
                    userId,
                    userName: userName || null,
                    present: true
                });
            } catch { /* the parlor catches up on next ensure */ }
        }
        await this._notifyProjectHumans({
            projectId: invite.projectId,
            kind: 'project-members',
            include: [userId],
            extra: { invalidate: ['observatory', 'project-invites'] }
        });
        return result;
    }

    async revokeInvite({ userId, inviteId }) {
        const invite = await this._inviteById(inviteId);
        if (!invite || invite.ownerId !== userId) {
            throw new ObservatoryError(404, 'NO_SUCH_INVITE', 'No such invitation.');
        }
        if (invite.status !== 'pending') {
            throw new ObservatoryError(409, 'INVITE_SETTLED',
                'This invitation was already settled.');
        }
        await db.run(
            `UPDATE project_invites SET status = 'revoked', respondedAt = datetime('now')
             WHERE id = @id`,
            { id: invite.id }
        );
        try {
            require('./eventBusService').publish('project-invite', {
                userId: invite.inviteeId, projectId: invite.projectId
            });
        } catch { /* cosmetic */ }
        return { revoked: true };
    }

    /**
     * Owner removes a member; a member can remove themself (leave).
     */
    async removeMember({ userId, project, owner = null, memberId }) {
        const row = await this.resolveProjectForActor({ userId, project, owner });
        const target = String(memberId ?? '').trim();
        if (row.role !== 'owner' && target !== userId) {
            throw new ObservatoryError(403, 'NOT_OWNER',
                'Only the project owner can remove other people.');
        }
        const removed = (await db.run(
            `DELETE FROM project_members
             WHERE projectId = @projectId AND userId = @target`,
            { projectId: row.id, target }
        )).changes;
        if (removed === 0) {
            throw new ObservatoryError(404, 'NO_SUCH_MEMBER',
                'They are not a member of this project.');
        }
        try {
            await require('./parlorService').syncProjectMembership({
                projectId: row.id,
                userId: target,
                present: false
            });
        } catch { /* the parlor catches up on next ensure */ }
        await this._notifyProjectHumans({
            projectId: row.id,
            kind: 'project-members',
            include: [target],
            extra: { invalidate: ['observatory', 'project-invites'] }
        });
        return { left: target === userId };
    }

    async handleInviteButton(action, inviteId, interaction) {
        const invite = await this._inviteById(inviteId);
        const settle = async (line) => {
            await interaction.update({
                embeds: interaction.message?.embeds || [],
                content: line,
                components: []
            });
        };
        if (!invite) {
            await settle('This invitation is no longer valid (the project may have been deleted).');
            return;
        }
        if (interaction.user.id !== invite.inviteeId) {
            await interaction.reply({
                content: '❌ This invitation is not addressed to you.',
                ephemeral: true
            });
            return;
        }
        try {
            const result = await this.respondInvite({
                userId: interaction.user.id,
                userName: interaction.user.globalName || interaction.user.username || null,
                inviteId: invite.id,
                accept: action === 'accept'
            });
            await settle(result.status === 'accepted'
                ? `🔭 You joined "${invite.name}" — open the web app's Observatory tab to take part.`
                : 'Invitation declined.');
        } catch (error) {
            if (error instanceof ObservatoryError) {
                await settle(`❌ ${error.message}`);
                return;
            }
            throw error;
        }
    }

    // --- Privacy ---------------------------------------------------------------

    /**
     * Erase a user's Observatory footprint. Owner path deletes whole
     * projects (CASCADE members/invites) and returns a notify list so the
     * privacy transaction can DM collaborators after commit. Member path
     * drops memberships, invites addressed to them, and authored jobs.
     * Asset-version repair lives in projectAssetService.forgetUser.
     * @param {string} userId
     */
    async forgetUser(userId) {
        const owned = await db.all(
            'SELECT id, name, slug FROM observatory_projects WHERE userId = @userId',
            { userId }
        );
        const notifyMembers = [];
        for (const project of owned) {
            const members = await db.all(
                'SELECT userId FROM project_members WHERE projectId = @id',
                { id: project.id }
            );
            if (members.length) {
                notifyMembers.push({
                    name: project.name,
                    slug: project.slug,
                    memberIds: members.map(m => m.userId)
                });
            }
            await this._deleteProjectKnowledge({
                id: project.id,
                ownerId: userId,
                userId
            });
        }

        const running = await db.all(
            `SELECT id FROM observatory_jobs
             WHERE status = 'RUNNING' AND (
                 userId = @userId
                 OR projectId IN (SELECT id FROM observatory_projects WHERE userId = @userId)
             )`,
            { userId }
        );
        for (const row of running) {
            this._jobs.get(row.id)?.controller.abort();
        }

        const memberships = (await db.run(
            'DELETE FROM project_members WHERE userId = @userId', { userId }
        )).changes;
        const invites = (await db.run(
            'DELETE FROM project_invites WHERE inviteeId = @userId', { userId }
        )).changes;
        const shareLinks = (await db.run(
            'DELETE FROM observatory_share_links WHERE userId = @userId', { userId }
        )).changes;
        const jobs = (await db.run(
            'DELETE FROM observatory_jobs WHERE userId = @userId', { userId }
        )).changes;
        const projects = (await db.run(
            'DELETE FROM observatory_projects WHERE userId = @userId', { userId }
        )).changes;
        if (USER_ID_PATTERN.test(String(userId || ''))) {
            try {
                fs.rmSync(path.join(PROJECTS_ROOT, String(userId)), { recursive: true, force: true });
            } catch { /* best effort */ }
            try {
                fs.rmSync(path.join(DASHBOARDS_ROOT, String(userId)), { recursive: true, force: true });
            } catch { /* best effort */ }
        }
        return { projects, jobs, shareLinks, memberships, invites, notifyMembers };
    }

    /**
     * Post-erasure audit counts (privacyService.auditUser).
     * @param {string} userId
     */
    async countUserData(userId) {
        const projects = (await db.get(
            'SELECT COUNT(*) AS c FROM observatory_projects WHERE userId = @userId', { userId }
        )).c;
        const jobs = (await db.get(
            'SELECT COUNT(*) AS c FROM observatory_jobs WHERE userId = @userId', { userId }
        )).c;
        const shareLinks = (await db.get(
            'SELECT COUNT(*) AS c FROM observatory_share_links WHERE userId = @userId', { userId }
        )).c;
        const memberships = (await db.get(
            'SELECT COUNT(*) AS c FROM project_members WHERE userId = @userId', { userId }
        )).c;
        const invites = (await db.get(
            'SELECT COUNT(*) AS c FROM project_invites WHERE inviteeId = @userId', { userId }
        )).c;
        let workspaceDirs = 0;
        if (USER_ID_PATTERN.test(String(userId || ''))) {
            for (const root of [PROJECTS_ROOT, DASHBOARDS_ROOT]) {
                try {
                    if (fs.existsSync(path.join(root, String(userId)))) workspaceDirs++;
                } catch { /* unreadable = uncounted */ }
            }
        }
        const projectNodes = (await db.get(
            `SELECT COUNT(*) AS c FROM kg_nodes
             WHERE guildId = @dmScope AND scopeKey LIKE 'PROJECT:%'`,
            { dmScope: dmScopeId(userId) }
        )).c;
        return { projects, jobs, shareLinks, memberships, invites, workspaceDirs, projectNodes };
    }
}

module.exports = new ObservatoryService();
module.exports.ObservatoryService = ObservatoryService;
module.exports.ObservatoryError = ObservatoryError;
module.exports.PROJECTS_ROOT = PROJECTS_ROOT;
module.exports.DASHBOARDS_ROOT = DASHBOARDS_ROOT;
module.exports.WORKSHOP_SLUG = WORKSHOP_SLUG;
module.exports.WORKSHOP_NAME = WORKSHOP_NAME;
module.exports.legalizeWorkspacePath = legalizeWorkspacePath;
module.exports.normalizeWorkspaceRelPath = normalizeWorkspaceRelPath;
module.exports.MANIFEST_MAX_ASSETS = MANIFEST_MAX_ASSETS;
module.exports.MANIFEST_MAX_TRIGGERS = MANIFEST_MAX_TRIGGERS;
module.exports.MANIFEST_MAX_FILES = MANIFEST_MAX_FILES;
module.exports.MANIFEST_MAX_KNOWLEDGE = MANIFEST_MAX_KNOWLEDGE;
