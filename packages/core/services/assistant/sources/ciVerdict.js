/**
 * Source adapter `ci_verdict` (DA-8, ADR 0026): a settled CI verdict on a
 * branch the person watches.
 *
 * The CI watch (`projectCiWatchService`) already polls GitHub with the
 * person's own connection and stores the head commit and the verdict
 * `ProjectRepoService.summarizeChecks` gave it. This adapter reads that row;
 * it never calls GitHub and never holds a token.
 *
 * What is an opportunity:
 *  - `failure` on a head commit it has not seen fail, or
 *  - `success` after the branch was last settled as `failure`.
 * What is not: `pending`, `incomplete`, `none` - and `skipped`, which is
 * evidence of nothing and so is neither a pass nor a recovery. Those are
 * observed (the cursor moves, nothing is proposed) and they do not erase the
 * memory that the branch was red.
 *
 * A watch in `fix` mode belongs to the watch: it already starts its own
 * repair turn and files its own Inbox item when it gives up, so this adapter
 * leaves its verdicts alone.
 *
 * The first look at a watch records where it stands and proposes nothing: a
 * branch that was already red when the person delegated is history.
 *
 * Requires: `scopes.sources` includes `ci_verdict`, and a `read` grant on the
 * repository (`kind: repository`, the repo, the project, optionally the
 * branches). The cursor remembers `v1|<sha>|<state>|<last settled state>`.
 */

const db = require('../../../db');
const access = require('./access');

const KIND = 'ci_verdict';
const SCOPE = 'ci_verdict';
const CAPABILITY = 'sources';
const MAX_PER_DAY = 3;
const SETTLED = new Set(['success', 'failure']);

/** @returns {{ sha: string, state: string, settled: string }|null} */
function parseCursor(value) {
    const parts = String(value || '').split('|');
    if (parts[0] !== 'v1' || parts.length !== 4) return null;
    return { sha: parts[1], state: parts[2], settled: parts[3] };
}

/** The watches this responsibility may read, with their repository. */
async function readable(responsibility, { preview = false } = {}) {
    if (!access.scoped(responsibility, KIND)) return [];
    const actor = access.actorOf(responsibility);
    const out = [];
    for (const resource of access.grants(responsibility, 'read', 'repository')) {
        for (const repo of resource.ids || []) {
            const watches = await db.all(
                `SELECT w.*, r.repo AS repoName, r.name AS cloneName FROM project_ci_watches w
                 JOIN project_repos r ON r.id = w.repoId
                 WHERE w.userId = @actor AND w.projectId = @projectId AND LOWER(r.repo) = @repo ORDER BY w.id`,
                { actor, projectId: Number(resource.projectId), repo: String(repo).toLowerCase() }
            );
            for (const watch of watches) {
                if (await access.permits(responsibility, 'read', {
                    kind: 'repository', id: String(repo).toLowerCase(), projectId: String(resource.projectId), branch: watch.branch
                }, { preview })) out.push(watch);
            }
        }
    }
    return out;
}

module.exports = {
    KIND,
    SCOPE,
    capability: CAPABILITY,
    learns: true,
    MAX_PER_DAY,
    parseCursor,

    dailyCap() { return MAX_PER_DAY; },

    async read(responsibility, { cursors = new Map() } = {}) {
        const out = [];
        for (const watch of await readable(responsibility)) {
            if (!watch.lastSha || !watch.lastState) continue;
            const sourceId = `watch:${Number(watch.id)}`;
            const before = parseCursor(cursors.get(sourceId)?.sourceRevision);
            const state = String(watch.lastState);
            const settled = SETTLED.has(state) ? state : (before?.settled || 'none');
            const moved = before && !(before.sha === watch.lastSha && before.state === state);
            let reason = null;
            if (moved && watch.mode === 'notify') {
                if (state === 'failure') reason = 'failed';
                else if (state === 'success' && before.settled === 'failure') reason = 'recovered';
            }
            const where = `${watch.repoName} ${watch.branch}`.slice(0, 160);
            out.push({
                sourceId,
                revision: `${watch.lastSha}:${state}`,
                cursorRevision: ['v1', watch.lastSha, state, settled].join('|'),
                observe: !reason,
                title: reason === 'recovered' ? `CI is green again on ${where}` : `CI failed on ${where}`,
                reason: reason === 'recovered' ? 'a watched branch recovered after failing' : 'a watched branch failed CI',
                category: 'github',
                origin: {
                    kind: 'ci_verdict', watchId: Number(watch.id), projectId: Number(watch.projectId),
                    repo: watch.repoName, clone: watch.cloneName, branch: watch.branch, sha: watch.lastSha, state, recovered: reason === 'recovered'
                }
            });
        }
        return out;
    },

    /**
     * Proposed or queued attempts whose verdict no longer stands: the watch
     * is gone, the branch moved to a newer commit, or the grant stopped
     * covering it.
     */
    async stale(responsibility) {
        const out = [];
        for (const attempt of await access.openAttempts(db, responsibility, KIND)) {
            const found = await module.exports.locate(responsibility, attempt.origin);
            if (!found.ok) out.push({ id: attempt.id, code: found.code });
        }
        return out;
    },

    /**
     * The watch an attempt came from and where it stands now.
     * @returns {Promise<{ ok: true, watch: Object, moved: boolean }
     *   | { ok: false, code: 'SOURCE_GONE'|'SOURCE_NOT_COVERED'|'SOURCE_MOVED' }>}
     */
    async locate(responsibility, originValue) {
        const origin = access.originOf(originValue);
        if (!origin || origin.kind !== 'ci_verdict') return { ok: false, code: 'SOURCE_GONE' };
        const watch = await db.get(
            `SELECT w.*, r.repo AS repoName, r.name AS cloneName FROM project_ci_watches w JOIN project_repos r ON r.id = w.repoId
             WHERE w.id = @id AND w.userId = @actor AND w.projectId = @projectId`,
            { id: Number(origin.watchId), actor: access.actorOf(responsibility), projectId: Number(origin.projectId) }
        );
        if (!watch) return { ok: false, code: 'SOURCE_GONE' };
        if (!access.scoped(responsibility, KIND) || !(await access.permits(responsibility, 'read', {
            kind: 'repository', id: String(watch.repoName).toLowerCase(), projectId: String(watch.projectId), branch: watch.branch
        }))) return { ok: false, code: 'SOURCE_NOT_COVERED' };
        // A newer head commit replaces the verdict this attempt was about.
        if (watch.lastSha !== origin.sha) return { ok: false, code: 'SOURCE_MOVED' };
        return { ok: true, watch };
    },

    /** Branches that are already red when the owner delegates are history. */
    async lookback(responsibility) {
        const watches = await readable(responsibility, { preview: true });
        const red = watches.filter(watch => watch.lastState === 'failure');
        return {
            sources: watches.length,
            ignored: red.length,
            examples: red.slice(0, 3).map(watch => `CI failed on ${watch.repoName} ${watch.branch}`.slice(0, 160))
        };
    }
};
