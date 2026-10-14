/**
 * CI watches on project clones (documentation/projects.md, "CI watches"):
 * Goobster keeps an eye on a branch's GitHub CI for one person, with their
 * own GitHub connection, and tells them through the Inbox when each new
 * head commit settles. In `fix` mode a red build also starts an unattended
 * agent turn on the project (the same runner as a trigger's agent_prompt)
 * that reads the failure, fixes it in the clone, commits and pushes - at
 * most `maxFixes` times until the branch goes green again.
 *
 * Polled from the automation minute loop (automationService), a few due
 * watches per tick: GitHub has no push channel to a self-hosted bot, and
 * polling keeps it working behind NAT. A watch whose person lost access to
 * the project, or whose clone is gone, is deleted on its next check.
 */

const db = require('../db');
const logger = require('../utils/logger');
const { ProjectRepoService, ProjectRepoError, cleanBranch } = require('./projectRepoService');

const MODES = Object.freeze(['notify', 'fix']);
const CHECK_INTERVAL_MS = 5 * 60_000;
const PENDING_INTERVAL_MS = 2 * 60_000;
const ERROR_BACKOFF_MS = 60 * 60_000;
const SWEEP_LIMIT = 10;
const MAX_WATCHES_PER_PROJECT = 10;
const MAX_FIXES = 5;
const MAX_OUTCOME = 240;

function utcText(ms = Date.now()) {
    return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

class ProjectCiWatchService {
    /**
     * @param {Object} [deps]
     * @param {Object} [deps.repos] the ProjectRepoService (default: the projects service's)
     * @param {(params: Object) => Promise<void>} [deps.runAgent] runs the fix turn (default: projectTriggerService.runAgentPrompt)
     * @param {(item: Object) => Promise<void>} [deps.deliver] Inbox delivery (default: inboxService.deliver)
     */
    constructor({ repos = null, runAgent = null, deliver = null } = {}) {
        this._repos = repos;
        this._runAgent = runAgent;
        this._deliver = deliver;
    }

    get repos() {
        if (!this._repos) this._repos = require('./projectService').repos;
        return this._repos;
    }

    async _resolve({ userId, project, owner, name }) {
        const projectRow = await this.repos._resolve({ userId, project, owner });
        this.repos._requireEnabled();
        const repoRow = await this.repos._row(projectRow, name);
        return { projectRow, repoRow };
    }

    _serialize(row) {
        return {
            id: row.id, branch: row.branch, mode: row.mode, maxFixes: row.maxFixes, fixesUsed: row.fixesUsed,
            lastSha: row.lastSha ? String(row.lastSha).slice(0, 7) : null, lastState: row.lastState || null,
            lastOutcome: row.lastOutcome || null, nextCheckAt: row.nextCheckAt, createdAt: row.createdAt
        };
    }

    /** Watch (or re-arm) a branch of a clone for this person. Default branch: the clone's current one. */
    async watch({ userId, project = null, owner = null, name, branch = null, mode = 'notify', maxFixes = 2 }) {
        const { projectRow, repoRow } = await this._resolve({ userId, project, owner, name });
        if (!MODES.includes(mode)) throw new ProjectRepoError(400, 'BAD_MODE', `mode is one of ${MODES.join(', ')}.`);
        const fixes = Number.isInteger(Number(maxFixes)) ? Math.min(Math.max(Number(maxFixes), 0), MAX_FIXES) : 2;
        // The person's own connection and allowlist, checked now rather than on the first silent poll.
        await this.repos._api(userId, repoRow);
        let target = cleanBranch(branch);
        if (!target) target = (await this.repos._status(projectRow, repoRow.name)).branch || repoRow.branch;
        const existing = await db.get(
            'SELECT id FROM project_ci_watches WHERE repoId = @repoId AND userId = @userId AND branch = @branch',
            { repoId: repoRow.id, userId, branch: target }
        );
        if (!existing) {
            const count = (await db.get(
                'SELECT COUNT(*) AS c FROM project_ci_watches WHERE projectId = @projectId AND userId = @userId',
                { projectId: projectRow.id, userId }
            ))?.c || 0;
            if (count >= MAX_WATCHES_PER_PROJECT) {
                throw new ProjectRepoError(400, 'TOO_MANY_WATCHES', `At most ${MAX_WATCHES_PER_PROJECT} CI watches per project - remove one first.`);
            }
        }
        const row = await db.get(
            `INSERT INTO project_ci_watches (repoId, projectId, userId, branch, mode, maxFixes, nextCheckAt)
             VALUES (@repoId, @projectId, @userId, @branch, @mode, @maxFixes, datetime('now'))
             ON CONFLICT(repoId, userId, branch) DO UPDATE SET
                mode = excluded.mode, maxFixes = excluded.maxFixes, fixesUsed = 0, nextCheckAt = datetime('now')
             RETURNING *`,
            { repoId: repoRow.id, projectId: projectRow.id, userId, branch: target, mode, maxFixes: fixes }
        );
        return { project: projectRow.slug, name: repoRow.name, repo: repoRow.repo, ...this._serialize(row) };
    }

    /** Stop watching one branch (or every branch of the clone) for this person. */
    async unwatch({ userId, project = null, owner = null, name, branch = null }) {
        const { projectRow, repoRow } = await this._resolve({ userId, project, owner, name });
        const target = cleanBranch(branch);
        const removed = (await db.run(
            `DELETE FROM project_ci_watches WHERE repoId = @repoId AND userId = @userId ${target ? 'AND branch = @branch' : ''}`,
            { repoId: repoRow.id, userId, branch: target }
        )).changes;
        return { project: projectRow.slug, name: repoRow.name, repo: repoRow.repo, removed };
    }

    /** This person's watches on one clone. */
    async list({ userId, project = null, owner = null, name }) {
        const { projectRow, repoRow } = await this._resolve({ userId, project, owner, name });
        const rows = await db.all(
            'SELECT * FROM project_ci_watches WHERE repoId = @repoId AND userId = @userId ORDER BY branch',
            { repoId: repoRow.id, userId }
        );
        return { project: projectRow.slug, name: repoRow.name, repo: repoRow.repo, watches: rows.map(row => this._serialize(row)) };
    }

    async _update(id, fields) {
        const sets = Object.keys(fields).map(key => `${key} = @${key}`);
        await db.run(`UPDATE project_ci_watches SET ${sets.join(', ')} WHERE id = @id`, { id, ...fields });
    }

    _deliverItem(item) {
        if (this._deliver) return this._deliver(item);
        return require('./inboxService').deliver(item);
    }

    _agent(params) {
        if (this._runAgent) return this._runAgent(params);
        return require('./projectTriggerService').runAgentPrompt(params);
    }

    /** Check the due watches (a few per call). Never throws; returns how many were checked. */
    async sweep({ client = null, limit = SWEEP_LIMIT } = {}) {
        let due;
        try {
            due = await db.all(
                `SELECT * FROM project_ci_watches WHERE nextCheckAt <= @now ORDER BY nextCheckAt ASC, id ASC LIMIT ${Math.max(1, Number(limit) || SWEEP_LIMIT)}`,
                { now: utcText() }
            );
        } catch (error) {
            logger.warn?.(`[ci-watch] could not read due watches: ${error.message}`);
            return 0;
        }
        for (const watch of due) {
            try {
                await this.check(watch, { client });
            } catch (error) {
                await this._update(watch.id, {
                    lastOutcome: `error: ${String(error.message || error)}`.slice(0, MAX_OUTCOME),
                    nextCheckAt: utcText(Date.now() + ERROR_BACKOFF_MS)
                }).catch(() => {});
            }
        }
        return due.length;
    }

    /** One watch: read the branch head's CI, record it, notify on a newly settled verdict, maybe fix. */
    async check(watch, { client = null } = {}) {
        const repoRow = await db.get('SELECT * FROM project_repos WHERE id = @id', { id: watch.repoId });
        let projectRow = null;
        if (repoRow) {
            // Access is re-checked on every poll: owner or a current member only.
            const raw = await db.get('SELECT userId FROM observatory_projects WHERE id = @id', { id: watch.projectId });
            projectRow = raw
                ? await this.repos.projects.resolveProjectForActor({ userId: watch.userId, project: Number(watch.projectId), owner: raw.userId }).catch(() => null)
                : null;
        }
        if (!repoRow || !projectRow || projectRow.id !== watch.projectId) {
            // The clone is gone or the person lost access: the watch goes with it.
            await db.run('DELETE FROM project_ci_watches WHERE id = @id', { id: watch.id });
            return { removed: true };
        }

        let api;
        try {
            ({ api } = await this.repos._api(watch.userId, repoRow));
        } catch (error) {
            await this._update(watch.id, { lastOutcome: `paused: ${error.message}`.slice(0, MAX_OUTCOME), nextCheckAt: utcText(Date.now() + ERROR_BACKOFF_MS) });
            return { paused: true };
        }
        let head;
        try {
            head = await api.getBranch(repoRow.repo, watch.branch);
        } catch (error) {
            if (error?.code !== 'NOT_FOUND') throw this.repos._apiError(error, repoRow.repo);
            await this._update(watch.id, { lastOutcome: `waiting: ${watch.branch} is not on GitHub yet`, nextCheckAt: utcText(Date.now() + CHECK_INTERVAL_MS) });
            return { state: 'none' };
        }
        const sha = String(head?.commit?.sha || '');
        if (!sha) throw new Error('GitHub returned no head commit');
        let checks;
        try {
            checks = await api.getChecks(repoRow.repo, sha);
        } catch (error) {
            throw this.repos._apiError(error, repoRow.repo);
        }
        const ci = ProjectRepoService.summarizeChecks(checks);
        const settled = ci.state === 'success' || ci.state === 'failure';
        const isNew = settled && (sha !== watch.lastSha || ci.state !== watch.lastState);
        const fields = {
            lastSha: sha,
            lastState: ci.state,
            nextCheckAt: utcText(Date.now() + (ci.state === 'pending' ? PENDING_INTERVAL_MS : CHECK_INTERVAL_MS)),
            lastOutcome: `${ci.state} on ${sha.slice(0, 7)}`
        };
        if (!isNew) {
            await this._update(watch.id, fields);
            return { state: ci.state, sha, notified: false };
        }

        const where = `${repoRow.repo} ${watch.branch} (${sha.slice(0, 7)})`;
        const link = `/projects/${encodeURIComponent(projectRow.ownerId ?? projectRow.userId)}/${encodeURIComponent(projectRow.slug)}/code`;
        let fixing = false;
        if (ci.state === 'success') {
            fields.fixesUsed = 0;
            await this._deliverItem({
                userId: watch.userId, kind: 'project', title: `✅ CI passed on ${where}`.slice(0, 200),
                body: `All ${ci.passed} check(s) passed in project "${projectRow.name}".`,
                link, source: { type: 'ci_watch', id: watch.id }, dedupeKey: `ci-watch:${watch.id}:${sha}:success`
            });
        } else {
            const failing = ci.failing.slice(0, 8).map(f => `- ${f.name} (${f.conclusion})${f.summary ? `: ${f.summary}` : ''}`).join('\n');
            fixing = watch.mode === 'fix' && watch.fixesUsed < watch.maxFixes;
            const exhausted = watch.mode === 'fix' && !fixing;
            await this._deliverItem({
                userId: watch.userId, kind: 'project', title: `❌ CI failed on ${where}`.slice(0, 200),
                body: `${failing}\n\n${fixing
                    ? `Goobster is trying to fix it (attempt ${watch.fixesUsed + 1} of ${watch.maxFixes}).`
                    : exhausted ? `Goobster stopped after ${watch.maxFixes} fix attempt(s); it needs you.` : 'Open the Code view to look, or ask Goobster to fix it.'}`,
                link, source: { type: 'ci_watch', id: watch.id }, dedupeKey: `ci-watch:${watch.id}:${sha}:failure`
            });
            if (fixing) {
                fields.fixesUsed = watch.fixesUsed + 1;
                fields.lastOutcome = `failure on ${sha.slice(0, 7)}; fix attempt ${fields.fixesUsed}/${watch.maxFixes} started`;
            }
        }
        await this._update(watch.id, fields);
        if (fixing) {
            const prompt = [
                `CI failed on branch ${watch.branch} of ${repoRow.repo} at ${sha.slice(0, 7)} (clone repos/${repoRow.name}).`,
                'Failing checks:',
                ...ci.failing.slice(0, 8).map(f => `- ${f.name} (${f.conclusion})${f.summary ? `: ${f.summary}` : ''}${f.url ? ` ${f.url}` : ''}`),
                '',
                `1. observatory repo_status name=${repoRow.name}; if it is not on ${watch.branch}, repo_branch to it; repo_pull so it matches ${sha.slice(0, 7)}.`,
                `2. observatory repo_ci name=${repoRow.name} branch=${watch.branch} for the failure details, then read the relevant files.`,
                '3. Fix the cause in the workspace files; run what tests you can with the observatory "run" action.',
                `4. repo_commit with a message naming the fix, then repo_push. Never force anything.`,
                'If you cannot find or fix the cause, say exactly what is failing and why, and stop.'
            ].join('\n');
            try {
                await this._agent({
                    userId: watch.userId, name: `CI watch: ${repoRow.repo} ${watch.branch}`, kindLabel: 'a CI watch',
                    projectRow, prompt, client
                });
            } catch (error) {
                await this._update(watch.id, { lastOutcome: `fix attempt ${fields.fixesUsed} failed to start: ${error.message}`.slice(0, MAX_OUTCOME) });
            }
        }
        return { state: ci.state, sha, notified: true, fixing };
    }

    /** /forget-me: every watch the person set up. */
    async forgetUser(userId) {
        return (await db.run('DELETE FROM project_ci_watches WHERE userId = @userId', { userId })).changes;
    }

    async countUser(userId) {
        return (await db.get('SELECT COUNT(*) AS c FROM project_ci_watches WHERE userId = @userId', { userId }))?.c || 0;
    }
}

module.exports = new ProjectCiWatchService();
module.exports.ProjectCiWatchService = ProjectCiWatchService;
module.exports.MODES = MODES;
module.exports.MAX_WATCHES_PER_PROJECT = MAX_WATCHES_PER_PROJECT;
