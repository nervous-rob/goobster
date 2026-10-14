/**
 * The project timeline (documentation/projects.md, "Timeline"): one feed of
 * what happened on a project and who did it, merged at read time from the
 * records that already exist. Nothing new is stored:
 *
 *   snapshot   workspace history commits (projectHistoryService), minus the
 *              "before ..." safety snapshots and the per-run ones (runs
 *              have their own entries)
 *   run        observatory_jobs, one entry per run at its settle (or start)
 *   repo       integration_audit rows of the project's clones: clone, push,
 *              merge, rebase, pull request
 *   plan       project_mission_events of the project's missions
 *
 * Each entry names its actor as a person (by display name), Goobster, or
 * an automation. Paged by time: `before` is the oldest `at` of the last
 * page; a page never ends inside a same-second group, so nothing is
 * skipped at the boundary.
 */

const db = require('../db');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const KINDS = Object.freeze(['snapshot', 'run', 'repo', 'plan']);
const HISTORY_SCAN = 500;

/** Any stored time (SQLite text, ISO, Postgres) as 'YYYY-MM-DD HH:MM:SS' UTC. */
function utc(value) {
    if (!value) return null;
    const text = value instanceof Date ? value.toISOString() : String(value);
    const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function parseJson(text) {
    try { return text ? JSON.parse(text) : null; } catch { return null; }
}

const RUN_WORDS = {
    COMPLETED: 'completed', FAILED: 'failed', TIMED_OUT: 'timed out', CANCELLED: 'was cancelled',
    INTERRUPTED: 'was interrupted', RUNNING: 'started'
};

const PLAN_WORDS = {
    created: 'drafted the plan', updated: 'revised the plan', approved: 'approved the plan', started: 'started the plan',
    cancelled: 'cancelled the plan', resumed: 'resumed the plan', completed: 'completed the plan', complete: 'completed the plan',
    review_submitted: 'submitted the plan for review', evidence_added: 'added evidence',
    step_added: 'added step', step_started: 'started step', step_done: 'finished step', step_skipped: 'skipped step',
    step_retried: 'retried step', step_linked: 'linked work to step', step_code_linked: 'linked code to step',
    blocked: 'plan blocked', unblocked: 'plan unblocked', review: 'plan ready for review'
};

class ProjectTimelineService {
    constructor({ projects = null } = {}) {
        this._projects = projects;
    }

    get projects() {
        if (!this._projects) this._projects = require('./projectService');
        return this._projects;
    }

    async _names(ids) {
        const names = new Map();
        for (const id of ids) {
            if (!id || names.has(id)) continue;
            try { names.set(id, (await this.projects._displayName(id)) || 'someone'); } catch { names.set(id, 'someone'); }
        }
        return names;
    }

    /**
     * @param {Object} params
     * @param {string} [params.before] only entries strictly older than this UTC time
     * @param {string[]} [params.kinds] subset of KINDS
     * @returns {Promise<{ project: string, entries: object[], nextBefore: string|null }>}
     */
    async timeline({ userId, project, owner = null, before = null, limit = DEFAULT_LIMIT, kinds = null }) {
        const row = await this.projects.resolveProjectForActor({ userId, project, owner });
        const max = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
        const cutoff = utc(before) || '9999-12-31 23:59:59';
        const wanted = new Set((Array.isArray(kinds) && kinds.length ? kinds : KINDS).filter(kind => KINDS.includes(kind)));
        const fetch = max + 1;
        const entries = [];
        const people = new Set();
        // Each source reads at most `fetch` entries, finishing the second it
        // stopped in. When it stopped early it reports that second: nothing
        // older than the newest such second may be shown on this page, or
        // its unread neighbours would be skipped by the next one.
        const stops = [];

        /** Rows of one SQL source: `timeSql` is its time expression. */
        const readSql = async ({ select, from, where, timeSql, order, params }) => {
            const rows = await db.all(
                `SELECT ${select}, ${timeSql} AS at_ FROM ${from} WHERE ${where} AND ${timeSql} < @cutoff ORDER BY ${order} LIMIT ${fetch}`,
                { ...params, cutoff }
            );
            if (rows.length < fetch) return rows;
            const lastAt = rows[rows.length - 1].at_;
            const seen = new Set(rows.map(r => JSON.stringify(r)));
            const rest = await db.all(
                `SELECT ${select}, ${timeSql} AS at_ FROM ${from} WHERE ${where} AND ${timeSql} = @lastAt ORDER BY ${order} LIMIT 500`,
                { ...params, lastAt }
            );
            for (const r of rest) if (!seen.has(JSON.stringify(r))) rows.push(r);
            stops.push(utc(lastAt));
            return rows;
        };

        if (wanted.has('snapshot')) {
            try {
                const log = await this.projects.history.log({ row, userId, limit: HISTORY_SCAN });
                const commits = log.commits || [];
                let kept = 0;
                let stopAt = null;
                for (const commit of commits) {
                    const message = String(commit.message || '');
                    if (/^(before |job #\d+ |run #\d+ )/.test(message)) continue;
                    const at = utc(commit.when);
                    if (!at || at >= cutoff) continue;
                    if (stopAt && at !== stopAt) break;
                    if (++kept === fetch) stopAt = at;
                    const author = commit.author || {};
                    entries.push({
                        id: `snapshot:${commit.hash}`, kind: 'snapshot', at,
                        actor: author.role === 'system' ? { type: 'goobster', name: 'Goobster' } : { type: 'person', name: author.name || 'someone' },
                        title: message || 'snapshot',
                        detail: commit.fileCount ? `${commit.fileCount} file(s)` : null,
                        ref: { rev: commit.hash, short: commit.short }
                    });
                }
                if (stopAt) stops.push(stopAt);
                else if (commits.length >= HISTORY_SCAN) stops.push(utc(commits[commits.length - 1].when));
            } catch { /* history off or empty */ }
        }

        if (wanted.has('run')) {
            const jobs = await readSql({
                select: 'j.id, j.userId, j.status, j.exitCode, j.errorCode, j.startedBy, j.triggerId, t.name AS triggerName',
                from: 'observatory_jobs j LEFT JOIN project_triggers t ON t.id = j.triggerId',
                where: 'j.projectId = @projectId',
                timeSql: 'COALESCE(j.finishedAt, j.createdAt)',
                order: 'COALESCE(j.finishedAt, j.createdAt) DESC, j.id DESC',
                params: { projectId: row.id }
            });
            for (const job of jobs) {
                const automated = job.startedBy === 'trigger' || job.triggerId != null;
                if (!automated) people.add(job.userId);
                entries.push({
                    id: `run:${job.id}`, kind: 'run', at: utc(job.at_),
                    actor: automated
                        ? { type: 'automation', name: job.triggerName ? `trigger “${job.triggerName}”` : 'a trigger' }
                        : job.startedBy === 'chat'
                            ? { type: 'goobster', id: job.userId, onBehalf: true }
                            : { type: 'person', id: job.userId },
                    title: `Run #${job.id} ${RUN_WORDS[job.status] || String(job.status).toLowerCase()}`,
                    detail: job.exitCode != null && job.status !== 'COMPLETED' ? `exit ${job.exitCode}` : (job.errorCode || null),
                    status: job.status,
                    ref: { jobId: job.id }
                });
            }
        }

        if (wanted.has('repo')) {
            const members = new Set([String(row.ownerId ?? row.userId)]);
            for (const member of await db.all('SELECT userId FROM project_members WHERE projectId = @id', { id: row.id })) {
                members.add(String(member.userId));
            }
            const AUDIT_SCAN = 500;
            const rows = await db.all(
                `SELECT id, userId, action, detail, createdAt FROM integration_audit
                 WHERE action LIKE 'project-repo-%' AND createdAt < @cutoff
                 ORDER BY createdAt DESC, id DESC LIMIT ${AUDIT_SCAN}`,
                { cutoff }
            );
            let kept = 0;
            let stopAt = null;
            for (const audit of rows) {
                const detail = parseJson(audit.detail) || {};
                const mine = detail.projectId != null
                    ? Number(detail.projectId) === Number(row.id)
                    : detail.project === row.slug && audit.userId && members.has(String(audit.userId));
                if (!mine) continue;
                const at = utc(audit.createdAt);
                if (stopAt && at !== stopAt) break;
                if (++kept === fetch) stopAt = at;
                if (audit.userId) people.add(audit.userId);
                const action = String(audit.action).replace('project-repo-', '');
                const title = action === 'clone' ? `Cloned ${detail.repo}${detail.branch ? ` (${detail.branch})` : ''}`
                    : action === 'push' ? `Pushed ${detail.branch} to ${detail.repo}`
                        : action === 'pr' ? `Opened pull request #${detail.number} on ${detail.repo} (${detail.head} → ${detail.base})`
                            : action === 'merge' ? `Merged ${detail.base} into ${detail.branch} (${detail.repo})`
                                : action === 'rebase' ? `Rebased ${detail.branch} onto ${detail.base} (${detail.repo})`
                                    : `${action} on ${detail.repo}`;
                entries.push({
                    id: `repo:${audit.id}`, kind: 'repo', at,
                    actor: audit.userId ? { type: 'person', id: audit.userId } : { type: 'person', name: 'someone erased' },
                    title, detail: detail.head ? `head ${detail.head}` : null,
                    ref: { repo: detail.repo || null, branch: detail.branch || detail.head || null, number: detail.number || null }
                });
            }
            if (stopAt) stops.push(stopAt);
            else if (rows.length >= AUDIT_SCAN) stops.push(utc(rows[rows.length - 1].createdAt));
        }

        if (wanted.has('plan')) {
            const events = await readSql({
                select: 'e.id, e.userId, e.kind, e.payloadJson, m.title AS missionTitle',
                from: 'project_mission_events e JOIN project_missions m ON m.id = e.missionId',
                where: 'm.projectId = @projectId',
                timeSql: 'e.createdAt',
                order: 'e.createdAt DESC, e.id DESC',
                params: { projectId: row.id }
            });
            const stepIds = [...new Set(events.map(event => parseJson(event.payloadJson)?.stepId).filter(id => id != null).map(Number))]
                .filter(Number.isFinite);
            const stepTitles = new Map();
            if (stepIds.length) {
                const steps = await db.all(`SELECT id, title FROM project_mission_steps WHERE id IN (${stepIds.join(',')})`);
                for (const step of steps) stepTitles.set(Number(step.id), step.title);
            }
            for (const event of events) {
                const payload = parseJson(event.payloadJson) || {};
                const step = payload.stepId != null ? stepTitles.get(Number(payload.stepId)) : null;
                const human = event.userId && !/^(system|goobster)$/i.test(String(event.userId));
                if (human) people.add(event.userId);
                entries.push({
                    id: `plan:${event.id}`, kind: 'plan', at: utc(event.at_),
                    actor: human ? { type: 'person', id: event.userId } : { type: 'goobster', name: 'Goobster' },
                    title: `${PLAN_WORDS[event.kind] || String(event.kind).replace(/_/g, ' ')}${step ? ` “${step}”` : ''}`,
                    detail: payload.branch ? `${payload.repoName}:${payload.branch}${payload.requireGreenCi ? ' (needs green CI)' : ''}` : (payload.note || payload.reason || null),
                    ref: { missionTitle: event.missionTitle, stepId: payload.stepId ?? null }
                });
            }
        }

        entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
        const floor = stops.length ? stops.reduce((a, b) => (a > b ? a : b)) : null;
        let page = floor ? entries.filter(entry => entry.at >= floor) : entries;
        let more = Boolean(floor) && page.length < entries.length;
        if (page.length > max) {
            // Never end a page inside a same-second group.
            const lastAt = page[max - 1].at;
            let end = max;
            while (end < page.length && page[end].at === lastAt) end++;
            more = more || end < page.length;
            page = page.slice(0, end);
        }
        if (floor && !more) more = true;
        const names = await this._names([...people]);
        for (const entry of page) {
            if (entry.actor.onBehalf) {
                entry.actor.name = `Goobster (for ${names.get(entry.actor.id) || 'someone'})`;
                delete entry.actor.onBehalf;
            } else if (entry.actor.id && !entry.actor.name) {
                entry.actor.name = names.get(entry.actor.id) || 'someone';
            }
            delete entry.actor.id;
        }
        return {
            project: row.slug,
            entries: page,
            nextBefore: more && page.length ? page[page.length - 1].at : null
        };
    }
}

module.exports = new ProjectTimelineService();
module.exports.ProjectTimelineService = ProjectTimelineService;
module.exports.KINDS = KINDS;
module.exports.utc = utc;
