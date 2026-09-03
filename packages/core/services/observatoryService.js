/**
 * The Observatory: persistent, long-running simulation projects layered ON
 * TOP of the code sandbox. It turns `runCode` from a scratchpad into a lab
 * bench - named per-user projects with durable workspaces, checkpointed
 * background jobs that survive the sandbox's timeout wall, an automatic
 * frame->video render pipeline, and completion notifications that ride the
 * existing follow-up machinery.
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
 * $GOOBSTER_PROJECT_DIR/checkpoint.json when present and rewrites it as it
 * progresses.
 *
 * Durable state (projects registry, job records) lives in SQLite per the
 * house rule; live job handles (AbortControllers) are transient in-memory
 * state, and jobs found RUNNING with no live handle after a process restart
 * are reaped to INTERRUPTED - resumable from their checkpoint.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const db = require('../db');
const { toGateway } = require('../gateway');
const logger = require('../utils/logger');
const observatoryConfig = require('../config/observatoryConfig');
const sandboxService = require('./sandboxService');
const { buildDashboard } = require('./observatoryDashboard');
const { dmScopeId } = require('../utils/dmScope');

const PROJECTS_ROOT = path.join(require('../runtimePaths').dataDir, 'sandbox', 'projects');
/**
 * Dashboards live OUTSIDE the workspace on purpose: the workspace is
 * bind-mounted writable into snippet runs, and a served dashboard is
 * trusted HTML - a snippet must never be able to author it.
 */
const DASHBOARDS_ROOT = path.join(require('../runtimePaths').dataDir, 'sandbox', 'dashboards');
/** The checkpoint/resume convention: this file, in the workspace root. */
const CHECKPOINT_FILE = 'checkpoint.json';
/** The render convention: numbered frames in this workspace subdirectory. */
const FRAMES_DIR = 'frames';
const RENDERS_DIR = 'renders';
const FRAME_PATTERN = /^frame_\d+\.png$/;
/** Persisted stream tails per segment (forensics, not archival). */
const TAIL_CHARS = 2000;
/** A busy sandbox defers a job segment instead of failing the job. */
const BUSY_RETRY_MS = 10_000;
const MAX_BUSY_RETRIES = 60;
/** Render invocations are bounded like everything else. */
const RENDER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_NAME_LENGTH = 60;
const SLUG_MAX_LENGTH = 48;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Default inbox project for migrated Workshop pins (Phase 2). */
const WORKSHOP_SLUG = 'workshop';
const WORKSHOP_NAME = 'Workshop';
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
const MAX_RELATIVE_PATH_LENGTH = 1024;
/** Inline-media caps keep the self-contained dashboard a sane size. */
const MAX_INLINE_IMAGES = 12;
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_CHARS = 4000;
const SHARE_TOKEN_PATTERN = /^[a-f0-9]{32,64}$/;

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
        this._reaped = false;
    }

    /** The Observatory needs both its own switch AND the sandbox it rides on. */
    get enabled() {
        return this.config.enabled === true && this.sandbox.enabled === true;
    }

    // --- Lifecycle -----------------------------------------------------------

    /**
     * Reap orphans once per process: a job row still RUNNING with no live
     * in-process handle means the bot restarted (or crashed) mid-job. Such
     * jobs become INTERRUPTED - resumable from their checkpoint.
     */
    async _ensureReaped() {
        if (this._reaped) return;
        this._reaped = true;
        try {
            const rows = await db.all(`SELECT id FROM observatory_jobs WHERE status = 'RUNNING'`);
            for (const row of rows) {
                if (this._jobs.has(row.id)) continue;
                const reaped = (await db.run(
                    `UPDATE observatory_jobs
                     SET status = 'INTERRUPTED', error = 'The bot restarted mid-job.',
                         finishedAt = datetime('now')
                     WHERE id = @id AND status = 'RUNNING'`,
                    { id: row.id }
                )).changes > 0;
                if (reaped) await this._publishJobEvent(row.id, 'INTERRUPTED');
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
            `SELECT j.id, j.userId, p.userId AS ownerId, p.slug
             FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.status = 'INTERRUPTED'
             ORDER BY j.id ASC`
        );
        const resumed = [];
        for (const row of rows) {
            try {
                const dir = this._projectDir(row.ownerId, row.slug);
                if (this._checkpointMtime(dir) === null) continue;
                const active = await db.get(
                    `SELECT COUNT(*) AS c FROM observatory_jobs
                     WHERE userId = @userId AND status = 'RUNNING'`,
                    { userId: row.userId }
                );
                if ((active?.c || 0) >= this.config.maxActiveJobsPerUser) continue;
                const claimed = (await db.run(
                    `UPDATE observatory_jobs
                     SET status = 'RUNNING', error = NULL, finishedAt = NULL,
                         lastHeartbeatAt = datetime('now')
                     WHERE id = @id AND status = 'INTERRUPTED'`,
                    { id: row.id }
                )).changes > 0;
                if (!claimed) continue;
                await this._publishJobEvent(row.id, 'RUNNING');
                this._startJobLoop(row.id, { client });
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
             RETURNING slug, name, createdAt`,
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
     * The user's projects, most recently touched first, with size and job
     * counts (the tool's `list` action and the portal pane).
     * @param {string} userId
     */
    async listProjects(userId) {
        await this._requireEnabled();
        const rows = await db.all(
            `SELECT p.id, p.slug, p.name, p.createdAt, p.updatedAt,
                    (SELECT COUNT(*) FROM observatory_jobs j
                     WHERE j.projectId = p.id AND j.status = 'RUNNING') AS runningJobs,
                    (SELECT COUNT(*) FROM observatory_jobs j WHERE j.projectId = p.id) AS totalJobs,
                    EXISTS (SELECT 1 FROM observatory_share_links s WHERE s.projectId = p.id) AS shared
             FROM observatory_projects p
             WHERE p.userId = @userId
             ORDER BY p.updatedAt DESC, p.id DESC`,
            { userId }
        );
        return rows.map(row => ({
            slug: row.slug,
            name: row.name,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            runningJobs: row.runningJobs,
            totalJobs: row.totalJobs,
            shared: Boolean(row.shared),
            sizeMb: Number(this._dirSizeMb(this._projectDir(userId, row.slug)).toFixed(2)),
            quotaMb: this.config.maxProjectMb
        }));
    }

    /**
     * Public project resolution for sibling services (e.g. the sandbox
     * data-fetch flow): same ownership check and 404 as every tool action.
     * @returns {{ id:number, slug:string, name:string, dir:string }}
     */
    async resolveProject({ userId, project }) {
        await this._requireEnabled();
        return await this._requireProject(userId, project);
    }

    /** Current workspace size in MB for a resolved project (quota math). */
    workspaceSizeMb(row) {
        return this._dirSizeMb(row.dir);
    }

    /** Resolve a project the user owns by slug (or exact name), or 404. */
    async _requireProject(userId, projectRef) {
        const ref = String(projectRef ?? '').trim();
        if (!ref) {
            throw new ObservatoryError(400, 'BAD_PROJECT', 'Which project? Give its name or slug.');
        }
        const row = await db.get(
            `SELECT id, slug, name FROM observatory_projects
             WHERE userId = @userId AND (slug = @slugRef OR name = @ref COLLATE NOCASE)`,
            { userId, ref, slugRef: ref.toLowerCase() }
        );
        if (!row) {
            throw new ObservatoryError(404, 'NO_SUCH_PROJECT',
                `No project called "${ref}" - create it first (or check \`list\`).`);
        }
        return { ...row, dir: this._projectDir(userId, row.slug) };
    }

    /**
     * Delete a project: its jobs (cascade), its registry row, and its whole
     * workspace directory. Refused while a job is running - cancel first.
     * @param {Object} params - { userId, project }
     */
    async deleteProject({ userId, project }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
        const running = await db.get(
            `SELECT COUNT(*) AS c FROM observatory_jobs
             WHERE projectId = @projectId AND status = 'RUNNING'`,
            { projectId: row.id }
        );
        if ((running?.c || 0) > 0) {
            throw new ObservatoryError(409, 'JOB_ACTIVE',
                'A background job is still running in this project - cancel it first.');
        }
        // Share links cascade with the project row; the dashboard file and
        // workspace tree are removed by hand.
        await db.run('DELETE FROM observatory_projects WHERE id = @id', { id: row.id });
        try { fs.rmSync(row.dir, { recursive: true, force: true }); } catch { /* best effort */ }
        try { fs.rmSync(this._dashboardPath(userId, row.slug), { force: true }); } catch { /* best effort */ }
        return { deleted: true, slug: row.slug };
    }

    /**
     * Workspace file listing (bounded, newest first). Directories are
     * walked; paths come back workspace-relative with '/' separators.
     * @param {Object} params - { userId, project }
     */
    async listFiles({ userId, project }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
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
                const relPath = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) walk(full, relPath);
                else if (entry.isFile()) {
                    let stat;
                    try { stat = fs.statSync(full); } catch { continue; }
                    const ext = path.extname(entry.name).toLowerCase();
                    files.push({
                        path: relPath,
                        size: stat.size,
                        mtime: stat.mtimeMs,
                        isImage: IMAGE_EXTENSIONS.has(ext),
                        isVideo: VIDEO_EXTENSIONS.has(ext)
                    });
                }
            }
        };
        walk(row.dir, '');
        files.sort((a, b) => b.mtime - a.mtime);
        return {
            project: row.slug,
            sizeMb: Number(this._dirSizeMb(row.dir).toFixed(2)),
            quotaMb: this.config.maxProjectMb,
            totalFiles: files.length,
            files: files.slice(0, this.config.maxWorkspaceFiles)
                .map(({ mtime, ...rest }) => ({ ...rest, modifiedAt: toUtcText(mtime) }))
        };
    }

    /**
     * Resolve one workspace-relative path to an absolute file inside the
     * project (containment-checked - the portal's file/video serving).
     * @param {Object} params - { userId, project, relPath }
     * @returns {{ path: string, name: string }}
     */
    async resolveFile({ userId, project, relPath }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
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
     * Legalize a workspace-relative path for the owner-only reader.
     * Absolute paths, NUL, empty segments, `.`, and `..` are refused
     * before any filesystem work — containment is not enough; the
     * applet-facing API never accepts traversal syntax.
     * @param {string} relativePath
     * @returns {string} posix-style relative path
     */
    _normalizeWorkspaceReadPath(relativePath) {
        const raw = String(relativePath ?? '').trim();
        if (!raw) {
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
     * Read one workspace file the user owns. Used by the applet capability
     * bridge — never expose $GOOBSTER_PROJECT_DIR or any absolute path.
     *
     * Confirms project ownership, rejects traversal / escaping symlinks /
     * directories / oversized files / unsupported types, and returns the
     * bytes plus a MIME type.
     *
     * @param {Object} params - { userId, slug, relativePath }
     * @returns {{ relativePath: string, name: string, mime: string, bytes: Buffer, size: number }}
     */
    async readWorkspaceFile({ userId, slug, relativePath }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, slug);
        const rel = this._normalizeWorkspaceReadPath(relativePath);
        const resolved = path.resolve(row.dir, rel);
        if (resolved !== row.dir && !resolved.startsWith(row.dir + path.sep)) {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }

        let lstat;
        try { lstat = fs.lstatSync(resolved); } catch {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }
        if (lstat.isDirectory()) {
            throw new ObservatoryError(400, 'NOT_A_FILE', 'That path is a directory.');
        }

        let realWorkspace;
        let realFile;
        try {
            realWorkspace = fs.realpathSync(row.dir);
            realFile = fs.realpathSync(resolved);
        } catch {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }
        if (realFile !== realWorkspace && !realFile.startsWith(realWorkspace + path.sep)) {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }

        let stat;
        try { stat = fs.statSync(realFile); } catch {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }
        if (!stat.isFile()) {
            throw new ObservatoryError(404, 'NOT_FOUND', 'No such file.');
        }

        const ext = path.extname(realFile).toLowerCase();
        const mime = WORKSPACE_READ_MIME[ext];
        if (!mime) {
            throw new ObservatoryError(415, 'UNSUPPORTED_TYPE',
                'That file type is not readable through the applet bridge.');
        }

        const maxMb = Number(this.config.maxWorkspaceReadMb) > 0
            ? Number(this.config.maxWorkspaceReadMb)
            : 8;
        const maxBytes = Math.floor(maxMb * 1024 * 1024);
        if (stat.size > maxBytes) {
            throw new ObservatoryError(413, 'FILE_TOO_LARGE',
                `That file is larger than the ${maxMb} MB read cap.`);
        }

        const bytes = fs.readFileSync(realFile);
        return {
            relativePath: rel,
            name: path.basename(rel),
            mime,
            bytes,
            size: bytes.length
        };
    }

    /** The project's checkpoint.json content, capped for display, or null. */
    _readCheckpoint(dir) {
        try {
            const raw = fs.readFileSync(path.join(dir, CHECKPOINT_FILE), 'utf8');
            return raw.length > MAX_CHECKPOINT_CHARS
                ? `${raw.slice(0, MAX_CHECKPOINT_CHARS)}\n… [truncated]`
                : raw;
        } catch {
            return null;
        }
    }

    /**
     * The standardized "one project" object behind the portal's project
     * view: the registry row with live status counts, the project's jobs
     * WITH their output tails, the bounded workspace listing, and the
     * current checkpoint - the same facts the shareable dashboard snapshot
     * renders, but as live data for one canonical client-side view.
     * @param {Object} params - { userId, project }
     */
    async getProjectDetail({ userId, project }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
        const registry = await db.get(
            `SELECT p.slug, p.name, p.createdAt, p.updatedAt,
                    (SELECT COUNT(*) FROM observatory_jobs j WHERE j.projectId = p.id) AS totalJobs,
                    (SELECT COUNT(*) FROM observatory_jobs j
                     WHERE j.projectId = p.id AND j.status = 'RUNNING') AS runningJobs,
                    EXISTS (SELECT 1 FROM observatory_share_links s WHERE s.projectId = p.id) AS shared
             FROM observatory_projects p WHERE p.id = @id`,
            { id: row.id }
        );
        const listing = await this.listFiles({ userId, project: row.slug });
        return {
            project: {
                slug: registry.slug,
                name: registry.name,
                createdAt: registry.createdAt,
                updatedAt: registry.updatedAt,
                shared: Boolean(registry.shared),
                runningJobs: registry.runningJobs,
                totalJobs: registry.totalJobs,
                sizeMb: listing.sizeMb,
                quotaMb: listing.quotaMb
            },
            jobs: await this.listJobs({ userId, project: row.slug, includeTails: true }),
            files: listing.files,
            totalFiles: listing.totalFiles,
            checkpoint: this._readCheckpoint(row.dir)
        };
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
    async generateDashboard({ userId, project }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
        const registry = await db.get(
            `SELECT slug, name, createdAt, updatedAt FROM observatory_projects WHERE id = @id`,
            { id: row.id }
        );
        const listing = await this.listFiles({ userId, project: row.slug });
        const jobs = await this.listJobs({ userId, project: row.slug, includeTails: true });

        const inline = async (relPath, maxBytes) => {
            try {
                const resolved = await this.resolveFile({ userId, project: row.slug, relPath });
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

        const outPath = this._dashboardPath(userId, row.slug);
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
    async _refreshDashboard(userId, slug) {
        try {
            await this.generateDashboard({ userId, project: slug });
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
    async getDashboard({ userId, project, force = false }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
        if (force || await this._dashboardStale(userId, row)) {
            await this.generateDashboard({ userId, project: row.slug });
        }
        const outPath = this._dashboardPath(userId, row.slug);
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
    async createShareLink({ userId, project }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
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
            { userId, projectId: row.id, token }
        );
        return { token: created.token, url: `/app/observatory/share/${created.token}`, createdAt: created.createdAt };
    }

    /**
     * The share state of one project (for the portal's share dialog).
     * @param {Object} params - { userId, project }
     */
    async getShareLink({ userId, project }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
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
    async revokeShareLink({ userId, project }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
        const result = await db.run(
            'DELETE FROM observatory_share_links WHERE projectId = @projectId AND userId = @userId',
            { projectId: row.id, userId }
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

    /** Current mtime of the project's checkpoint file, or null. */
    _checkpointMtime(dir) {
        try {
            return fs.statSync(path.join(dir, CHECKPOINT_FILE)).mtimeMs;
        } catch {
            return null;
        }
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
        assetVersionId = null, startedBy = null, triggerId = null
    }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
        this._checkQuota(row.dir);

        if (!background) {
            const result = await this.sandbox.run({
                language, code, stdin, userId, projectDir: row.dir, signal
            });
            await this._touchProject(row.id);
            // The final step of every project run: refresh the shareable
            // dashboard artifact (best effort, never fails the run).
            await this._refreshDashboard(userId, row.slug);
            return { mode: 'foreground', project: row.slug, result };
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

        const job = await db.get(
            `INSERT INTO observatory_jobs
                (projectId, userId, language, code, lastHeartbeatAt,
                 assetVersionId, startedBy, triggerId)
             VALUES (@projectId, @userId, @language, @code, datetime('now'),
                     @assetVersionId, @startedBy, @triggerId)
             RETURNING id`,
            {
                projectId: row.id,
                userId,
                language: langKey,
                code,
                assetVersionId: assetVersionId == null ? null : Number(assetVersionId),
                startedBy: startedBy || null,
                triggerId: triggerId == null ? null : Number(triggerId)
            }
        );
        await this._touchProject(row.id);
        await this._publishJobEvent(job.id, 'RUNNING');
        this._startJobLoop(job.id, { client });
        return {
            mode: 'background',
            project: row.slug,
            jobId: job.id,
            status: 'RUNNING',
            maxResumes: this.config.maxResumes
        };
    }

    /** Spawn (never await) the segment loop for one RUNNING job row. */
    _startJobLoop(jobId, { client = null } = {}) {
        const controller = new AbortController();
        this._jobs.set(jobId, { controller });
        this._jobLoop(jobId, controller, client)
            .catch(error => logger.error?.(`[observatory] Job #${jobId} loop crashed: ${error.message}`))
            .finally(() => this._jobs.delete(jobId));
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

    /** Mark a job terminal (RUNNING guard makes cancel/finish races safe). */
    async _finishJob(jobId, status, { exitCode = null, error = null } = {}) {
        const finished = (await db.run(
            `UPDATE observatory_jobs
             SET status = @status, exitCode = @exitCode, error = @error,
                 finishedAt = datetime('now'), lastHeartbeatAt = datetime('now')
             WHERE id = @jobId AND status = 'RUNNING'`,
            { jobId, status, exitCode, error }
        )).changes > 0;
        if (finished) await this._publishJobEvent(jobId, status);
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
        } catch (error) {
            logger.warn?.(`[observatory] Job event for #${jobId} not published: ${error.message}`);
        }
    }

    /**
     * The job engine: run segments until the snippet exits, fails, is
     * cancelled, or exhausts its checkpoint-resume budget. Each segment is
     * one fully-legalized sandbox run.
     */
    async _jobLoop(jobId, controller, client) {
        const tail = (text) => {
            const s = String(text || '');
            return s.length > TAIL_CHARS ? `…${s.slice(-TAIL_CHARS)}` : s;
        };

        for (;;) {
            const job = await db.get('SELECT * FROM observatory_jobs WHERE id = @jobId', { jobId });
            if (!job || job.status !== 'RUNNING') return;
            const projectRow = await db.get(
                'SELECT userId, slug, name FROM observatory_projects WHERE id = @projectId',
                { projectId: job.projectId }
            );
            if (!projectRow) {
                await this._finishJob(jobId, 'FAILED', { error: 'The project was deleted mid-job.' });
                return;
            }
            const dir = this._projectDir(projectRow.userId, projectRow.slug);

            try {
                this._checkQuota(dir);
            } catch (error) {
                await this._finishJob(jobId, 'FAILED', { error: error.message });
                break;
            }

            const checkpointBefore = this._checkpointMtime(dir);
            let result;
            try {
                result = await this._runSegment(job, dir, controller.signal);
            } catch (error) {
                await this._finishJob(jobId, 'FAILED', { error: error.message });
                break;
            }

            const checkpointAfter = this._checkpointMtime(dir);
            await db.run(
                `UPDATE observatory_jobs
                 SET segments = segments + 1, stdoutTail = @stdoutTail, stderrTail = @stderrTail,
                     checkpointAt = @checkpointAt, lastHeartbeatAt = datetime('now')
                 WHERE id = @jobId`,
                {
                    jobId,
                    stdoutTail: tail(result.stdout),
                    stderrTail: tail(result.stderr),
                    checkpointAt: checkpointAfter ? toUtcText(checkpointAfter) : null
                }
            );
            await this._touchProject(job.projectId);

            if (controller.signal.aborted || result.aborted) {
                await this._finishJob(jobId, 'CANCELLED', { exitCode: result.exitCode });
                break;
            }
            if (result.ok) {
                await this._finishJob(jobId, 'COMPLETED', { exitCode: 0 });
                break;
            }
            if (result.timedOut) {
                const progressed = checkpointAfter !== null
                    && (checkpointBefore === null || checkpointAfter > checkpointBefore);
                if (progressed && job.resumeCount < this.config.maxResumes) {
                    await db.run(
                        'UPDATE observatory_jobs SET resumeCount = resumeCount + 1 WHERE id = @jobId',
                        { jobId }
                    );
                    continue; // next segment picks the checkpoint back up
                }
                await this._finishJob(jobId, 'TIMED_OUT', {
                    exitCode: result.exitCode,
                    error: progressed
                        ? `Out of resume budget (${this.config.maxResumes}).`
                        : 'The run hit the time limit without writing a new checkpoint.json, so it cannot be resumed.'
                });
                break;
            }
            await this._finishJob(jobId, 'FAILED', {
                exitCode: result.exitCode,
                error: `The code exited with code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ''}.`
            });
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
            `SELECT j.id, j.status, p.userId, p.slug
             FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.id = @jobId`,
            { jobId }
        );
        if (!job || job.status !== 'COMPLETED') return;
        const dir = this._projectDir(job.userId, job.slug);
        if (this._listFrames(dir).length < 2) return;
        if (!commandExists(this.config.ffmpegCommand)) return;
        const render = this._renderSync(dir);
        if (render) {
            await db.run(
                'UPDATE observatory_jobs SET renderPath = @renderPath WHERE id = @jobId',
                { jobId, renderPath: render.relPath }
            );
        }
    }

    /** Numbered frames in the project's frames/ directory, sorted. */
    _listFrames(dir) {
        let entries;
        try {
            entries = fs.readdirSync(path.join(dir, FRAMES_DIR));
        } catch {
            return [];
        }
        return entries.filter(name => FRAME_PATTERN.test(name)).sort();
    }

    /**
     * Stitch frames/frame_*.png into renders/render_<n>.mp4 via system
     * ffmpeg (frames are padded to even dimensions for yuv420p). Returns
     * null on failure; throws nothing - callers decide how loud to be.
     */
    _renderSync(dir, fps = null) {
        const frames = this._listFrames(dir);
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
            '-i', path.join(dir, FRAMES_DIR, 'frame_*.png'),
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
    async render({ userId, project, fps = null }) {
        await this._requireEnabled();
        const row = await this._requireProject(userId, project);
        const frames = this._listFrames(row.dir);
        if (frames.length < 2) {
            throw new ObservatoryError(400, 'NO_FRAMES',
                `Rendering needs at least 2 numbered frames in ${FRAMES_DIR}/ `
                + `(frame_0001.png, frame_0002.png, ...).`);
        }
        if (!commandExists(this.config.ffmpegCommand)) {
            throw new ObservatoryError(503, 'FFMPEG_MISSING',
                'ffmpeg is not installed on this server, so frames cannot be stitched into a video. '
                + 'The individual frames are still in the project workspace.');
        }
        const render = this._renderSync(row.dir, fps);
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
                    j.createdAt, j.finishedAt, j.lastHeartbeatAt,
                    p.slug AS project, p.name AS projectName
             FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.id = @jobId AND j.userId = @userId`,
            { jobId: Number(jobId), userId }
        );
        if (!job) {
            throw new ObservatoryError(404, 'NO_SUCH_JOB', 'No such job.');
        }
        return job;
    }

    /**
     * The user's jobs, newest first (optionally one project's). Output
     * tails are opt-in: the portal and the dashboard want them, the
     * tool's compact `status` listing does not.
     * @param {Object} params - { userId, project, includeTails }
     */
    async listJobs({ userId, project = null, includeTails = false }) {
        await this._requireEnabled();
        const projectRow = project ? await this._requireProject(userId, project) : null;
        return await db.all(
            `SELECT j.id, j.status, j.language, j.segments, j.resumeCount, j.exitCode,
                    j.checkpointAt, j.renderPath, j.error, j.createdAt, j.finishedAt,
                    j.lastHeartbeatAt, p.slug AS project
                    ${includeTails ? ', j.stdoutTail, j.stderrTail' : ''}
             FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
             WHERE j.userId = @userId ${projectRow ? 'AND j.projectId = @projectId' : ''}
             ORDER BY j.id DESC LIMIT 25`,
            projectRow ? { userId, projectId: projectRow.id } : { userId }
        );
    }

    /**
     * Cancel a running job: the live segment is killed and the job settles
     * as CANCELLED (an orphaned RUNNING row without a handle settles here
     * directly).
     * @param {Object} params - { userId, jobId }
     */
    async cancel({ userId, jobId }) {
        await this._requireEnabled();
        const job = await this.getJob({ userId, jobId });
        if (job.status !== 'RUNNING') {
            throw new ObservatoryError(409, 'NOT_RUNNING', `Job #${job.id} is ${job.status}, not running.`);
        }
        const handle = this._jobs.get(Number(jobId));
        if (handle) {
            handle.controller.abort();
        } else {
            await this._finishJob(Number(jobId), 'CANCELLED');
            try {
                const projectTriggerService = require('./projectTriggerService');
                await projectTriggerService.evaluateJobSettled(Number(jobId));
            } catch (error) {
                logger.warn?.(`[observatory] Trigger evaluation for cancelled job #${jobId} failed: ${error.message}`);
            }
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
        const projectRow = await this._requireProject(userId, job.project);
        if (this._checkpointMtime(projectRow.dir) === null) {
            throw new ObservatoryError(409, 'NO_CHECKPOINT',
                `Job #${job.id} left no ${CHECKPOINT_FILE} in the project workspace, so there is nothing to resume from.`);
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
        await db.run(
            `UPDATE observatory_jobs
             SET status = 'RUNNING', error = NULL, finishedAt = NULL,
                 lastHeartbeatAt = datetime('now'), startedBy = 'resume'
                 ${job.status === 'TIMED_OUT' ? ', resumeCount = resumeCount + 1' : ''}
             WHERE id = @jobId`,
            { jobId: job.id }
        );
        await this._publishJobEvent(job.id, 'RUNNING');
        this._startJobLoop(job.id, { client });
        return { resumed: true, jobId: job.id, status: 'RUNNING' };
    }

    // --- Privacy ---------------------------------------------------------------

    /**
     * Erase a user's whole Observatory footprint: job rows, project rows
     * (jobs cascade), and the workspace directory tree on disk. Live jobs
     * are cancelled first. Called from privacyService.forgetUser.
     * @param {string} userId
     * @returns {{ projects: number, jobs: number }}
     */
    async forgetUser(userId) {
        // Kill live jobs before deleting their rows (the loop exits when the
        // row disappears or leaves RUNNING).
        const running = await db.all(
            `SELECT id FROM observatory_jobs WHERE userId = @userId AND status = 'RUNNING'`,
            { userId }
        );
        for (const row of running) {
            this._jobs.get(row.id)?.controller.abort();
        }
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
        return { projects, jobs, shareLinks };
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
        let workspaceDirs = 0;
        if (USER_ID_PATTERN.test(String(userId || ''))) {
            for (const root of [PROJECTS_ROOT, DASHBOARDS_ROOT]) {
                try {
                    if (fs.existsSync(path.join(root, String(userId)))) workspaceDirs++;
                } catch { /* unreadable = uncounted */ }
            }
        }
        return { projects, jobs, shareLinks, workspaceDirs };
    }
}

module.exports = new ObservatoryService();
module.exports.ObservatoryService = ObservatoryService;
module.exports.ObservatoryError = ObservatoryError;
module.exports.PROJECTS_ROOT = PROJECTS_ROOT;
module.exports.DASHBOARDS_ROOT = DASHBOARDS_ROOT;
module.exports.WORKSHOP_SLUG = WORKSHOP_SLUG;
module.exports.WORKSHOP_NAME = WORKSHOP_NAME;
