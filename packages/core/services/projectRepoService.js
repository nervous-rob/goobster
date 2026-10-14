/**
 * Project repositories (ADR 0015): a GitHub repository cloned for a
 * project, pulled, committed and pushed by the HOST process with the acting
 * person's OWN GitHub connection (user_integrations). Phase B of workspace
 * history; the asset layer and the sandbox are untouched.
 *
 * Shape:
 *   - The clone's git directory is a sibling of the workspace,
 *     data/sandbox/projects/<owner>/<slug>.repos/<name>.git. Its work tree is
 *     <workspace>/repos/<name>: plain files to the sandbox (which has no git
 *     and no network) and to workspace history, which snapshots them like
 *     any other file. There is never a `.git` inside the workspace.
 *   - Every remote operation uses the acting person's connected GitHub
 *     token, handed to git through a credential helper that reads it from
 *     the environment of that one call. Never the operator's token, never a
 *     token in a URL, on a command line or on disk. No connection = no
 *     remote operation. The person's own GitHub allowlist
 *     (Settings -> Connections) applies, the same way it does to the
 *     GitHub chat tools.
 *   - Commits made here carry the person's GitHub identity
 *     (<id>+<login>@users.noreply.github.com), because they are theirs to
 *     push. Workspace history keeps its pseudonyms; this is a different
 *     repository with a different audience.
 *   - Pushes are never forced; a rejected push is reported. Destructive
 *     local operations (reset, checkout, remove) take a workspace-history
 *     snapshot first, so they can be undone with `restore`.
 *   - Clones are shallow (repoCloneDepth), capped in number
 *     (maxReposPerProject) and size (repoMaxMb for the git directory; the
 *     work tree counts toward the project quota like any other file).
 *   - Only https://github.com/<owner>/<name> remotes; GIT_ALLOW_PROTOCOL is
 *     pinned so a remote can never be a local path, ssh or a command.
 *
 * - Merge and rebase onto another branch (usually the one the clone started
 *   from) are the person's tools for conflicts: a clean one just happens; a
 *   conflicted one is LEFT in progress (status.operation + status.conflicts)
 *   for the files to be edited like any other workspace file, then `continue`
 *   or `abort`. A rebase is refused once its commits are on origin (it would
 *   need a forced push); merge is the answer there.
 *
 * The project-history `history` / `diff` / `restore` actions cover the
 * files of a clone too; this service's `status` is about the clone's own
 * branch, upstream and uncommitted changes.
 */

const path = require('node:path');
const fs = require('node:fs');
const db = require('../db');
const logger = require('../utils/logger');
const observatoryConfig = require('../config/observatoryConfig');
const { dmScopeId } = require('../utils/dmScope');
const { probeGit, sealedEnv, runGit, SerialQueues, dirBytes } = require('../utils/sealedGit');
const { forModule } = require('../utils/optionalModule');
const requireOptional = forModule(module);

/** Machine-readable repository error (the PanelError contract: status + code). */
class ProjectRepoError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ProjectRepoError';
        this.status = status;
        this.code = code;
    }
}

const REPOS_DIR = 'repos';
const DEFAULT_TRANSPORT_BASE = 'https://github.com/';
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_MAX_LENGTH = 120;
const MAX_MESSAGE_CHARS = 500;
const IDENTITY_TTL_MS = 10 * 60 * 1000;
const STATUS_MAX_PATHS = 20;
const RECENT_COMMITS = 5;
const DEEPEN_COMMITS = 500;
const COMPARE_MAX_FILES = 200;
const COMPARE_MAX_COMMITS = 30;
const COMPARE_PATCH_BYTES = 2 * 1024 * 1024;
const COMPARE_PATCH_CHARS = 200_000;
const PR_LIST_MAX = 10;
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
const DIRTY_PATTERN = /local changes|unstaged changes|uncommitted changes|would be overwritten|commit or stash/i;
/** The credential helper: reads the token from the call's environment, never from argv or disk. */
const CREDENTIAL_HELPER = '!f() { if [ "$1" = get ]; then echo username=x-access-token; echo "password=$GOOBSTER_GIT_TOKEN"; fi; }; f';

/** A git branch name we are willing to pass on (then validated by git itself). */
function cleanBranch(branch) {
    const text = String(branch ?? '').trim();
    if (!text) return null;
    const hasControl = Array.from(text).some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
    if (text.length > BRANCH_MAX_LENGTH || text.startsWith('-') || hasControl || /[\s~^:?*[\\]/.test(text)
        || text.includes('..') || text.includes('@{') || text.endsWith('/') || text.endsWith('.lock')
        || text.startsWith('/') || text.includes('//') || text === 'HEAD') {
        throw new ProjectRepoError(400, 'BAD_BRANCH', `"${text}" is not a usable branch name.`);
    }
    return text;
}

/** A one-paragraph commit message without control characters. */
function cleanMessage(message) {
    const text = String(message ?? '')
        .split('')
        .map(ch => ((ch.charCodeAt(0) < 0x20 && ch !== '\n') || ch.charCodeAt(0) === 0x7f ? ' ' : ch))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_MESSAGE_CHARS);
    if (!text) throw new ProjectRepoError(400, 'EMPTY_MESSAGE', 'A commit needs a message.');
    return text;
}

class ProjectRepoService {
    /**
     * @param {Object} [deps]
     * @param {Object} [deps.config] observatoryConfig shape
     * @param {Object} [deps.projects] the ObservatoryService that owns the workspaces
     * @param {string} [deps.transportBase] remote URL prefix (tests use a file:// base)
     * @param {(userId: string) => Promise<string|null>} [deps.token] the person's GitHub token
     * @param {(userId: string) => Promise<string[]|null>} [deps.allowlist] their personal repo allowlist
     * @param {(token: string) => Promise<{login: string, id: number|string}>} [deps.identity] GET /user
     * @param {(token: string, repo: string) => Promise<{sizeKb?: number, defaultBranch?: string}|null>} [deps.repoInfo]
     * @param {(token: string) => Object} [deps.github] GitHub API bound to a token (listBranches, listPullRequests,
     *   createPullRequest, getChecks); defaults to githubService.withToken
     */
    constructor({
        config = observatoryConfig, projects = null, transportBase = null,
        token = null, allowlist = null, identity = null, repoInfo = null, github = null
    } = {}) {
        this.config = config;
        this._projects = projects;
        this.transportBase = transportBase || DEFAULT_TRANSPORT_BASE;
        this._tokenOf = token;
        this._allowlistOf = allowlist;
        this._identityOf = identity;
        this._repoInfoOf = repoInfo;
        this._githubOf = github;
        this._queues = new SerialQueues();
        this._probe = null;
        /** userId -> { until, identity } */
        this._identities = new Map();
    }

    get projects() {
        if (!this._projects) this._projects = require('./projectService');
        return this._projects;
    }

    get gitCommand() {
        return this.config.gitCommand || 'git';
    }

    get history() {
        return this.projects.history;
    }

    gitAvailable() {
        if (this._probe === null) this._probe = probeGit(this.gitCommand);
        return this._probe;
    }

    _githubService() {
        return requireOptional('./githubService', { feature: 'github' });
    }

    /**
     * Whether repositories work on this installation and, if not, why.
     * @returns {{ enabled: boolean, reason: null | 'DISABLED' | 'GIT_MISSING' | 'GITHUB_OFF' }}
     */
    availability() {
        if (this.config.reposEnabled === false) return { enabled: false, reason: 'DISABLED' };
        if (!this.gitAvailable()) return { enabled: false, reason: 'GIT_MISSING' };
        if (!this._identityOf && !this._githubService()) return { enabled: false, reason: 'GITHUB_OFF' };
        return { enabled: true, reason: null };
    }

    get enabled() {
        return this.availability().enabled;
    }

    _requireEnabled() {
        const availability = this.availability();
        if (availability.enabled) return;
        const messages = {
            DISABLED: 'Project repositories are turned off on this installation.',
            GIT_MISSING: 'Project repositories are off on this installation: git is not installed.',
            GITHUB_OFF: 'Project repositories need the GitHub feature, which is off on this installation.'
        };
        throw new ProjectRepoError(503, availability.reason === 'DISABLED' ? 'REPOS_DISABLED' : availability.reason,
            messages[availability.reason]);
    }

    // --- Paths -------------------------------------------------------------------

    /** The sibling directory holding every clone's git dir for one project. */
    reposDir(row) {
        const ownerId = row.ownerId ?? row.userId;
        const dir = row.dir || this.projects._projectDir(ownerId, row.slug);
        return path.join(path.dirname(path.resolve(dir)), `${row.slug}.repos`);
    }

    gitDirFor(row, name) {
        return path.join(this.reposDir(row), `${name}.git`);
    }

    workTreeFor(row, name) {
        return path.join(path.resolve(row.dir), REPOS_DIR, name);
    }

    /** Remove every clone's git dir (deleteProject; erasure removes the owner tree). */
    forgetProject(row) {
        try {
            fs.rmSync(this.reposDir(row), { recursive: true, force: true });
        } catch { /* best effort */ }
    }

    // --- Plumbing ------------------------------------------------------------------

    _allowProtocol() {
        return this.transportBase.startsWith('file:') ? 'file:https' : 'https';
    }

    _git(row, name, args, { token = null, author = null, authorEmail = null, ...opts } = {}) {
        const extra = token
            ? {
                GIT_CONFIG_COUNT: '2',
                GIT_CONFIG_KEY_0: 'credential.helper',
                GIT_CONFIG_VALUE_0: '',
                GIT_CONFIG_KEY_1: 'credential.helper',
                GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
                GOOBSTER_GIT_TOKEN: token
            }
            : {};
        const workTree = this.workTreeFor(row, name);
        return runGit(this.gitCommand, args, {
            cwd: fs.existsSync(workTree) ? workTree : path.resolve(row.dir),
            env: sealedEnv({
                gitDir: this.gitDirFor(row, name), workTree, author, authorEmail,
                allowProtocol: this._allowProtocol(), extra
            }),
            ...opts
        });
    }

    _serial(row, name, fn) {
        return this._queues.run(this.gitDirFor(row, name), fn);
    }

    /** Map a git failure to the person's problem: access, missing branch, network. */
    _explain(error, { repo = null, branch = null } = {}) {
        if (error?.code !== 'GIT_FAILED') return error;
        const text = String(error.gitStderr || error.message || '');
        if (/Authentication failed|could not read Username|Invalid username or password|403|Permission to .* denied/i.test(text)) {
            return new ProjectRepoError(403, 'NO_ACCESS',
                `Your GitHub account cannot ${repo ? `access ${repo}` : 'do that'}: check the token's repository access and permissions.`);
        }
        if (/Repository not found|not found|does not appear to be a git repository/i.test(text)) {
            return new ProjectRepoError(404, 'NOT_FOUND',
                `${repo || 'That repository'} was not found, or your GitHub account cannot see it.`);
        }
        if (branch && /couldn't find remote ref|Remote branch .* not found|invalid refspec/i.test(text)) {
            return new ProjectRepoError(404, 'NO_SUCH_BRANCH', `No branch "${branch}" on ${repo || 'the remote'}.`);
        }
        if (/Could not resolve host|unable to access|Connection (timed out|refused)|network is unreachable/i.test(text)) {
            return new ProjectRepoError(502, 'NETWORK', 'GitHub could not be reached from this server.');
        }
        return error;
    }

    // --- Resolution --------------------------------------------------------------------

    async _resolve({ row = null, userId, project, owner = null }) {
        if (row) return row;
        await this.projects._requireOrganization();
        return this.projects.resolveProjectForActor({ userId, project, owner });
    }

    _cleanName(name) {
        const text = String(name ?? '').trim().toLowerCase();
        if (!NAME_PATTERN.test(text)) {
            throw new ProjectRepoError(400, 'BAD_NAME',
                'A repository name is 1-48 lowercase letters, digits and dashes (e.g. "goobster").');
        }
        return text;
    }

    /** owner/name from a bare reference or a github.com URL. */
    _cleanRepo(input) {
        let cleaned = String(input || '').trim();
        const urlMatch = cleaned.match(/github\.com[/:]([^/]+\/[^/#?]+)/i);
        if (urlMatch) cleaned = urlMatch[1];
        cleaned = cleaned.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
        if (!REPO_PATTERN.test(cleaned) || cleaned.split('/').some(part => part === '.' || part === '..')) {
            throw new ProjectRepoError(400, 'BAD_REPO', `"${input}" doesn't look like an owner/name GitHub repository.`);
        }
        return cleaned;
    }

    _remoteUrl(repo) {
        return `${this.transportBase}${repo}.git`;
    }

    async _row(projectRow, name) {
        const row = await db.get(
            'SELECT * FROM project_repos WHERE projectId = @projectId AND name = @name',
            { projectId: projectRow.id, name: this._cleanName(name) }
        );
        if (!row) {
            throw new ProjectRepoError(404, 'NO_SUCH_REPO',
                `No repository "${name}" in this project - see repo_list.`);
        }
        return row;
    }

    /** The person's GitHub token, or a clear refusal. */
    async _token(userId) {
        const token = this._tokenOf
            ? await this._tokenOf(userId)
            : await require('./userIntegrationService').getToken(userId, 'github');
        if (!token) {
            throw new ProjectRepoError(403, 'NO_GITHUB',
                'No GitHub account connected. Connect one in the web portal (Settings → Connections) first; '
                + 'repositories are cloned, pulled and pushed with your own account, never the server\'s.');
        }
        return token;
    }

    /** The person's own repo allowlist (Settings → Connections); empty means no extra restriction. */
    async _checkAllowlist(userId, repo) {
        let allow;
        try {
            allow = this._allowlistOf
                ? await this._allowlistOf(userId)
                : await require('./userSettingsService').getPreference(userId, 'githubAllowlist');
        } catch {
            throw new ProjectRepoError(503, 'POLICY_UNAVAILABLE', 'Could not verify your GitHub resource policy. Try again later.');
        }
        if (Array.isArray(allow) && allow.length > 0) {
            const ok = allow.some(item => String(item).toLowerCase() === repo.toLowerCase());
            if (!ok) {
                throw new ProjectRepoError(403, 'REPO_NOT_ALLOWED',
                    `${repo} is not on your personal GitHub allowlist. Add it in Settings → Connections.`);
            }
        }
    }

    /** Commit identity: the person's GitHub login and noreply address (cached briefly). */
    async _identity(userId, token) {
        const cached = this._identities.get(userId);
        if (cached && cached.until > Date.now()) return cached.identity;
        let viewer;
        try {
            viewer = this._identityOf
                ? await this._identityOf(token)
                : await this._githubService().withToken(token).getViewer();
        } catch (error) {
            throw new ProjectRepoError(403, 'NO_GITHUB',
                `Your GitHub connection did not answer (${error.message}). Reconnect it in Settings → Connections.`);
        }
        const login = String(viewer?.login || '').trim();
        if (!login) throw new ProjectRepoError(403, 'NO_GITHUB', 'Your GitHub connection has no account behind it.');
        const identity = {
            name: login,
            email: viewer?.id != null ? `${viewer.id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`
        };
        this._identities.set(userId, { until: Date.now() + IDENTITY_TTL_MS, identity });
        return identity;
    }

    /** GitHub API bound to the person's token, after the personal allowlist. */
    async _api(userId, repoRow) {
        const token = await this._token(userId);
        await this._checkAllowlist(userId, repoRow.repo);
        return { token, api: this._githubOf ? this._githubOf(token) : this._githubService().withToken(token) };
    }

    /** A GitHub API failure as the person's problem. */
    _apiError(error, repo) {
        if (error instanceof ProjectRepoError) return error;
        const messages = {
            NOT_FOUND: [404, 'NOT_FOUND', `${repo} was not found, or your GitHub account cannot see it.`],
            BAD_TOKEN: [403, 'NO_GITHUB', 'GitHub rejected your connection: reconnect it in Settings → Connections.'],
            FORBIDDEN: [403, 'NO_ACCESS', `Your GitHub token cannot do that on ${repo}: check its repository permissions.`],
            TOKEN_REQUIRED: [403, 'NO_GITHUB', 'No GitHub account connected.'],
            RATE_LIMITED: [429, 'RATE_LIMITED', 'GitHub is rate limiting this account: try again in a little while.'],
            UNAVAILABLE: [502, 'NETWORK', 'GitHub could not be reached from this server.'],
            INVALID: [409, 'REJECTED_BY_GITHUB', error?.message || 'GitHub rejected the request.'],
            BAD_INPUT: [400, 'BAD_INPUT', error?.message || 'Bad input.']
        };
        const hit = messages[error?.code];
        return hit ? new ProjectRepoError(hit[0], hit[1], hit[2]) : error;
    }

    async _repoInfo(token, repo) {
        try {
            if (this._repoInfoOf) return await this._repoInfoOf(token, repo);
            const info = await this._githubService().withToken(token).getRepo(repo);
            return { sizeKb: Number(info?.size) || 0, defaultBranch: info?.default_branch || null };
        } catch (error) {
            if (error?.code === 'NOT_FOUND' || /404|not found/i.test(String(error?.message))) {
                throw new ProjectRepoError(404, 'NOT_FOUND', `${repo} was not found, or your GitHub account cannot see it.`);
            }
            return null; // the clone itself decides
        }
    }

    async _serialize(projectRow, row, { withStatus = true } = {}) {
        const out = {
            id: row.id,
            project: projectRow.slug,
            name: row.name,
            repo: row.repo,
            path: `${REPOS_DIR}/${row.name}`,
            url: `https://github.com/${row.repo}`,
            clonedBranch: row.branch,
            createdBy: row.createdBy || null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            lastFetchAt: row.lastFetchAt || null,
            lastPushAt: row.lastPushAt || null
        };
        if (withStatus) out.status = await this._status(projectRow, row.name).catch(error => ({ error: error.message }));
        return out;
    }

    /** 'merge' or 'rebase' while one is stopped on conflicts, else null. */
    _operation(projectRow, name) {
        const gitDir = this.gitDirFor(projectRow, name);
        if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebase';
        if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
        return null;
    }

    _requireIdle(status) {
        if (!status.operation) return;
        throw new ProjectRepoError(409, 'IN_PROGRESS',
            `A ${status.operation} is stopped on conflicts: fix the conflicted files and repo_continue, or repo_abort.`);
    }

    async _status(projectRow, name) {
        const branchRes = await this._git(projectRow, name, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
        const branch = branchRes.status === 0 ? String(branchRes.stdout).trim() : null;
        const upstreamRes = await this._git(projectRow, name, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true });
        const upstream = upstreamRes.status === 0 ? String(upstreamRes.stdout).trim() : null;
        let ahead = 0;
        let behind = 0;
        if (upstream) {
            const counts = await this._git(projectRow, name, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { allowFail: true });
            if (counts.status === 0) {
                const [a, b] = String(counts.stdout).trim().split(/\s+/).map(Number);
                ahead = a || 0;
                behind = b || 0;
            }
        }
        const porcelain = await this._git(projectRow, name, ['status', '--porcelain', '-z', '--untracked-files=all'], { allowFail: true });
        const entries = porcelain.status === 0
            ? String(porcelain.stdout).split('\0').filter(Boolean)
            : [];
        const changes = [];
        const conflicts = [];
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const code = entry.slice(0, 2);
            const file = entry.slice(3);
            if (code[0] === 'R' || code[0] === 'C') i++; // the next NUL-separated entry is the source path
            changes.push({ code: code.trim() || '??', path: file });
            if (CONFLICT_CODES.has(code)) conflicts.push(file);
        }
        const log = await this._git(projectRow, name, ['log', `-n${RECENT_COMMITS}`, '--format=%h%x1f%an%x1f%aI%x1f%s'], { allowFail: true });
        const commits = log.status === 0
            ? String(log.stdout).split('\n').filter(Boolean).map(line => {
                const [short, author, when, subject] = line.split('\x1f');
                return { short, author, when: when ? new Date(when).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : null, message: subject || '' };
            })
            : [];
        const head = commits[0]?.short || null;
        return {
            branch: branch === 'HEAD' ? null : branch,
            detached: branch === 'HEAD',
            upstream,
            ahead,
            behind,
            head,
            operation: this._operation(projectRow, name),
            conflicts: conflicts.slice(0, STATUS_MAX_PATHS),
            changed: changes.length,
            changes: changes.slice(0, STATUS_MAX_PATHS),
            commits,
            sizeMb: Number((dirBytes(this.gitDirFor(projectRow, name)) / (1024 * 1024)).toFixed(2))
        };
    }

    _publish(projectRow, userId) {
        try {
            require('./eventBusService').publishProjectChange({
                userId, slug: projectRow.slug, reason: 'workspace', projectId: projectRow.id
            });
        } catch { /* bus is optional */ }
    }

    async _touch(projectRow, row, fields = {}) {
        const sets = ['updatedAt = datetime(\'now\')'];
        const params = { id: row.id };
        for (const [key, value] of Object.entries(fields)) {
            sets.push(`${key} = @${key}`);
            params[key] = value;
        }
        await db.run(`UPDATE project_repos SET ${sets.join(', ')} WHERE id = @id`, params);
        try { await this.projects._touchProject(projectRow.id); } catch { /* best effort */ }
    }

    async _audit(userId, action, detail) {
        try {
            await require('./integrationAudit').record({ guildId: dmScopeId(userId), userId, action, detail });
        } catch { /* never breaks the action */ }
    }

    // --- Public API ----------------------------------------------------------------------

    /** Every clone in the project with its live status. Always answers (enabled:false names why). */
    async list({ row = null, userId, project = null, owner = null, withStatus = true }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        const availability = this.availability();
        const rows = await db.all(
            'SELECT * FROM project_repos WHERE projectId = @projectId ORDER BY name',
            { projectId: projectRow.id }
        );
        const repos = [];
        for (const repoRow of rows) {
            repos.push(await this._serialize(projectRow, repoRow, { withStatus: withStatus && availability.enabled }));
        }
        return {
            project: projectRow.slug,
            enabled: availability.enabled,
            reason: availability.reason,
            maxRepos: this.config.maxReposPerProject,
            repos
        };
    }

    /** One clone's branch, upstream, ahead/behind, uncommitted changes and recent commits. */
    async status({ row = null, userId, project = null, owner = null, name }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        return this._serialize(projectRow, repoRow);
    }

    /**
     * Clone a GitHub repository into repos/<name> with the person's own
     * connection. Shallow, one branch, size- and count-capped.
     */
    async clone({ row = null, userId, project = null, owner = null, repo, branch = null, name = null }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const cleanRepo = this._cleanRepo(repo);
        const wantedBranch = cleanBranch(branch);
        const token = await this._token(userId);
        await this._checkAllowlist(userId, cleanRepo);

        let cleanName = this._cleanName(name || cleanRepo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'repo');
        if (!name) {
            const base = cleanName;
            for (let n = 2; await db.get('SELECT 1 AS ok FROM project_repos WHERE projectId = @projectId AND name = @name', { projectId: projectRow.id, name: cleanName }); n++) {
                cleanName = `${base.slice(0, 44)}-${n}`;
            }
        } else if (await db.get('SELECT 1 AS ok FROM project_repos WHERE projectId = @projectId AND name = @name', { projectId: projectRow.id, name: cleanName })) {
            throw new ProjectRepoError(409, 'DUPLICATE_REPO', `This project already has a repository called "${cleanName}".`);
        }
        const count = (await db.get(
            'SELECT COUNT(*) AS c FROM project_repos WHERE projectId = @projectId', { projectId: projectRow.id }
        ))?.c || 0;
        if (count >= this.config.maxReposPerProject) {
            throw new ProjectRepoError(400, 'TOO_MANY_REPOS',
                `At most ${this.config.maxReposPerProject} repositories per project - remove one first.`);
        }

        const info = await this._repoInfo(token, cleanRepo);
        const maxMb = Number(this.config.repoMaxMb) || 512;
        if (info?.sizeKb && info.sizeKb / 1024 > maxMb) {
            throw new ProjectRepoError(413, 'REPO_TOO_LARGE',
                `${cleanRepo} is about ${(info.sizeKb / 1024).toFixed(0)} MB, over the ${maxMb} MB repository cap.`);
        }

        const gitDir = this.gitDirFor(projectRow, cleanName);
        const workTree = this.workTreeFor(projectRow, cleanName);
        const legal = this.projects.legalizeWorkspacePath(projectRow.dir, `${REPOS_DIR}/${cleanName}`);
        if (fs.existsSync(legal.absolutePath) && fs.readdirSync(legal.absolutePath).length > 0) {
            throw new ProjectRepoError(409, 'PATH_IN_USE', `workspace/${REPOS_DIR}/${cleanName} already has files in it.`);
        }
        if (fs.existsSync(gitDir)) {
            throw new ProjectRepoError(409, 'PATH_IN_USE', `A repository directory for "${cleanName}" already exists.`);
        }

        return this._serial(projectRow, cleanName, async () => {
            const cleanup = () => {
                try { fs.rmSync(gitDir, { recursive: true, force: true }); } catch { /* best effort */ }
                try { fs.rmSync(workTree, { recursive: true, force: true }); } catch { /* best effort */ }
                for (const parent of [path.dirname(gitDir), path.dirname(workTree)]) {
                    try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* not empty or gone */ }
                }
            };
            let branchName = wantedBranch;
            try {
                fs.mkdirSync(gitDir, { recursive: true, mode: 0o700 });
                fs.mkdirSync(workTree, { recursive: true, mode: 0o700 });
                await this._git(projectRow, cleanName, ['init', '-q']);
                const settings = [
                    ['core.bare', 'false'],
                    ['core.worktree', workTree],
                    ['core.hooksPath', path.join(gitDir, 'no-hooks')],
                    ['core.symlinks', 'false'],
                    ['core.autocrlf', 'false'],
                    ['core.quotepath', 'false'],
                    ['core.fsmonitor', 'false'],
                    ['gc.autoDetach', 'false'],
                    ['commit.gpgsign', 'false'],
                    ['push.default', 'nothing'],
                    ['fetch.prune', 'true']
                ];
                for (const [key, value] of settings) await this._git(projectRow, cleanName, ['config', key, value]);
                await this._git(projectRow, cleanName, ['remote', 'add', 'origin', this._remoteUrl(cleanRepo)]);
                if (!branchName) {
                    branchName = info?.defaultBranch || null;
                    if (!branchName) {
                        const head = await this._git(projectRow, cleanName, ['ls-remote', '--symref', 'origin', 'HEAD'], { token });
                        const match = String(head.stdout).match(/^ref: refs\/heads\/(\S+)\tHEAD/m);
                        branchName = match ? match[1] : 'main';
                    }
                    branchName = cleanBranch(branchName);
                }
                await this._git(projectRow, cleanName,
                    ['fetch', '-q', `--depth=${this.config.repoCloneDepth || 50}`, '--no-tags', 'origin', branchName], { token });
                await this._git(projectRow, cleanName, ['checkout', '-q', '--track', '-B', branchName, `origin/${branchName}`]);
            } catch (error) {
                cleanup();
                throw this._explain(error, { repo: cleanRepo, branch: branchName });
            }

            const usedMb = this.projects.workspaceSizeMb(projectRow);
            if (usedMb > this.config.maxProjectMb) {
                cleanup();
                throw new ProjectRepoError(413, 'QUOTA_EXCEEDED',
                    `Cloning ${cleanRepo} would put the workspace over its ${this.config.maxProjectMb} MB quota (${usedMb.toFixed(1)} MB).`);
            }
            const repoMb = dirBytes(gitDir) / (1024 * 1024);
            if (repoMb > maxMb) {
                cleanup();
                throw new ProjectRepoError(413, 'REPO_TOO_LARGE',
                    `${cleanRepo} is ${repoMb.toFixed(0)} MB of history, over the ${maxMb} MB repository cap.`);
            }

            const id = await db.insert(
                `INSERT INTO project_repos (projectId, userId, name, repo, branch, createdBy, lastFetchAt)
                 VALUES (@projectId, @userId, @name, @repo, @branch, @createdBy, datetime('now'))`,
                { projectId: projectRow.id, userId: projectRow.ownerId ?? projectRow.userId, name: cleanName, repo: cleanRepo, branch: branchName, createdBy: userId }
            );
            try { await this.projects._touchProject(projectRow.id); } catch { /* best effort */ }
            await this.history.commitQuietly(projectRow, { userId, message: `cloned ${cleanRepo} into ${REPOS_DIR}/${cleanName}` });
            await this._audit(userId, 'project-repo-clone', { project: projectRow.slug, repo: cleanRepo, branch: branchName, name: cleanName });
            this._publish(projectRow, userId);
            const repoRow = await db.get('SELECT * FROM project_repos WHERE id = @id', { id });
            return this._serialize(projectRow, repoRow);
        });
    }

    /** Fetch the current branch and fast-forward; a diverged branch is reported, never merged. */
    async pull({ row = null, userId, project = null, owner = null, name }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const token = await this._token(userId);
        return this._serial(projectRow, repoRow.name, async () => {
            const status = await this._status(projectRow, repoRow.name);
            this._requireIdle(status);
            if (!status.branch) throw new ProjectRepoError(409, 'DETACHED', 'The clone is not on a branch; switch to one with repo_branch first.');
            await this.history.commitQuietly(projectRow, { userId, message: `before pulling ${REPOS_DIR}/${repoRow.name}` });
            const before = status.head;
            try {
                await this._git(projectRow, repoRow.name,
                    ['fetch', '-q', `--depth=${this.config.repoCloneDepth || 50}`, '--no-tags', 'origin', status.branch], { token });
                await this._git(projectRow, repoRow.name, ['merge', '-q', '--ff-only', '--no-edit', `origin/${status.branch}`]);
            } catch (error) {
                const text = String(error.gitStderr || error.message || '');
                if (/Not possible to fast-forward|diverg|fatal: Not possible|cannot fast-forward/i.test(text)) {
                    throw new ProjectRepoError(409, 'DIVERGED',
                        `Local commits on ${status.branch} are not on origin: push them first, or repo_reset to discard them.`);
                }
                if (/would be overwritten by merge|local changes/i.test(text)) {
                    throw new ProjectRepoError(409, 'DIRTY',
                        'Uncommitted changes would be overwritten: commit them (repo_commit) or discard them (repo_reset) first.');
                }
                throw this._explain(error, { repo: repoRow.repo, branch: status.branch });
            }
            await this._touch(projectRow, repoRow, { lastFetchAt: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') });
            const after = await this._status(projectRow, repoRow.name);
            if (after.head !== before) {
                await this.history.commitQuietly(projectRow, { userId, message: `pulled ${REPOS_DIR}/${repoRow.name} (${before || '?'}..${after.head})` });
            }
            this._publish(projectRow, userId);
            return { ...await this._serialize(projectRow, repoRow, { withStatus: false }), status: after, updated: after.head !== before, from: before, to: after.head };
        });
    }

    /** Stage everything in the clone and commit it as the person's GitHub identity. */
    async commit({ row = null, userId, project = null, owner = null, name, message }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const text = cleanMessage(message);
        const token = await this._token(userId);
        const identity = await this._identity(userId, token);
        return this._serial(projectRow, repoRow.name, async () => {
            this._requireIdle(await this._status(projectRow, repoRow.name));
            await this._git(projectRow, repoRow.name, ['add', '-A', '--ignore-errors', '--', '.']);
            const staged = await this._git(projectRow, repoRow.name, ['diff', '--cached', '--quiet'], { allowFail: true });
            if (staged.status === 0) return { committed: false, reason: 'NO_CHANGES', name: repoRow.name, repo: repoRow.repo };
            await this._git(projectRow, repoRow.name, ['commit', '-q', '--no-verify', '-m', text],
                { author: identity.name, authorEmail: identity.email });
            const hash = (await this._git(projectRow, repoRow.name, ['rev-parse', 'HEAD'])).stdout.trim();
            await this._touch(projectRow, repoRow);
            const status = await this._status(projectRow, repoRow.name);
            return { committed: true, name: repoRow.name, repo: repoRow.repo, hash, short: hash.slice(0, 7), author: identity.name, status };
        });
    }

    /** Push the current branch (or HEAD to a named branch) to origin. Never forced. */
    async push({ row = null, userId, project = null, owner = null, name, branch = null }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const target = cleanBranch(branch);
        const token = await this._token(userId);
        await this._checkAllowlist(userId, repoRow.repo);
        return this._serial(projectRow, repoRow.name, async () => {
            const status = await this._status(projectRow, repoRow.name);
            if (!status.head) throw new ProjectRepoError(409, 'NOTHING_TO_PUSH', 'The clone has no commits yet.');
            const branchName = target || status.branch;
            if (!branchName) throw new ProjectRepoError(409, 'DETACHED', 'The clone is not on a branch; pass branch=<name> to push HEAD there.');
            if (status.changed > 0 && !target) {
                logger.info?.(`[project-repos] ${projectRow.slug}/${repoRow.name}: pushing with ${status.changed} uncommitted change(s) left behind`);
            }
            try {
                await this._git(projectRow, repoRow.name, ['push', '-q', '--no-verify', 'origin', `HEAD:refs/heads/${branchName}`], { token });
            } catch (error) {
                const text = String(error.gitStderr || error.message || '');
                if (/rejected|non-fast-forward|fetch first|stale info/i.test(text)) {
                    throw new ProjectRepoError(409, 'REJECTED',
                        `origin/${branchName} has commits this clone does not: repo_pull first, then push again. Pushes are never forced.`);
                }
                if (/protected branch|GH006/i.test(text)) {
                    throw new ProjectRepoError(403, 'PROTECTED_BRANCH',
                        `${branchName} is protected on GitHub: push to another branch (branch=<name>) and open a pull request.`);
                }
                throw this._explain(error, { repo: repoRow.repo, branch: branchName });
            }
            if (branchName === status.branch) {
                await this._git(projectRow, repoRow.name, ['branch', `--set-upstream-to=origin/${branchName}`, branchName], { allowFail: true });
            }
            const when = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
            await this._touch(projectRow, repoRow, { lastPushAt: when });
            await this._audit(userId, 'project-repo-push', { project: projectRow.slug, repo: repoRow.repo, branch: branchName, head: status.head });
            const compareUrl = branchName !== repoRow.branch
                ? `https://github.com/${repoRow.repo}/compare/${encodeURIComponent(repoRow.branch)}...${encodeURIComponent(branchName)}?expand=1`
                : null;
            return {
                pushed: true, name: repoRow.name, repo: repoRow.repo, branch: branchName, head: status.head,
                url: `https://github.com/${repoRow.repo}/tree/${encodeURIComponent(branchName)}`,
                compareUrl,
                status: await this._status(projectRow, repoRow.name)
            };
        });
    }

    /** Switch to a branch, creating it when it exists neither locally nor on origin. */
    async checkout({ row = null, userId, project = null, owner = null, name, branch }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const branchName = cleanBranch(branch);
        if (!branchName) throw new ProjectRepoError(400, 'BAD_BRANCH', 'Which branch?');
        const token = await this._token(userId);
        return this._serial(projectRow, repoRow.name, async () => {
            this._requireIdle(await this._status(projectRow, repoRow.name));
            await this.history.commitQuietly(projectRow, { userId, message: `before switching ${REPOS_DIR}/${repoRow.name} to ${branchName}` });
            let created = false;
            try {
                const local = await this._git(projectRow, repoRow.name, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], { allowFail: true });
                if (local.status === 0) {
                    await this._git(projectRow, repoRow.name, ['checkout', '-q', branchName]);
                } else {
                    const fetched = await this._git(projectRow, repoRow.name,
                        ['fetch', '-q', `--depth=${this.config.repoCloneDepth || 50}`, '--no-tags', 'origin', branchName], { token, allowFail: true });
                    if (fetched.status === 0) {
                        await this._git(projectRow, repoRow.name, ['checkout', '-q', '--track', '-B', branchName, `origin/${branchName}`]);
                    } else {
                        await this._git(projectRow, repoRow.name, ['checkout', '-q', '-b', branchName]);
                        created = true;
                    }
                }
            } catch (error) {
                const text = String(error.gitStderr || error.message || '');
                if (/would be overwritten by checkout|local changes/i.test(text)) {
                    throw new ProjectRepoError(409, 'DIRTY',
                        'Uncommitted changes would be overwritten: commit them (repo_commit) or discard them (repo_reset) first.');
                }
                throw this._explain(error, { repo: repoRow.repo, branch: branchName });
            }
            await this._touch(projectRow, repoRow);
            this._publish(projectRow, userId);
            return { name: repoRow.name, repo: repoRow.repo, branch: branchName, created, status: await this._status(projectRow, repoRow.name) };
        });
    }

    // --- Merge and rebase ------------------------------------------------------------------

    /** Fetch origin/<base>, deepening a shallow clone when the two lines have no visible common ancestor. */
    async _fetchBase(projectRow, repoRow, base, token) {
        const name = repoRow.name;
        try {
            await this._git(projectRow, name,
                ['fetch', '-q', `--depth=${this.config.repoCloneDepth || 50}`, '--no-tags', 'origin', base], { token });
        } catch (error) {
            throw this._explain(error, { repo: repoRow.repo, branch: base });
        }
        const ref = `origin/${base}`;
        const hasBase = async () => (await this._git(projectRow, name, ['merge-base', 'HEAD', ref], { allowFail: true })).status === 0;
        if (await hasBase()) return ref;
        try {
            await this._git(projectRow, name, ['fetch', '-q', `--deepen=${DEEPEN_COMMITS}`, '--no-tags', 'origin', base], { token });
        } catch (error) {
            throw this._explain(error, { repo: repoRow.repo, branch: base });
        }
        if (!await hasBase()) {
            throw new ProjectRepoError(409, 'NO_COMMON_HISTORY',
                `This branch and ${ref} share no history this shallow clone can see, so they cannot be combined here.`);
        }
        return ref;
    }

    /** Shared by merge and rebase: bring origin/<base> into the current branch. */
    async _integrate(kind, { row = null, userId, project = null, owner = null, name, branch = null }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const requested = cleanBranch(branch);
        const token = await this._token(userId);
        await this._checkAllowlist(userId, repoRow.repo);
        const identity = await this._identity(userId, token);
        return this._serial(projectRow, repoRow.name, async () => {
            const status = await this._status(projectRow, repoRow.name);
            this._requireIdle(status);
            if (!status.branch) throw new ProjectRepoError(409, 'DETACHED', 'The clone is not on a branch; switch to one with repo_branch first.');
            const base = requested || repoRow.branch;
            if (base === status.branch) {
                throw new ProjectRepoError(409, 'SAME_BRANCH',
                    `${base} is the branch you are on: repo_pull brings in what origin has; pass branch=<other branch> to ${kind} that instead.`);
            }
            if (status.changed > 0) {
                throw new ProjectRepoError(409, 'DIRTY',
                    `Uncommitted changes would be in the way of the ${kind}: commit them (repo_commit) or discard them (repo_reset) first.`);
            }
            await this.history.commitQuietly(projectRow, { userId, message: `before ${kind} of ${REPOS_DIR}/${repoRow.name} with ${base}` });
            const ref = await this._fetchBase(projectRow, repoRow, base, token);
            const repoName = repoRow.name;
            const base_ = { repo: repoRow.repo, name: repoName, kind, base, branch: status.branch };

            const contained = await this._git(projectRow, repoName, ['merge-base', '--is-ancestor', ref, 'HEAD'], { allowFail: true });
            if (contained.status === 0) {
                return { ...base_, result: 'up-to-date', conflicts: [], from: status.head, to: status.head, status };
            }
            if (kind === 'rebase') {
                const published = await this._git(projectRow, repoName,
                    ['rev-list', '--count', `origin/${status.branch}`, '--not', ref], { allowFail: true });
                if (published.status === 0 && Number(String(published.stdout).trim()) > 0) {
                    throw new ProjectRepoError(409, 'REBASE_PUBLISHED',
                        `${status.branch} already has commits on origin, and a rebase would rewrite them (pushes are never forced): `
                        + `use repo_merge branch=${base} instead.`);
                }
            }
            const fastForward = (await this._git(projectRow, repoName, ['merge-base', '--is-ancestor', 'HEAD', ref], { allowFail: true })).status === 0;
            const args = kind === 'rebase' ? ['rebase', '-q', ref] : ['merge', '-q', '--no-edit', ref];
            const run = await this._git(projectRow, repoName, args,
                { author: identity.name, authorEmail: identity.email, allowFail: true });
            return this._finishIntegration({
                projectRow, repoRow, userId, kind, base, ref, run, fastForward, from: status.head, extra: base_
            });
        });
    }

    async _finishIntegration({ projectRow, repoRow, userId, kind, base, run, fastForward = false, from, extra }) {
        const after = await this._status(projectRow, repoRow.name);
        this._publish(projectRow, userId);
        if (after.operation) {
            await this.history.commitQuietly(projectRow, { userId, message: `${kind} of ${REPOS_DIR}/${repoRow.name} stopped on conflicts` });
            return { ...extra, result: 'conflicted', conflicts: after.conflicts, from, to: after.head, status: after };
        }
        if (run && run.status !== 0) {
            const text = String(run.stderr || run.stdout || '');
            if (DIRTY_PATTERN.test(text)) {
                throw new ProjectRepoError(409, 'DIRTY',
                    `Uncommitted changes would be in the way of the ${kind}: commit them (repo_commit) or discard them (repo_reset) first.`);
            }
            throw new ProjectRepoError(500, 'GIT_FAILED', `The ${kind} failed: ${text.trim().slice(0, 300) || `git exited ${run.status}`}`);
        }
        await this._touch(projectRow, repoRow);
        await this.history.commitQuietly(projectRow, { userId, message: `${kind}d ${REPOS_DIR}/${repoRow.name} with ${base} (${from || '?'}..${after.head})` });
        await this._audit(userId, `project-repo-${kind}`, { project: projectRow.slug, repo: repoRow.repo, base, branch: after.branch, head: after.head });
        return {
            ...extra,
            result: kind === 'rebase' ? 'rebased' : (fastForward ? 'fast-forwarded' : 'merged'),
            conflicts: [], from, to: after.head, status: after
        };
    }

    /** Merge origin/<branch> (default: the branch the clone started from) into the current branch. */
    merge(args) {
        return this._integrate('merge', args);
    }

    /** Replay the current branch's local commits on origin/<branch>. Refused once they are on origin. */
    rebase(args) {
        return this._integrate('rebase', args);
    }

    /** Finish a merge or rebase stopped on conflicts, once the conflicted files are fixed. */
    async continue({ row = null, userId, project = null, owner = null, name }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const token = await this._token(userId);
        const identity = await this._identity(userId, token);
        return this._serial(projectRow, repoRow.name, async () => {
            const status = await this._status(projectRow, repoRow.name);
            if (!status.operation) throw new ProjectRepoError(409, 'NO_OPERATION', 'No merge or rebase is in progress here.');
            const unresolved = [];
            for (const file of status.conflicts) {
                try {
                    const text = fs.readFileSync(path.join(this.workTreeFor(projectRow, repoRow.name), file), 'utf8');
                    if (/^(<{7}|={7}|>{7})( |$)/m.test(text)) unresolved.push(file);
                } catch { /* deleted or binary: the person's call */ }
            }
            if (unresolved.length > 0) {
                throw new ProjectRepoError(409, 'UNRESOLVED',
                    `Conflict markers (<<<<<<<, =======, >>>>>>>) are still in: ${unresolved.join(', ')}. Edit them out, then repo_continue.`);
            }
            await this._git(projectRow, repoRow.name, ['add', '-A', '--ignore-errors', '--', '.']);
            const run = await this._git(projectRow, repoRow.name,
                ['-c', 'core.editor=true', status.operation, '--continue'],
                { author: identity.name, authorEmail: identity.email, allowFail: true });
            const base = status.operation === 'rebase' ? 'its base' : 'the other branch';
            return this._finishIntegration({
                projectRow, repoRow, userId, kind: status.operation, base, run, from: status.head,
                extra: { repo: repoRow.repo, name: repoRow.name, kind: status.operation, base, branch: status.branch }
            });
        });
    }

    /** Give up a merge or rebase stopped on conflicts: the branch goes back to how it was. */
    async abort({ row = null, userId, project = null, owner = null, name }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        return this._serial(projectRow, repoRow.name, async () => {
            const status = await this._status(projectRow, repoRow.name);
            if (!status.operation) throw new ProjectRepoError(409, 'NO_OPERATION', 'No merge or rebase is in progress here.');
            try {
                await this._git(projectRow, repoRow.name, [status.operation, '--abort']);
            } catch (error) {
                throw this._explain(error, { repo: repoRow.repo });
            }
            await this._touch(projectRow, repoRow);
            await this.history.commitQuietly(projectRow, { userId, message: `aborted ${status.operation} of ${REPOS_DIR}/${repoRow.name}` });
            this._publish(projectRow, userId);
            return { aborted: status.operation, name: repoRow.name, repo: repoRow.repo, status: await this._status(projectRow, repoRow.name) };
        });
    }

    // --- Branches, comparison, pull requests, CI ----------------------------------------------

    async _localBranchExists(projectRow, name, branch) {
        return (await this._git(projectRow, name, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).status === 0;
    }

    /**
     * Every branch of one clone: local ones (current, upstream, ahead/behind the
     * branch the clone started from) merged with GitHub's list, so branches that
     * exist only on the remote can be switched to. Remote data is best effort.
     */
    async branches({ row = null, userId, project = null, owner = null, name }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const entries = new Map();
        const listing = await this._git(projectRow, repoRow.name, [
            'for-each-ref', '--format=%(refname:short)%1f%(upstream:short)%1f%(objectname:short)%1f%(HEAD)%1f%(committerdate:iso-strict)%1f%(subject)',
            'refs/heads'
        ], { allowFail: true });
        const baseRef = `refs/remotes/origin/${repoRow.branch}`;
        const hasBase = (await this._git(projectRow, repoRow.name, ['rev-parse', '--verify', '--quiet', baseRef], { allowFail: true })).status === 0;
        for (const line of String(listing.stdout || '').split('\n').filter(Boolean)) {
            const [branch, upstream, head, mark, when, subject] = line.split('\x1f');
            let ahead = null;
            let behind = null;
            if (hasBase && branch !== repoRow.branch) {
                const counts = await this._git(projectRow, repoRow.name, ['rev-list', '--left-right', '--count', `${baseRef}...refs/heads/${branch}`], { allowFail: true });
                if (counts.status === 0) [behind, ahead] = String(counts.stdout).trim().split(/\s+/).map(Number);
            }
            entries.set(branch, {
                name: branch, current: mark === '*', local: true, remote: false, protected: false,
                isBase: branch === repoRow.branch, upstream: upstream || null, head,
                when: when ? new Date(when).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : null,
                subject: subject || '', aheadOfBase: ahead, behindBase: behind
            });
        }
        let remoteError = null;
        try {
            const { api } = await this._api(userId, repoRow);
            for (const remote of await api.listBranches(repoRow.repo)) {
                const entry = entries.get(remote.name) || {
                    name: remote.name, current: false, local: false, isBase: remote.name === repoRow.branch,
                    upstream: null, head: String(remote.commit?.sha || '').slice(0, 7), when: null, subject: '',
                    aheadOfBase: null, behindBase: null
                };
                entry.remote = true;
                entry.protected = Boolean(remote.protected);
                entries.set(remote.name, entry);
            }
        } catch (error) {
            remoteError = this._apiError(error, repoRow.repo).message;
        }
        const sorted = [...entries.values()].sort((a, b) =>
            (b.current - a.current) || (b.isBase - a.isBase) || (b.local - a.local) || a.name.localeCompare(b.name));
        return {
            name: repoRow.name, repo: repoRow.repo, base: repoRow.branch,
            current: sorted.find(entry => entry.current)?.name || null,
            branches: sorted, remoteError
        };
    }

    /** A usable ref for one branch: the person's local branch when asked for, else origin's, fetched fresh. */
    async _refFor(projectRow, repoRow, branch, token, { preferLocal }) {
        const local = await this._localBranchExists(projectRow, repoRow.name, branch);
        if (preferLocal && local) return `refs/heads/${branch}`;
        const fetched = await this._git(projectRow, repoRow.name,
            ['fetch', '-q', `--depth=${this.config.repoCloneDepth || 50}`, '--no-tags', 'origin', branch], { token, allowFail: true });
        if (fetched.status === 0) return `refs/remotes/origin/${branch}`;
        if (local) return `refs/heads/${branch}`;
        const text = String(fetched.stderr || '');
        if (/couldn't find remote ref|not found/i.test(text) || !text) {
            throw new ProjectRepoError(404, 'NO_SUCH_BRANCH', `No branch "${branch}" locally or on ${repoRow.repo}.`);
        }
        throw this._explain({ code: 'GIT_FAILED', gitStderr: text, message: text }, { repo: repoRow.repo, branch });
    }

    /**
     * What `head` has that `base` does not (the pull-request view): ahead/behind,
     * commits, per-file counts and a capped patch. Defaults: head = the current
     * branch, base = the branch the clone started from. Read-only.
     */
    async compare({ row = null, userId, project = null, owner = null, name, base = null, head = null }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const wantedBase = cleanBranch(base) || repoRow.branch;
        const wantedHead = cleanBranch(head);
        const token = await this._token(userId);
        await this._checkAllowlist(userId, repoRow.repo);
        return this._serial(projectRow, repoRow.name, async () => {
            const status = await this._status(projectRow, repoRow.name);
            const headName = wantedHead || status.branch;
            if (!headName) throw new ProjectRepoError(409, 'DETACHED', 'The clone is not on a branch; pass head=<branch>.');
            const baseRef = await this._refFor(projectRow, repoRow, wantedBase, token, { preferLocal: false });
            const headRef = await this._refFor(projectRow, repoRow, headName, token, { preferLocal: true });
            const g = (args, opts = {}) => this._git(projectRow, repoRow.name, args, { allowFail: true, ...opts });

            let threeDot = true;
            const probe = await g(['merge-base', baseRef, headRef]);
            if (probe.status !== 0) {
                try {
                    await this._git(projectRow, repoRow.name, ['fetch', '-q', `--deepen=${DEEPEN_COMMITS}`, '--no-tags', 'origin', wantedBase], { token });
                } catch { /* compare what we have */ }
                if ((await g(['merge-base', baseRef, headRef])).status !== 0) threeDot = false;
            }
            const range = `${baseRef}${threeDot ? '...' : '..'}${headRef}`;
            const counts = await g(['rev-list', '--left-right', '--count', `${baseRef}...${headRef}`]);
            const [behind, ahead] = counts.status === 0 ? String(counts.stdout).trim().split(/\s+/).map(Number) : [null, null];
            const log = await g(['log', `-n${COMPARE_MAX_COMMITS}`, '--format=%h%x1f%an%x1f%aI%x1f%s', `${baseRef}..${headRef}`]);
            const commits = log.status === 0
                ? String(log.stdout).split('\n').filter(Boolean).map(line => {
                    const [short, author, when, subject] = line.split('\x1f');
                    return { short, author, when: when ? new Date(when).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') : null, message: subject || '' };
                })
                : [];
            const numstat = await g(['diff', '--numstat', '--no-ext-diff', '--no-textconv', '-M', range]);
            const files = String(numstat.stdout || '').split('\n').filter(Boolean).map(line => {
                const [added, removed, ...rest] = line.split('\t');
                const binary = added === '-';
                return { path: rest.join('\t'), additions: binary ? 0 : Number(added) || 0, deletions: binary ? 0 : Number(removed) || 0, binary };
            });
            let patch = '';
            let truncated = false;
            try {
                const diff = await g(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', range], { maxBuffer: COMPARE_PATCH_BYTES });
                patch = String(diff.stdout || '');
            } catch (error) {
                if (error.code !== 'TOO_LARGE') throw error;
                truncated = true;
            }
            if (patch.length > COMPARE_PATCH_CHARS) {
                patch = patch.slice(0, COMPARE_PATCH_CHARS);
                truncated = true;
            }
            return {
                name: repoRow.name, repo: repoRow.repo, base: wantedBase, head: headName,
                ahead, behind, sharedHistory: threeDot,
                identical: files.length === 0 && commits.length === 0,
                commits, files: files.slice(0, COMPARE_MAX_FILES), fileCount: files.length,
                additions: files.reduce((sum, file) => sum + file.additions, 0),
                deletions: files.reduce((sum, file) => sum + file.deletions, 0),
                patch, truncated
            };
        });
    }

    /**
     * One clone at a glance: local status, plus (best effort, from GitHub)
     * CI for the current branch and that branch's open pull request. The
     * Code view's strip and the project overview read this.
     */
    async summary({ row = null, userId, project = null, owner = null, name }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const status = await this._status(projectRow, repoRow.name);
        const out = { ...await this._serialize(projectRow, repoRow, { withStatus: false }), status, ci: null, pr: null, remoteError: null };
        if (!status.branch) return out;
        try {
            const { api } = await this._api(userId, repoRow);
            const owner_ = repoRow.repo.split('/')[0];
            const [checks, pulls] = await Promise.all([
                api.getChecks(repoRow.repo, status.branch).catch(error => (error?.code === 'NOT_FOUND' ? { runs: [], statuses: [] } : Promise.reject(error))),
                status.branch === repoRow.branch
                    ? Promise.resolve([])
                    : api.listPullRequests(repoRow.repo, { state: 'open', limit: 1, head: `${owner_}:${status.branch}` })
            ]);
            out.ci = ProjectRepoService.summarizeChecks(checks);
            const pr = pulls?.[0];
            if (pr) out.pr = { number: pr.number, title: pr.title, url: pr.html_url, draft: Boolean(pr.draft), base: pr.base?.ref || null };
        } catch (error) {
            out.remoteError = this._apiError(error, repoRow.repo).message;
        }
        return out;
    }

    /** Collapse check runs and legacy statuses into one verdict plus what failed. */
    static summarizeChecks({ runs = [], statuses = [] } = {}) {
        const failing = [];
        const pending = [];
        let passed = 0;
        for (const run of runs) {
            if (run.status && run.status !== 'completed') pending.push(run.name);
            else if (FAILING_CONCLUSIONS.has(run.conclusion)) {
                failing.push({
                    name: run.name, conclusion: run.conclusion, url: run.html_url || null,
                    summary: String(run.output?.title || run.output?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300)
                });
            } else passed++;
        }
        for (const entry of statuses) {
            if (entry.state === 'pending') pending.push(entry.context);
            else if (entry.state === 'failure' || entry.state === 'error') {
                failing.push({ name: entry.context, conclusion: entry.state, url: entry.target_url || null, summary: String(entry.description || '').slice(0, 300) });
            } else passed++;
        }
        const total = runs.length + statuses.length;
        const state = total === 0 ? 'none' : failing.length ? 'failure' : pending.length ? 'pending' : 'success';
        return { state, total, passed, failing, pending };
    }

    /** CI for a ref (default: the current branch as GitHub knows it). A branch GitHub has never seen is `none`. */
    async ci({ row = null, userId, project = null, owner = null, name, ref = null }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const target = cleanBranch(ref) || (await this._status(projectRow, repoRow.name)).branch;
        if (!target) throw new ProjectRepoError(409, 'DETACHED', 'The clone is not on a branch; pass ref=<branch>.');
        const { api } = await this._api(userId, repoRow);
        try {
            const checks = await api.getChecks(repoRow.repo, target);
            return { name: repoRow.name, repo: repoRow.repo, ref: target, ...ProjectRepoService.summarizeChecks(checks) };
        } catch (error) {
            if (error?.code === 'NOT_FOUND') return { name: repoRow.name, repo: repoRow.repo, ref: target, state: 'none', total: 0, passed: 0, failing: [], pending: [], notOnGitHub: true };
            throw this._apiError(error, repoRow.repo);
        }
    }

    /** Pull requests of the repository with their CI verdicts (capped, best effort per PR). */
    async pullRequests({ row = null, userId, project = null, owner = null, name, state = 'open' }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const { api } = await this._api(userId, repoRow);
        let list;
        try {
            list = await api.listPullRequests(repoRow.repo, { state: ['open', 'closed', 'all'].includes(state) ? state : 'open', limit: PR_LIST_MAX });
        } catch (error) {
            throw this._apiError(error, repoRow.repo);
        }
        const pulls = await Promise.all(list.slice(0, PR_LIST_MAX).map(async (pr) => {
            let ci = null;
            if (pr.head?.sha && pr.state === 'open') {
                try { ci = ProjectRepoService.summarizeChecks(await api.getChecks(repoRow.repo, pr.head.sha)); } catch { /* CI is a bonus */ }
            }
            return {
                number: pr.number, title: pr.title, url: pr.html_url, state: pr.merged_at ? 'merged' : pr.state,
                draft: Boolean(pr.draft), author: pr.user?.login || null,
                head: pr.head?.ref || null, base: pr.base?.ref || null, updatedAt: pr.updated_at || null, ci
            };
        }));
        return { name: repoRow.name, repo: repoRow.repo, pulls };
    }

    /**
     * Open a pull request from `head` (default: the current branch) into `base`
     * (default: the branch the clone started from) as the person. The head must
     * already be on GitHub: pass push=true to push it first (never forced).
     */
    async createPullRequest({ row = null, userId, project = null, owner = null, name, title, body = '', base = null, head = null, draft = false, push = false }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const cleanTitle = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 250);
        if (!cleanTitle) throw new ProjectRepoError(400, 'EMPTY_TITLE', 'A pull request needs a title.');
        const wantedBase = cleanBranch(base) || repoRow.branch;
        const { api } = await this._api(userId, repoRow);
        let status = await this._status(projectRow, repoRow.name);
        const headName = cleanBranch(head) || status.branch;
        if (!headName) throw new ProjectRepoError(409, 'DETACHED', 'The clone is not on a branch; pass head=<branch>.');
        if (headName === wantedBase) {
            throw new ProjectRepoError(409, 'SAME_BRANCH', `${headName} is also the base: switch to a work branch (repo_branch) first.`);
        }
        if (headName === status.branch) {
            if (push && (status.ahead > 0 || !status.upstream)) {
                await this.push({ row: projectRow, userId, name: repoRow.name });
                status = await this._status(projectRow, repoRow.name);
            }
            if (!status.upstream || status.ahead > 0) {
                throw new ProjectRepoError(409, 'NOT_PUSHED',
                    `${headName} has commits GitHub does not: repo_push first (or pass push=true), then open the pull request.`);
            }
        }
        let created;
        try {
            created = await api.createPullRequest(repoRow.repo, { title: cleanTitle, body, head: headName, base: wantedBase, draft });
        } catch (error) {
            throw this._apiError(error, repoRow.repo);
        }
        await this._audit(userId, 'project-repo-pr', { project: projectRow.slug, repo: repoRow.repo, number: created.number, head: headName, base: wantedBase });
        return {
            name: repoRow.name, repo: repoRow.repo, number: created.number, url: created.html_url,
            title: created.title || cleanTitle, draft: Boolean(created.draft), head: headName, base: wantedBase
        };
    }

    /** Discard local commits and changes: back to origin/<branch>. A snapshot is taken first. */
    async reset({ row = null, userId, project = null, owner = null, name }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        this._requireEnabled();
        const repoRow = await this._row(projectRow, name);
        const token = await this._token(userId);
        return this._serial(projectRow, repoRow.name, async () => {
            let status = await this._status(projectRow, repoRow.name);
            if (status.operation) {
                await this._git(projectRow, repoRow.name, [status.operation, '--abort'], { allowFail: true });
                status = await this._status(projectRow, repoRow.name);
            }
            if (!status.branch) throw new ProjectRepoError(409, 'DETACHED', 'The clone is not on a branch; switch to one with repo_branch first.');
            const snapshot = await this.history.commitQuietly(projectRow, { userId, message: `before resetting ${REPOS_DIR}/${repoRow.name}` });
            try {
                await this._git(projectRow, repoRow.name,
                    ['fetch', '-q', `--depth=${this.config.repoCloneDepth || 50}`, '--no-tags', 'origin', status.branch], { token });
                await this._git(projectRow, repoRow.name, ['reset', '-q', '--hard', `origin/${status.branch}`]);
                await this._git(projectRow, repoRow.name, ['clean', '-fdq']);
            } catch (error) {
                throw this._explain(error, { repo: repoRow.repo, branch: status.branch });
            }
            await this._touch(projectRow, repoRow, { lastFetchAt: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '') });
            await this.history.commitQuietly(projectRow, { userId, message: `reset ${REPOS_DIR}/${repoRow.name} to origin/${status.branch}` });
            this._publish(projectRow, userId);
            return {
                name: repoRow.name, repo: repoRow.repo, branch: status.branch,
                snapshot: snapshot?.hash || null,
                status: await this._status(projectRow, repoRow.name)
            };
        });
    }

    /** Remove the clone (work tree and git dir). The files stay in workspace history. */
    async remove({ row = null, userId, project = null, owner = null, name }) {
        const projectRow = await this._resolve({ row, userId, project, owner });
        const repoRow = await this._row(projectRow, name);
        return this._serial(projectRow, repoRow.name, async () => {
            await this.history.commitQuietly(projectRow, { userId, message: `before removing ${REPOS_DIR}/${repoRow.name}` });
            try { fs.rmSync(this.workTreeFor(projectRow, repoRow.name), { recursive: true, force: true }); } catch { /* best effort */ }
            try { fs.rmSync(this.gitDirFor(projectRow, repoRow.name), { recursive: true, force: true }); } catch { /* best effort */ }
            for (const parent of [this.reposDir(projectRow), path.join(path.resolve(projectRow.dir), REPOS_DIR)]) {
                try { if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent); } catch { /* not empty or gone */ }
            }
            await db.run('DELETE FROM project_repos WHERE id = @id', { id: repoRow.id });
            try { await this.projects._touchProject(projectRow.id); } catch { /* best effort */ }
            await this.history.commitQuietly(projectRow, { userId, message: `removed ${REPOS_DIR}/${repoRow.name}` });
            this._publish(projectRow, userId);
            return { removed: true, name: repoRow.name, repo: repoRow.repo };
        });
    }
}

module.exports = new ProjectRepoService();
module.exports.ProjectRepoService = ProjectRepoService;
module.exports.ProjectRepoError = ProjectRepoError;
module.exports.REPOS_DIR = REPOS_DIR;
module.exports.cleanBranch = cleanBranch;
