/**
 * Workspace history: a git repository over every project workspace, driven
 * by the HOST process (the bot, or apps/api in standalone mode), never by
 * the sandbox.
 *
 * The asset layer (projectAssetService) is the trusted, DB-backed source of
 * apps, scripts and notes; it stays. This module fills the one hole it
 * leaves: the on-disk workspace - data a run writes, portal uploads,
 * fetched files, scratch/ - had no history at all. A run that overwrote a
 * file lost the old bytes for good.
 *
 * Shape (ADR 0014):
 *   - The git directory is a SIBLING of the workspace,
 *     data/sandbox/projects/<owner>/<slug>.git, never inside it. The
 *     sandbox bind-mounts only the workspace, so a snippet can neither read
 *     nor corrupt history, and history does not count toward the project's
 *     disk quota (it has its own budget, historyMaxMb).
 *   - Every git call runs with a sealed environment: explicit GIT_DIR and
 *     GIT_WORK_TREE, HOME pointed at the git dir, no system or global
 *     config, no hooks, no terminal prompts, no pager. There is no remote,
 *     no credential and no network - cloning and pushing are deliberately
 *     out of scope here.
 *   - Snapshots are taken after the things that change a workspace: a run
 *     or job settles, a portal write or delete, a fetch-data landing, a
 *     moved chat, a restore. "git add -A" + commit; identical trees are a
 *     no-op.
 *   - The author of a snapshot is a project-scoped pseudonym (a hash of
 *     project id + user id), never a Discord id or a name. Names are
 *     resolved at READ time against the current owner and members, so a
 *     collaborator erased by /forget-me shows as "former collaborator" and
 *     nothing in the history has to be rewritten.
 *   - Frames, renders, interpreter caches and files over historyMaxFileMb
 *     are excluded; when the history directory outgrows historyMaxMb it is
 *     squashed to one snapshot, and if even that is over budget snapshots
 *     pause until the workspace shrinks.
 *   - Missing git binary = the feature is off with a warning (the same
 *     posture as ffmpeg for renders). Nothing else about projects changes.
 *
 * Commit messages name files, job ids and outcomes. They never carry code,
 * prompts, replies or output.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');
const logger = require('../utils/logger');
const observatoryConfig = require('../config/observatoryConfig');
const { windowLines } = require('../utils/toolResultWindow');
const { RUNS_DIR, FRAMES_DIR } = require('../utils/projectSetupContract');
const { PROJECTS_ROOT } = require('./dormantDataService');

/** Machine-readable history error (same PanelError contract as the project service). */
class ProjectHistoryError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ProjectHistoryError';
        this.status = status;
        this.code = code;
    }
}

const BRANCH = 'main';
const COMMITTER_NAME = 'goobster';
const AUTHOR_DOMAIN = 'history.goobster.invalid';
const PAUSED_MARKER = 'goobster-paused';
const EXCLUDE_HEADER = '# Managed by Goobster (projectHistoryService). Edits are overwritten.';
/** Workspace paths never snapshotted: derived media, caches, the sandbox's hidden run sources. */
const STATIC_EXCLUDES = Object.freeze([
    '.goobster-run*',
    `${RUNS_DIR}/*/${FRAMES_DIR}/`,
    `${FRAMES_DIR}/`,
    'renders/',
    '__pycache__/',
    '*.pyc',
    'node_modules/',
    '.venv/',
    'venv/',
    '.cache/',
    '.ipynb_checkpoints/'
]);
/** Directory names the size scan skips (the excludes above, by basename). */
const SKIPPED_DIR_NAMES = new Set([FRAMES_DIR, 'renders', '__pycache__', 'node_modules', '.venv', 'venv', '.cache', '.ipynb_checkpoints']);
const GIT_TIMEOUT_MS = 120_000;
const DEFAULT_LOG_LIMIT = 30;
const MAX_LOG_LIMIT = 200;
const MAX_MESSAGE_CHARS = 160;
const REV_PATTERN = /^(HEAD(~\d{1,4})?|[0-9a-f]{4,40})$/i;
/** Unified diffs the tool/portal will render; past this the caller gets a window. */
const MAX_DIFF_BYTES = 16 * 1024 * 1024;

/** Escape one workspace-relative path for a gitignore-syntax exclude line. */
function escapeExcludePath(rel) {
    return '/' + String(rel).replace(/[\\[\]*?#! ]/g, ch => `\\${ch}`);
}

/** One line, bounded, no control characters: the only shape a commit message takes. */
function cleanMessage(message, fallback = 'snapshot') {
    const text = Array.from(String(message ?? ''), ch => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_MESSAGE_CHARS);
    return text || fallback;
}

class ProjectHistoryService {
    /**
     * @param {Object} [deps]
     * @param {Object} [deps.config] observatoryConfig shape
     * @param {Object} [deps.projects] the ObservatoryService that owns the workspaces
     */
    constructor({ config = observatoryConfig, projects = null } = {}) {
        this.config = config;
        this._projects = projects;
        /** gitDir -> promise chain; serializes git against one repository. */
        this._queues = new Map();
        this._probe = null;
        this._warnedMissing = false;
    }

    get projects() {
        // Lazy: projectService requires this module at load time.
        if (!this._projects) this._projects = require('./projectService');
        return this._projects;
    }

    /** String-only workspace path legalization (the project service's helper). */
    _normalizeRel(relativePath) {
        return require('./projectService').normalizeWorkspaceRelPath(relativePath);
    }

    get gitCommand() {
        return this.config.gitCommand || 'git';
    }

    /** True when `git --version` answers (memoized per process). */
    gitAvailable() {
        if (this._probe === null) {
            try {
                const res = spawnSync(this.gitCommand, ['--version'], {
                    stdio: 'ignore', windowsHide: true, timeout: 10_000
                });
                this._probe = res.status === 0;
            } catch {
                this._probe = false;
            }
            if (!this._probe && !this._warnedMissing) {
                this._warnedMissing = true;
                logger.warn?.(`[project-history] "${this.gitCommand}" is not installed - workspace history is off. `
                    + 'Install git to keep snapshots of project workspaces.');
            }
        }
        return this._probe;
    }

    /**
     * Whether snapshots are taken on this installation and, if not, why.
     * @returns {{ enabled: boolean, reason: null | 'DISABLED' | 'GIT_MISSING' }}
     */
    availability() {
        if (this.config.historyEnabled === false) return { enabled: false, reason: 'DISABLED' };
        if (!this.gitAvailable()) return { enabled: false, reason: 'GIT_MISSING' };
        return { enabled: true, reason: null };
    }

    get enabled() {
        return this.availability().enabled;
    }

    /** The sibling git directory for one project (never inside the workspace). */
    historyDir(row) {
        const ownerId = row.ownerId ?? row.userId;
        const dir = row.dir || this.projects._projectDir(ownerId, row.slug);
        return path.join(path.dirname(path.resolve(dir)), `${row.slug}.git`);
    }

    /** Remove a project's history (deleteProject; erasure removes the whole owner dir). */
    forgetProject(row) {
        try {
            fs.rmSync(this.historyDir(row), { recursive: true, force: true });
        } catch { /* best effort */ }
    }

    // --- Plumbing --------------------------------------------------------------

    _env(row, { author = null } = {}) {
        const gitDir = this.historyDir(row);
        const env = {
            PATH: process.env.PATH || process.env.Path || '',
            GIT_DIR: gitDir,
            GIT_WORK_TREE: path.resolve(row.dir),
            HOME: gitDir,
            XDG_CONFIG_HOME: path.join(gitDir, 'xdg'),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: path.join(gitDir, 'no-global-config'),
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_PAGER: 'cat',
            PAGER: 'cat',
            LC_ALL: 'C',
            GIT_COMMITTER_NAME: COMMITTER_NAME,
            GIT_COMMITTER_EMAIL: `${COMMITTER_NAME}@${AUTHOR_DOMAIN}`,
            GIT_AUTHOR_NAME: author || COMMITTER_NAME,
            GIT_AUTHOR_EMAIL: `${author || COMMITTER_NAME}@${AUTHOR_DOMAIN}`
        };
        if (process.platform === 'win32') {
            for (const key of ['SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']) {
                if (process.env[key]) env[key] = process.env[key];
            }
        }
        return env;
    }

    /**
     * Run one git command against the project's repository.
     * @returns {Promise<{ stdout: string|Buffer, stderr: string, status: number }>}
     */
    _git(row, args, { author = null, input = null, binary = false, maxBuffer = 16 * 1024 * 1024, allowFail = false } = {}) {
        return new Promise((resolve, reject) => {
            const child = execFile(this.gitCommand, args, {
                cwd: path.resolve(row.dir),
                env: this._env(row, { author }),
                encoding: binary ? 'buffer' : 'utf8',
                maxBuffer,
                timeout: GIT_TIMEOUT_MS,
                windowsHide: true
            }, (error, stdout, stderr) => {
                const status = error && typeof error.code === 'number' ? error.code : (error ? -1 : 0);
                const err = String(stderr || '').trim();
                if (error && (!allowFail || typeof error.code !== 'number')) {
                    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                        reject(new ProjectHistoryError(413, 'TOO_LARGE', 'That output is too large to show.'));
                        return;
                    }
                    const failure = new Error(`git ${args[0]} failed (${status}): ${err || error.message}`);
                    failure.status = 500;
                    failure.code = 'GIT_FAILED';
                    failure.gitStatus = status;
                    failure.gitStderr = err;
                    reject(failure);
                    return;
                }
                resolve({ stdout, stderr: err, status });
            });
            if (input != null) {
                child.stdin.on('error', () => { /* git closed early */ });
                child.stdin.end(input);
            }
        });
    }

    /** Serialize work on one repository (a run settling while the portal saves a file). */
    _serial(row, fn) {
        const key = this.historyDir(row);
        const prev = this._queues.get(key) || Promise.resolve();
        const next = prev.catch(() => {}).then(fn);
        this._queues.set(key, next);
        next.finally(() => {
            if (this._queues.get(key) === next) this._queues.delete(key);
        }).catch(() => {});
        return next;
    }

    _repoExists(row) {
        try {
            return fs.statSync(path.join(this.historyDir(row), 'HEAD')).isFile();
        } catch {
            return false;
        }
    }

    async _ensureRepo(row) {
        const gitDir = this.historyDir(row);
        if (this._repoExists(row)) return;
        fs.mkdirSync(gitDir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(gitDir, 0o700); } catch { /* not every fs */ }
        await this._git(row, ['init', '-q', `--initial-branch=${BRANCH}`]).catch(async (error) => {
            // git < 2.28 has no --initial-branch; fall back and set HEAD by hand.
            if (!/initial-branch/.test(error.gitStderr || error.message)) throw error;
            await this._git(row, ['init', '-q']);
            await this._git(row, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`]);
        });
        const settings = [
            ['core.bare', 'false'],
            ['core.worktree', path.resolve(row.dir)],
            // A nonexistent hooks path: nothing in the git dir ever executes.
            ['core.hooksPath', path.join(gitDir, 'no-hooks')],
            // A snapshot can never plant a symlink in the workspace on restore.
            ['core.symlinks', 'false'],
            ['core.autocrlf', 'false'],
            ['core.quotepath', 'false'],
            ['core.fsmonitor', 'false'],
            ['gc.autoDetach', 'false'],
            ['commit.gpgsign', 'false'],
            ['diff.renames', 'true']
        ];
        for (const [key, value] of settings) await this._git(row, ['config', key, value]);
    }

    /** Walk the workspace: trackable bytes (for the pause heuristic) and files over the per-file cap. */
    _scanWorkspace(dir) {
        const maxFileBytes = Math.floor(Number(this.config.historyMaxFileMb || 8) * 1024 * 1024);
        const oversized = [];
        let trackableBytes = 0;
        const walk = (current, rel) => {
            let entries;
            try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                if (entry.isSymbolicLink()) continue;
                const childRel = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    if (SKIPPED_DIR_NAMES.has(entry.name) || entry.name === '.git') continue;
                    walk(path.join(current, entry.name), childRel);
                } else if (entry.isFile()) {
                    if (entry.name.startsWith('.goobster-run') || entry.name.endsWith('.pyc')) continue;
                    let size;
                    try { size = fs.statSync(path.join(current, entry.name)).size; } catch { continue; }
                    if (size > maxFileBytes) oversized.push(childRel);
                    else trackableBytes += size;
                }
            }
        };
        walk(dir, '');
        oversized.sort();
        return { trackableBytes, oversized };
    }

    _writeExclude(row, oversized) {
        const infoDir = path.join(this.historyDir(row), 'info');
        fs.mkdirSync(infoDir, { recursive: true });
        const lines = [EXCLUDE_HEADER, ...STATIC_EXCLUDES];
        if (oversized.length) {
            lines.push(`# over ${this.config.historyMaxFileMb || 8} MB (observatory.historyMaxFileMb)`);
            for (const rel of oversized) lines.push(escapeExcludePath(rel));
        }
        fs.writeFileSync(path.join(infoDir, 'exclude'), lines.join('\n') + '\n');
    }

    _dirBytes(dir) {
        let bytes = 0;
        const walk = (current) => {
            let entries;
            try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.isFile()) {
                    try { bytes += fs.statSync(full).size; } catch { /* raced away */ }
                }
            }
        };
        walk(dir);
        return bytes;
    }

    _budgetBytes() {
        return Math.floor(Number(this.config.historyMaxMb || 256) * 1024 * 1024);
    }

    _pausedPath(row) {
        return path.join(this.historyDir(row), PAUSED_MARKER);
    }

    _isPaused(row) {
        try { return fs.existsSync(this._pausedPath(row)); } catch { return false; }
    }

    _setPaused(row, paused) {
        try {
            if (paused) fs.writeFileSync(this._pausedPath(row), `${new Date().toISOString()}\n`);
            else fs.rmSync(this._pausedPath(row), { force: true });
        } catch { /* best effort */ }
    }

    /** Project-scoped pseudonym for a person; the only identity a commit carries. */
    authorToken(projectId, userId) {
        return crypto.createHash('sha256')
            .update(`goobster-project-history:${projectId}:${userId}`)
            .digest('hex')
            .slice(0, 16);
    }

    /**
     * After a commit: pack when over budget, squash to one snapshot when
     * packing is not enough, pause when even one snapshot is over budget.
     * @returns {Promise<{ squashed: boolean, paused: boolean }>}
     */
    async _enforceBudget(row) {
        const gitDir = this.historyDir(row);
        const budget = this._budgetBytes();
        let squashed = false;
        if (this._dirBytes(gitDir) <= budget) return { squashed, paused: false };
        await this._git(row, ['gc', '-q', '--prune=now'], { allowFail: true });
        if (this._dirBytes(gitDir) <= budget) return { squashed, paused: false };
        const tree = (await this._git(row, ['rev-parse', `HEAD^{tree}`])).stdout.trim();
        const message = `history squashed to one snapshot (over the ${this.config.historyMaxMb || 256} MB budget)`;
        const commit = (await this._git(row, ['commit-tree', tree, '-m', message])).stdout.trim();
        await this._git(row, ['update-ref', `refs/heads/${BRANCH}`, commit]);
        await this._git(row, ['reflog', 'expire', '--expire=now', '--all'], { allowFail: true });
        await this._git(row, ['gc', '-q', '--prune=now'], { allowFail: true });
        squashed = true;
        const paused = this._dirBytes(gitDir) > budget;
        this._setPaused(row, paused);
        if (paused) {
            logger.warn?.(`[project-history] ${row.slug}: even one snapshot is over the ${this.config.historyMaxMb || 256} MB `
                + 'history budget; snapshots are paused until the workspace shrinks.');
        }
        return { squashed, paused };
    }

    /** The commit behind every snapshot; callers hold the serial lock. */
    async _commitInner(row, { userId = null, message }) {
        const availability = this.availability();
        if (!availability.enabled) return { committed: false, reason: availability.reason };
        await this._ensureRepo(row);
        const scan = this._scanWorkspace(row.dir);
        this._writeExclude(row, scan.oversized);
        if (this._isPaused(row)) {
            if (scan.trackableBytes > this._budgetBytes()) return { committed: false, reason: 'PAUSED' };
            this._setPaused(row, false);
        }
        await this._git(row, ['add', '-A', '--ignore-errors', '--', '.']);
        const staged = await this._git(row, ['diff', '--cached', '--quiet'], { allowFail: true });
        if (staged.status === 0) return { committed: false, reason: 'NO_CHANGES' };
        const author = userId ? this.authorToken(row.id, userId) : null;
        await this._git(row, ['commit', '-q', '--no-verify', '-m', cleanMessage(message)], { author });
        const hash = (await this._git(row, ['rev-parse', 'HEAD'])).stdout.trim();
        const budget = await this._enforceBudget(row);
        return { committed: true, hash, short: hash.slice(0, 7), ...budget };
    }

    // --- Resolution -------------------------------------------------------------

    /** A resolved project row from either a row or { userId, project, owner }. */
    async _resolve({ row = null, userId, project, owner = null }) {
        if (row) return row;
        await this.projects._requireOrganization();
        return this.projects.resolveProjectForActor({ userId, project, owner });
    }

    _requireEnabled() {
        const availability = this.availability();
        if (availability.enabled) return;
        throw new ProjectHistoryError(503, availability.reason === 'GIT_MISSING' ? 'GIT_MISSING' : 'HISTORY_DISABLED',
            availability.reason === 'GIT_MISSING'
                ? 'Workspace history is off on this installation: git is not installed.'
                : 'Workspace history is turned off on this installation.');
    }

    async _resolveRev(row, rev) {
        const text = String(rev ?? 'HEAD').trim();
        if (!REV_PATTERN.test(text)) {
            throw new ProjectHistoryError(400, 'BAD_REV', 'A snapshot is a short hash (e.g. 3f2a1c9) or HEAD.');
        }
        if (!this._repoExists(row)) {
            throw new ProjectHistoryError(404, 'NO_HISTORY', 'This project has no snapshots yet.');
        }
        const res = await this._git(row, ['rev-parse', '--verify', '--quiet', `${text}^{commit}`], { allowFail: true });
        const hash = String(res.stdout || '').trim();
        if (res.status !== 0 || !/^[0-9a-f]{40}$/.test(hash)) {
            throw new ProjectHistoryError(404, 'NOT_FOUND', `No snapshot "${text}" in this project.`);
        }
        return hash;
    }

    async _authorMap(row) {
        const map = new Map();
        const ownerId = row.ownerId ?? row.userId;
        const db = require('../db');
        let ownerName = null;
        try { ownerName = await this.projects._displayName(ownerId); } catch { /* fall back to role */ }
        map.set(this.authorToken(row.id, ownerId), { role: 'owner', name: ownerName || 'owner' });
        let members = [];
        try {
            members = await db.all(
                'SELECT userId, userName FROM project_members WHERE projectId = @id', { id: row.id }
            );
        } catch { /* table may be empty */ }
        for (const member of members) {
            let name = member.userName || null;
            try { name = (await this.projects._displayName(member.userId)) || name; } catch { /* keep snapshot */ }
            map.set(this.authorToken(row.id, member.userId), { role: 'collaborator', name: name || 'collaborator' });
        }
        return map;
    }

    _describeAuthor(token, map) {
        if (!token || token === COMMITTER_NAME) return { role: 'system', name: 'Goobster' };
        return map.get(token) || { role: 'former', name: 'former collaborator' };
    }

    // --- Public API ---------------------------------------------------------------

    /**
     * Snapshot the workspace now. Returns { committed: false, reason } when
     * nothing changed, history is off, or snapshots are paused.
     * @param {Object} params - { row? | userId+project+owner, userId, message }
     */
    async commit({ row = null, userId, project = null, owner = null, message = 'snapshot' }) {
        const resolved = await this._resolve({ row, userId, project, owner });
        return this._serial(resolved, () => this._commitInner(resolved, { userId, message }));
    }

    /** `commit` that never throws (the hook behind runs, writes and fetches). */
    async commitQuietly(row, { userId = null, message = 'snapshot' } = {}) {
        try {
            return await this.commit({ row, userId, message });
        } catch (error) {
            logger.warn?.(`[project-history] snapshot of ${row?.slug || '?'} failed: ${error.message}`);
            return null;
        }
    }

    /**
     * The snapshot list, newest first; optionally only snapshots touching
     * one path. Always answers, even when history is off (enabled: false).
     */
    async log({ row = null, userId, project = null, owner = null, path: relPath = null, limit = DEFAULT_LOG_LIMIT }) {
        const resolved = await this._resolve({ row, userId, project, owner });
        const availability = this.availability();
        const base = {
            project: resolved.slug,
            enabled: availability.enabled,
            reason: availability.reason,
            paused: false,
            sizeMb: 0,
            budgetMb: Number(this.config.historyMaxMb || 256),
            maxFileMb: Number(this.config.historyMaxFileMb || 8),
            commits: []
        };
        if (!availability.enabled || !this._repoExists(resolved)) return base;
        const cap = Math.max(1, Math.min(MAX_LOG_LIMIT, Number(limit) || DEFAULT_LOG_LIMIT));
        const args = ['log', `--format=%x1e%H%x1f%aI%x1f%an%x1f%s`, '--name-only', '-n', String(cap)];
        if (relPath) args.push('--', this._normalizeRel(relPath));
        const res = await this._git(resolved, args, { allowFail: true });
        base.paused = this._isPaused(resolved);
        base.sizeMb = Number((this._dirBytes(this.historyDir(resolved)) / (1024 * 1024)).toFixed(2));
        if (res.status !== 0) return base; // no commits yet
        const authors = await this._authorMap(resolved);
        const commits = [];
        for (const chunk of String(res.stdout).split('\x1e')) {
            if (!chunk.trim()) continue;
            const lines = chunk.split('\n');
            const [hash, when, authorToken, subject] = lines[0].split('\x1f');
            if (!/^[0-9a-f]{40}$/.test(hash || '')) continue;
            const files = lines.slice(1).map(line => line.trim()).filter(Boolean);
            commits.push({
                hash,
                short: hash.slice(0, 7),
                when: new Date(when).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
                author: this._describeAuthor(authorToken, authors),
                message: subject || '',
                files: files.slice(0, 50),
                fileCount: files.length
            });
        }
        base.commits = commits;
        return base;
    }

    /**
     * A unified diff. No rev: the workspace against the latest snapshot.
     * rev alone: what that snapshot changed. rev + to: between two
     * snapshots (to = "workspace" compares against the current files).
     */
    async diff({ row = null, userId, project = null, owner = null, rev = null, to = null, path: relPath = null, offset = 1, limit }) {
        const resolved = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        if (!this._repoExists(resolved)) {
            throw new ProjectHistoryError(404, 'NO_HISTORY', 'This project has no snapshots yet.');
        }
        const common = ['--no-color', '--no-ext-diff', '--no-textconv'];
        let args;
        let label;
        if (!rev) {
            const head = await this._resolveRev(resolved, 'HEAD');
            args = ['diff', ...common, head];
            label = `workspace vs ${head.slice(0, 7)}`;
        } else if (!to) {
            const hash = await this._resolveRev(resolved, rev);
            args = ['show', '--format=', ...common, hash];
            label = `snapshot ${hash.slice(0, 7)}`;
        } else {
            const from = await this._resolveRev(resolved, rev);
            if (String(to).trim().toLowerCase() === 'workspace') {
                args = ['diff', ...common, from];
                label = `${from.slice(0, 7)} vs workspace`;
            } else {
                const until = await this._resolveRev(resolved, to);
                args = ['diff', ...common, from, until];
                label = `${from.slice(0, 7)} vs ${until.slice(0, 7)}`;
            }
        }
        let rel = '';
        if (relPath) {
            rel = this._normalizeRel(relPath);
            args.push('--', rel);
        }
        const res = await this._serial(resolved, () => this._git(resolved, args, { maxBuffer: MAX_DIFF_BYTES }));
        const text = String(res.stdout || '');
        const window = windowLines(text, { offset, limit });
        return { project: resolved.slug, label, path: rel || null, size: text.length, empty: text.trim() === '', ...window };
    }

    /** The bytes of one file as it was in a snapshot (the tree entry must be a regular file). */
    async show({ row = null, userId, project = null, owner = null, rev, path: relPath }) {
        const resolved = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const rel = this._normalizeRel(relPath);
        const hash = await this._resolveRev(resolved, rev);
        const entry = await this._git(resolved, ['ls-tree', '-z', hash, '--', rel], { allowFail: true });
        const record = String(entry.stdout || '').split('\0').find(Boolean);
        if (entry.status !== 0 || !record) {
            throw new ProjectHistoryError(404, 'NOT_FOUND', `No "${rel}" in snapshot ${hash.slice(0, 7)}.`);
        }
        const [meta] = record.split('\t');
        const [mode, type] = meta.split(' ');
        if (type === 'tree') throw new ProjectHistoryError(400, 'NOT_A_FILE', 'That path is a directory.');
        if (type !== 'blob' || mode === '120000') {
            throw new ProjectHistoryError(400, 'BAD_PATH', 'That entry is not a regular file.');
        }
        const maxMb = Number(this.config.maxWorkspaceReadMb) > 0 ? Number(this.config.maxWorkspaceReadMb) : 8;
        let bytes;
        try {
            bytes = (await this._git(resolved, ['cat-file', 'blob', `${hash}:${rel}`], {
                binary: true, maxBuffer: Math.floor(maxMb * 1024 * 1024) + 1
            })).stdout;
        } catch (error) {
            if (error.code === 'TOO_LARGE') {
                throw new ProjectHistoryError(413, 'FILE_TOO_LARGE', `That file is larger than the ${maxMb} MB read cap.`);
            }
            throw error;
        }
        return {
            project: resolved.slug,
            rev: hash,
            short: hash.slice(0, 7),
            relativePath: rel,
            name: path.basename(rel),
            bytes,
            size: bytes.length
        };
    }

    /** A line window of a text file at a snapshot (the tool's `read` with rev). */
    async showText({ offset = 1, limit, ...params }) {
        const file = await this.show(params);
        if (file.bytes.includes(0)) {
            throw new ProjectHistoryError(415, 'BINARY_FILE', 'That file is binary; use the portal to download it.');
        }
        const window = windowLines(file.bytes.toString('utf8'), { offset, limit });
        const { bytes: _bytes, ...rest } = file;
        return { ...rest, ...window };
    }

    /**
     * Put one path (or the whole workspace) back as it was in a snapshot.
     * The current state is snapshotted first, so a restore is itself
     * reversible; the result is recorded as a new snapshot. A whole-workspace
     * restore removes files the snapshot does not have; a path restore
     * only writes the files under that path.
     */
    async restore({ row = null, userId, project = null, owner = null, rev, path: relPath = null }) {
        const resolved = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const hash = await this._resolveRev(resolved, rev);
        let rel = '';
        if (relPath != null && String(relPath).trim() !== '' && String(relPath).trim() !== '.') {
            rel = this.projects.legalizeWorkspacePath(resolved.dir, relPath).relativePath;
            const entry = await this._git(resolved, ['ls-tree', '-z', hash, '--', rel], { allowFail: true });
            if (entry.status !== 0 || !String(entry.stdout || '').split('\0').some(Boolean)) {
                throw new ProjectHistoryError(404, 'NOT_FOUND', `No "${rel}" in snapshot ${hash.slice(0, 7)}.`);
            }
        }
        return this._serial(resolved, async () => {
            const before = await this._commitInner(resolved, { userId, message: `before restoring ${rel || 'the workspace'}` });
            const safe = before.hash || (await this._git(resolved, ['rev-parse', 'HEAD'])).stdout.trim();
            const revert = async () => {
                await this._git(resolved, ['read-tree', '--reset', '-u', safe]).catch(() => {});
            };
            try {
                if (rel) {
                    await this._git(resolved, ['checkout', '-q', hash, '--', rel]);
                } else {
                    await this._git(resolved, ['read-tree', '--reset', '-u', hash]);
                }
            } catch (error) {
                await revert();
                throw error;
            }
            const usedMb = this.projects.workspaceSizeMb(resolved);
            if (usedMb > this.config.maxProjectMb) {
                await revert();
                throw new ProjectHistoryError(413, 'QUOTA_EXCEEDED',
                    `Restoring that would put the workspace over its ${this.config.maxProjectMb} MB quota `
                    + `(${usedMb.toFixed(1)} MB).`);
            }
            const after = await this._commitInner(resolved, {
                userId, message: `restored ${rel || 'the workspace'} from ${hash.slice(0, 7)}`
            });
            try {
                require('./eventBusService').publishProjectChange({
                    userId, slug: resolved.slug, reason: 'workspace', projectId: resolved.id
                });
            } catch { /* bus is optional */ }
            try { await this.projects._touchProject(resolved.id); } catch { /* best effort */ }
            return {
                project: resolved.slug,
                restored: rel || '',
                rev: hash,
                short: hash.slice(0, 7),
                before: before.hash || safe,
                commit: after.hash || null,
                changed: after.committed
            };
        });
    }
}

module.exports = new ProjectHistoryService();
module.exports.ProjectHistoryService = ProjectHistoryService;
module.exports.ProjectHistoryError = ProjectHistoryError;
module.exports.STATIC_EXCLUDES = STATIC_EXCLUDES;
module.exports.cleanMessage = cleanMessage;
module.exports.PROJECTS_ROOT = PROJECTS_ROOT;
