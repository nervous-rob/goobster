/**
 * Run capability: repository work in a clone of the linked project (DA-11a).
 * Committing needs `repo.commit`, pushing `repo.push` and opening a pull
 * request `pr.create`, each on that `repository` and that branch.
 *
 * Everything goes through projectRepoService (ADR 0015): host-side sealed
 * git, the acting person's own GitHub connection, never forced. On top of
 * the grant's branch patterns, none of the three works on the branch the
 * clone started from, the repository's default branch, or a branch GitHub
 * reports as protected; when GitHub cannot say, the call is refused.
 *
 * A push or a pull request leaves this installation and cannot be undone
 * from here. Both count against the responsibility's `externalOperations`
 * budget, each says so in its result, and neither is allowed once the run
 * has read the person's private knowledge. After a crash they are
 * reconciled against GitHub before anything is done again.
 *
 * Offered only to a run whose responsibility grants the operation on a
 * repository of the linked project, and whose owner is in the pilot
 * (assistantAccessService, capability `reach`).
 */

const db = require('../../../db');
const requireOptional = require('../../../utils/optionalModule').forModule(module);
const access = require('../../assistantAccessService');
const { assistantUser } = require('../../assistantIdentity');
const { clip } = require('./shared');

const CAPABILITY = 'reach';
/** The commit trailer and pull-request footer that identify one journaled operation. */
const TRAILER = 'Goobster-Operation';
const MAX_PATHS = 100;
const BODY_CHARS = 20_000;

/** Refusals that mean the write certainly did not happen, in plain words. */
const DECLINED = {
    DIRTY: 'uncommitted changes in the clone are in the way of switching to that branch',
    IN_PROGRESS: 'a merge or rebase is stopped on conflicts in that clone',
    BRANCH_CHANGED: 'the clone is not on that branch',
    DETACHED: 'the clone is not on a branch',
    EMPTY_MESSAGE: 'a commit needs a message',
    BAD_PATH: 'a path is not inside the clone',
    NO_MATCH: 'one of those paths matches nothing in the clone',
    NOTHING_TO_PUSH: 'the clone has no commits',
    REJECTED: 'GitHub has commits on that branch this clone does not have, and a push is never forced',
    PROTECTED_BRANCH: 'GitHub protects that branch',
    NOT_PUSHED: 'that branch has commits GitHub does not have yet, so push it first',
    SAME_BRANCH: 'that branch is the one the pull request would go into',
    EMPTY_TITLE: 'a pull request needs a title',
    REJECTED_BY_GITHUB: 'GitHub refused it',
    RATE_LIMITED: 'GitHub is rate limiting the account',
    NO_GITHUB: 'no GitHub account is connected',
    NO_ACCESS: 'the connected GitHub account is not allowed to do that on this repository',
    REPO_NOT_ALLOWED: 'the repository is not on the personal GitHub allowlist',
    NO_SUCH_REPO: 'there is no such clone in the project'
};
/** Guard failures passed on as they are; anything else reads as "GitHub could not say". */
const GUARD_CODES = new Set(['NO_GITHUB', 'NO_ACCESS', 'NOT_FOUND', 'REPO_NOT_ALLOWED', 'POLICY_UNAVAILABLE', 'REPOS_DISABLED', 'GIT_MISSING', 'GITHUB_OFF', 'NO_SUCH_REPO']);

function repoService() {
    const projects = requireOptional('../../projectService', { feature: 'projects' });
    return projects?.repos || null;
}

const cloneName = (repository) => String(repository ?? '').trim().toLowerCase();
const operationId = (ctx) => `${ctx.run.id}:${ctx.opId}`;

/** The service call's target: the clone, as the acting person. */
function at(ctx, repository) {
    return { userId: ctx.actor, project: ctx.project.slug, owner: ctx.project.ownerId, name: cloneName(repository) };
}

/** Offered when the grant covers the operation on a repository of the linked project. */
function offeredFor(operation) {
    return ({ project, features, grants, capabilities }) => Boolean(project)
        && !features.enforcedOff('projects') && !features.enforcedOff('github')
        && Boolean(capabilities?.[CAPABILITY])
        && (grants || []).some(entry => entry?.operation === operation
            && entry.resource?.kind === 'repository' && String(entry.resource.projectId) === String(project.id));
}

/**
 * What authorize() must allow: the operation on this clone's repository and
 * this branch. Refused before that when there is no such clone, the branch
 * is not a usable name, or it is the branch the clone started from.
 */
function needsFor(operation) {
    return async ({ repository, branch }, ctx) => {
        if (!ctx.project) return { refuse: 'NO_PROJECT' };
        const name = cloneName(repository);
        const row = name ? await db.get(
            'SELECT repo, branch FROM project_repos WHERE projectId = @projectId AND name = @name',
            { projectId: ctx.project.id, name }
        ) : null;
        if (!row) return { refuse: 'NO_SUCH_REPO' };
        const repos = requireOptional('../../projectRepoService', { feature: 'projects' });
        let target;
        try { target = repos ? repos.cleanBranch(branch) : null; } catch { target = null; }
        if (!target) return { refuse: 'BAD_BRANCH' };
        if (target === row.branch) return { refuse: 'BASE_BRANCH' };
        return { operation, resource: { kind: 'repository', id: row.repo, projectId: String(ctx.project.id), branch: target } };
    };
}

/**
 * Asked after authorize() allowed the call, because it reads GitHub as the
 * person: the pilot gate, then what GitHub says about the branch. Returns a
 * refusal code, or null to go ahead.
 */
async function guard({ repository, branch }, ctx) {
    if (!(await access.allows(ctx.run.ownerUserId, CAPABILITY))) return access.REFUSAL_CODE;
    const repos = repoService();
    if (!repos) return 'FEATURE_UNAVAILABLE';
    try {
        const policy = await repos.branchPolicy({ ...at(ctx, repository), branch });
        if (policy.isDefault) return 'DEFAULT_BRANCH';
        if (policy.protected) return 'PROTECTED_BRANCH';
        return null;
    } catch (error) {
        return GUARD_CODES.has(error?.code) ? error.code : 'BRANCH_UNVERIFIED';
    }
}

/** A known "did not happen" as the tool's answer; anything else is rethrown (it may have happened). */
function declined(error, verb) {
    const code = error?.code === 'GIT_FAILED' && /did not match any file/i.test(String(error.gitStderr || ''))
        ? 'NO_MATCH' : error?.code;
    if (!Object.prototype.hasOwnProperty.call(DECLINED, code)) throw error;
    const detail = code === 'REJECTED_BY_GITHUB' && error.message ? ` (${clip(String(error.message).replace(/\s+/g, ' '), 200)})` : '';
    return `Not ${verb} (${code}): ${DECLINED[code]}${detail}.`;
}

/** A failed look before the write: nothing was attempted, whatever went wrong. */
function notAttempted(error, verb) {
    const code = error?.code && /^[A-Z_]{2,40}$/.test(String(error.code)) ? error.code : 'ERROR';
    return `Not ${verb} (${code}): ${DECLINED[code] || 'the clone or GitHub could not be asked first'}.`;
}

const unavailable = (verb) => `Not ${verb}: project repositories are not available on this installation.`;

const REPOSITORY_PARAM = { type: 'string', description: 'The clone\'s folder name under repos/ in the linked project (repos/<name>/).' };
const BRANCH_PARAM = { type: 'string', description: 'The work branch. Never the default branch, the branch the clone started from, or a protected branch.' };

module.exports = {
    commitProjectRepo: {
        effect: 'write',
        component: 'projects',
        publishes: 'project',
        available: offeredFor('repo.commit'),
        definition: {
            name: 'commitProjectRepo',
            description: 'Commit files you changed in a repository cloned into the linked project, on a work branch. The clone is switched to that branch first (it is created from the current commit when it does not exist). Only the paths you name are committed. The commit stays in the project until it is pushed.',
            parameters: {
                type: 'object',
                properties: {
                    repository: REPOSITORY_PARAM,
                    branch: BRANCH_PARAM,
                    message: { type: 'string', description: 'One short paragraph: what changed and why.' },
                    paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths of the files to commit, each inside repos/<name>/.' }
                },
                required: ['repository', 'branch', 'message', 'paths']
            }
        },
        needs: needsFor('repo.commit'),
        guard,
        _text: (commit, branch, repo) => `Committed ${commit.short} on ${branch} in ${repo}. It is in the project's clone only until it is pushed.`,
        /** After a crash: a commit on that branch carrying this operation's trailer means it happened. */
        async reconcile({ repository, branch }, ctx) {
            const repos = repoService();
            if (!repos) return { state: 'unknown' };
            const found = await repos.findCommitByTrailer({ ...at(ctx, repository), branch, key: TRAILER, value: operationId(ctx) });
            if (!found) return { state: 'absent' };
            const row = await repos.status(at(ctx, repository));
            return { state: 'done', result: this._text(found, String(branch), row.repo) };
        },
        async run({ repository, branch, message, paths }, ctx) {
            const repos = repoService();
            if (!repos) return unavailable('committed');
            const prefix = `repos/${cloneName(repository)}/`;
            const list = (Array.isArray(paths) ? paths : []).map(entry => String(entry ?? '').trim().replace(/^\.?\/+/, '')).filter(Boolean);
            if (!list.length) return 'Not committed: name the files to commit in paths.';
            if (list.length > MAX_PATHS) return `Not committed: at most ${MAX_PATHS} paths in one commit.`;
            const outside = list.find(entry => !entry.startsWith(prefix) || entry.length === prefix.length);
            if (outside) return `Not committed: ${clip(outside, 200)} is not a file inside ${prefix}`;
            const where = at(ctx, repository);
            try {
                const current = await repos.status(where);
                // Switching takes a workspace-history snapshot first (ADR 0015).
                if (current.status?.branch !== branch) await repos.checkout({ ...where, branch });
                const commit = await repos.commit({
                    ...where, message, paths: list.map(entry => entry.slice(prefix.length)),
                    onBranch: branch, trailers: { [TRAILER]: operationId(ctx) }
                });
                if (!commit.committed) return 'Not committed: those paths have no changes to commit.';
                return this._text(commit, String(branch), commit.repo);
            } catch (error) {
                return declined(error, 'committed');
            }
        }
    },
    pushProjectRepo: {
        effect: 'write',
        budget: 'externalOperations',
        component: 'projects',
        publishes: 'external',
        available: offeredFor('repo.push'),
        definition: {
            name: 'pushProjectRepo',
            description: 'Push a work branch you committed to from the linked project\'s clone to GitHub, as the person. Never forced: if GitHub has commits the clone does not, the push is refused and you report that instead of trying again. A push cannot be undone from here and counts against a small daily budget of outside operations.',
            parameters: {
                type: 'object',
                properties: { repository: REPOSITORY_PARAM, branch: BRANCH_PARAM },
                required: ['repository', 'branch']
            }
        },
        needs: needsFor('repo.push'),
        guard,
        _text: (hash, branch, repo) => `Pushed ${branch} (${String(hash).slice(0, 7)}) to ${repo} on GitHub. That cannot be undone from here.`,
        /**
         * After a crash: ask GitHub where the branch is before anything is
         * pushed again. The same commit means it landed; nothing there, or an
         * older commit of this branch, means it did not; anything else is for
         * the person.
         */
        async reconcile({ repository, branch }, ctx) {
            const repos = repoService();
            if (!repos) return { state: 'unknown' };
            const heads = await repos.remoteHead({ ...at(ctx, repository), branch });
            if (heads.local && heads.remote === heads.local) return { state: 'done', result: this._text(heads.local, heads.branch, heads.repo) };
            if (!heads.remote || heads.remoteIsAncestor) return { state: 'absent' };
            return { state: 'unknown' };
        },
        async run({ repository, branch }, ctx) {
            const repos = repoService();
            if (!repos) return unavailable('pushed');
            const where = at(ctx, repository);
            let heads;
            try {
                heads = await repos.remoteHead({ ...where, branch });
            } catch (error) {
                return notAttempted(error, 'pushed');
            }
            if (!heads.local) return `Not pushed: the clone has no branch ${heads.branch} yet. Commit to it first.`;
            if (heads.remote === heads.local) return `Not pushed: GitHub already has ${heads.local.slice(0, 7)} on ${heads.branch}.`;
            if (heads.remote && !heads.remoteIsAncestor) return `Not pushed (REJECTED): ${DECLINED.REJECTED}.`;
            try {
                // Switching takes a workspace-history snapshot first (ADR 0015).
                if ((await repos.status(where)).status?.branch !== heads.branch) await repos.checkout({ ...where, branch: heads.branch });
                const pushed = await repos.push({ ...where, branch, onBranch: branch });
                return this._text(heads.local, pushed.branch, pushed.repo);
            } catch (error) {
                return declined(error, 'pushed');
            }
        }
    },
    openPullRequest: {
        effect: 'write',
        budget: 'externalOperations',
        component: 'projects',
        publishes: 'external',
        available: offeredFor('pr.create'),
        definition: {
            name: 'openPullRequest',
            description: 'Open a pull request on GitHub, as the person, from a work branch you already pushed into the branch the clone started from. It opens as a draft unless you pass draft false. One open pull request per branch. A pull request cannot be undone from here and counts against a small daily budget of outside operations.',
            parameters: {
                type: 'object',
                properties: {
                    repository: REPOSITORY_PARAM,
                    branch: BRANCH_PARAM,
                    title: { type: 'string', description: 'What the change does, in one line.' },
                    body: { type: 'string', description: 'What changed, why, and how it was checked.' },
                    draft: { type: 'boolean', description: 'Open as a draft (the default).' }
                },
                required: ['repository', 'branch', 'title']
            }
        },
        needs: needsFor('pr.create'),
        guard,
        _opened: (pr, branch, repo) => `Opened ${pr.draft ? 'draft ' : ''}pull request #${pr.number} for ${branch} on ${repo} (${pr.url}). That cannot be undone from here.`,
        _existing: (pr, branch) => `Not opened: pull request #${pr.number} is already open for ${branch}: ${pr.url}`,
        _footer: (ctx) => `Opened by ${assistantUser().username} under a responsibility delegated by this account.\n${TRAILER}: ${operationId(ctx)}`,
        /**
         * After a crash: an open pull request for the branch settles it. One
         * carrying this operation's footer is the one this call opened.
         */
        async reconcile({ repository, branch }, ctx) {
            const repos = repoService();
            if (!repos) return { state: 'unknown' };
            const where = at(ctx, repository);
            const pr = await repos.openPullRequestFor({ ...where, branch });
            if (!pr) return { state: 'absent' };
            const mine = pr.body.includes(`${TRAILER}: ${operationId(ctx)}`);
            const row = await repos.status(where);
            return { state: 'done', result: mine ? this._opened(pr, String(branch), row.repo) : this._existing(pr, String(branch)) };
        },
        async run({ repository, branch, title, body, draft }, ctx) {
            const repos = repoService();
            if (!repos) return unavailable('opened');
            const where = at(ctx, repository);
            let existing;
            let heads;
            try {
                existing = await repos.openPullRequestFor({ ...where, branch });
                if (!existing) heads = await repos.remoteHead({ ...where, branch });
            } catch (error) {
                return notAttempted(error, 'opened');
            }
            if (existing) return this._existing(existing, String(branch));
            if (!heads.remote) return `Not opened: ${heads.branch} is not on GitHub yet. Push it first.`;
            if (heads.local && heads.remote !== heads.local) {
                return `Not opened: ${heads.branch} on GitHub is not the commit in the clone. Push it first, or report the difference.`;
            }
            try {
                const text = clip(String(body ?? '').trim(), BODY_CHARS);
                const created = await repos.createPullRequest({
                    ...where, title, head: branch, draft: draft !== false, push: false,
                    body: `${text ? `${text}\n\n` : ''}${this._footer(ctx)}`
                });
                return this._opened(created, created.head, created.repo);
            } catch (error) {
                return declined(error, 'opened');
            }
        }
    }
};
