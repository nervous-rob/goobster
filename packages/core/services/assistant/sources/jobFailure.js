/**
 * Source adapter `job_failure` (DA-8, ADR 0026): a failed background run in
 * the project a responsibility is linked to, once per failure cause.
 *
 * A cause is not a message: three retries of one broken script are one
 * problem, and a changed line number or a different timestamp does not make
 * a new one. `causeOf()` defines it deterministically from what a failed
 * job recorded:
 *
 *     status (FAILED | TIMED_OUT), exit code, the exception class on the
 *     last stderr line, and the last file in the stack that is the person's
 *     own (not a library) - or, when the output names neither, the language
 *     and asset version that ran.
 *
 * A cause is new when no earlier failure in the project (inside the last
 * `KNOWN_DAYS`) has it. Failures from before the responsibility existed are
 * history: the first look records where the job log ends and proposes
 * nothing.
 *
 * Which jobs count: those the acting person started. A job another member
 * started is theirs to investigate. Jobs the assistant itself ran, and the
 * children of a plan step (which have their own failure handling), are never
 * a new opportunity; a cancelled or interrupted job is not a failure.
 *
 * Stream adapter, one cursor per responsibility (`sourceId` "jobs", revision
 * the highest job id examined). The cursor never passes a job that is still
 * running, so a job that finishes late is read when it finishes.
 *
 * Requires: `scopes.sources` includes `job_failure`, a `read` grant on the
 * linked project, and that the person still has access to it.
 */

const db = require('../../../db');
const { features } = require('../../../features/featureState');
const { fingerprint } = require('./fingerprint');
const access = require('./access');

const KIND = 'job_failure';
const SCOPE = 'job_failure';
const CAPABILITY = 'sources';
const STREAM_ID = 'jobs';
const MAX_PER_DAY = 3;
const OPEN_LIMIT = 10;
const SCAN_LIMIT = 200;
/** A failure this long ago (or longer) is not "the same cause" as one today. */
const KNOWN_DAYS = 30;
const KNOWN_LIMIT = 500;
/** A job that has been running or interrupted longer than this does not hold the cursor back. */
const STUCK_MS = 24 * 60 * 60 * 1000;
/** A failure older than this when it is first read is not acted on. */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const LIBRARY = /(?:site-packages|dist-packages|node_modules|node:internal|\/usr\/(?:local\/)?lib|\/lib\/python|<frozen|<string>|<stdin>)/;
const EXCEPTION_LINE = /^(?:Uncaught\s+)?(?:[\w.$]*\.)?([A-Za-z_][\w$]*(?:Error|Exception|Exit|Interrupt))\b/;
const PY_FRAME = /File "([^"]+)", line \d+/g;
const JS_FRAME = /(?:\(|\s)((?:\/|[A-Za-z]:\\)?[^\s():]+\.(?:m?js|cjs|ts|py|sh|rb|jl|R)):\d+(?::\d+)?\)?/g;

function utcText(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** A path as the person's own project names it: no host directories, no sandbox mount points. */
function ownFile(path) {
    const text = String(path).replace(/\\/g, '/');
    const marked = text.match(/(?:^|\/)(?:workspace|project|work|sandbox)\/(.+)$/);
    const relative = (marked ? marked[1] : text).replace(/^\.\//, '');
    return relative.split('/').filter(Boolean).slice(-3).join('/').slice(0, 120);
}

/**
 * The deterministic identity of why a job failed.
 * @param {{ status: string, exitCode: number|null, language: string, assetVersionId: number|null, stderrTail: string|null, error: string|null }} job
 * @returns {{ cause: string, kind: string|null, file: string|null }}
 */
function causeOf(job) {
    const text = String(job.stderrTail || job.error || '');
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    let kind = null;
    for (let i = lines.length - 1; i >= 0 && !kind; i--) {
        const match = EXCEPTION_LINE.exec(lines[i]);
        if (match) kind = match[1];
    }
    let file = null;
    const frames = [];
    for (const regex of [PY_FRAME, JS_FRAME]) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text))) {
            if (!LIBRARY.test(match[1])) frames.push({ at: match.index, file: match[1] });
        }
    }
    if (frames.length) file = ownFile(frames.sort((a, b) => a.at - b.at)[frames.length - 1].file);
    const origin = kind || file ? '' : `${job.language || ''}:${job.assetVersionId ?? ''}`;
    return {
        kind, file,
        cause: fingerprint([job.status, job.exitCode ?? '', kind || '', file || '', origin])
    };
}

/** Does the responsibility cover this project's jobs, and may the person still see it? */
async function covered(responsibility, { preview = false } = {}) {
    if (!access.scoped(responsibility, KIND) || responsibility.projectId == null || features.enforcedOff('projects')) return false;
    return access.permits(responsibility, 'read', { kind: 'project', id: String(responsibility.projectId) }, { preview });
}

const OWN_JOB = `j.userId = @actor AND (j.startedBy IS NULL OR j.startedBy <> 'assistant') AND j.executionAttemptId IS NULL`;

module.exports = {
    KIND,
    SCOPE,
    capability: CAPABILITY,
    learns: true,
    stream: true,
    STREAM_ID,
    OPEN_LIMIT,
    MAX_PER_DAY,
    KNOWN_DAYS,
    causeOf,

    dailyCap() { return MAX_PER_DAY; },

    async read(responsibility, { cursor = null, now = new Date() } = {}) {
        if (!(await covered(responsibility))) return null;
        const actor = access.actorOf(responsibility);
        const projectId = Number(responsibility.projectId);
        const last = cursor ? Number(cursor.sourceRevision) || 0 : 0;
        const stuckBefore = utcText(new Date(now.getTime() - STUCK_MS));
        const live = await db.get(
            `SELECT MIN(id) AS first FROM observatory_jobs
             WHERE projectId = @projectId AND id > @last AND status IN ('RUNNING', 'INTERRUPTED') AND createdAt > @stuckBefore`,
            { projectId, last, stuckBefore }
        );
        const top = await db.get('SELECT MAX(id) AS top FROM observatory_jobs WHERE projectId = @projectId', { projectId });
        let ceiling = live?.first != null ? Number(live.first) - 1 : Number(top?.top || 0);
        if (!cursor) {
            // Everything up to here, a job still running included, started before the delegation.
            return { sourceId: STREAM_ID, revision: String(Number(top?.top || 0)), events: [] };
        }
        const rows = await db.all(
            `SELECT j.id, j.status, j.exitCode, j.language, j.assetVersionId, j.stderrTail, j.error, j.finishedAt, j.createdAt
             FROM observatory_jobs j
             WHERE j.projectId = @projectId AND j.id > @last AND j.id <= @ceiling AND j.status IN ('FAILED', 'TIMED_OUT') AND ${OWN_JOB}
             ORDER BY j.id ASC LIMIT @limit`,
            { projectId, last, ceiling: Math.max(last, ceiling), actor, limit: SCAN_LIMIT }
        );
        if (rows.length === SCAN_LIMIT) ceiling = Math.min(ceiling, Number(rows[rows.length - 1].id));
        const revision = Math.max(last, ceiling);
        if (!rows.length) return { sourceId: STREAM_ID, revision: String(revision), events: [] };

        const known = new Set();
        const earlier = await db.all(
            `SELECT j.status, j.exitCode, j.language, j.assetVersionId, j.stderrTail, j.error FROM observatory_jobs j
             WHERE j.projectId = @projectId AND j.id <= @last AND j.status IN ('FAILED', 'TIMED_OUT') AND ${OWN_JOB}
               AND COALESCE(j.finishedAt, j.createdAt) >= @since
             ORDER BY j.id DESC LIMIT @limit`,
            { projectId, last, actor, since: utcText(new Date(now.getTime() - KNOWN_DAYS * 86400000)), limit: KNOWN_LIMIT }
        );
        for (const job of earlier) known.add(causeOf(job).cause);

        const oldest = utcText(new Date(now.getTime() - MAX_AGE_MS));
        const events = [];
        for (const job of rows) {
            const { cause } = causeOf(job);
            if (known.has(cause)) continue;
            known.add(cause);
            if (String(job.finishedAt || job.createdAt) < oldest) continue;
            events.push({
                propose: true,
                sourceId: `${projectId}:${cause}`,
                revision: cause,
                title: `A ${job.language || 'project'} run failed${job.status === 'TIMED_OUT' ? ' (timed out)' : ''}`,
                reason: 'a new cause of failure in a project run',
                category: 'observatory',
                origin: { kind: 'job_failure', projectId, jobId: Number(job.id), cause, status: job.status, exitCode: job.exitCode ?? null }
            });
        }
        return { sourceId: STREAM_ID, revision: String(revision), events };
    },

    /** Open attempts whose project is no longer covered, or whose job is gone. */
    async stale(responsibility) {
        const out = [];
        for (const attempt of await access.openAttempts(db, responsibility, KIND)) {
            const found = await module.exports.locate(responsibility, attempt.origin);
            if (!found.ok) out.push({ id: attempt.id, code: found.code });
        }
        return out;
    },

    /**
     * The failed job an attempt came from, as it is now.
     * @returns {Promise<{ ok: true, job: Object } | { ok: false, code: 'SOURCE_GONE'|'SOURCE_NOT_COVERED' }>}
     */
    async locate(responsibility, originValue) {
        const origin = access.originOf(originValue);
        if (!origin || origin.kind !== 'job_failure') return { ok: false, code: 'SOURCE_GONE' };
        if (Number(origin.projectId) !== Number(responsibility.projectId) || !(await covered(responsibility))) {
            return { ok: false, code: 'SOURCE_NOT_COVERED' };
        }
        const job = await db.get(
            `SELECT j.id, j.projectId, j.status, j.exitCode, j.language, j.assetVersionId, j.stderrTail, j.stdoutTail, j.error, j.createdAt, j.finishedAt
             FROM observatory_jobs j WHERE j.id = @id AND j.projectId = @projectId AND ${OWN_JOB}`,
            { id: Number(origin.jobId), projectId: Number(origin.projectId), actor: access.actorOf(responsibility) }
        );
        if (!job) return { ok: false, code: 'SOURCE_GONE' };
        return { ok: true, job };
    },

    /** Failed runs of the last days, which count as history: only a failure after activation is new. */
    async lookback(responsibility, { now = new Date() } = {}) {
        if (!(await covered(responsibility, { preview: true }))) return { sources: 0, ignored: 0, examples: [] };
        const rows = await db.all(
            `SELECT j.id, j.status, j.exitCode, j.language, j.assetVersionId, j.stderrTail, j.error FROM observatory_jobs j
             WHERE j.projectId = @projectId AND j.status IN ('FAILED', 'TIMED_OUT') AND ${OWN_JOB} AND COALESCE(j.finishedAt, j.createdAt) >= @since
             ORDER BY j.id DESC LIMIT 100`,
            { projectId: Number(responsibility.projectId), actor: access.actorOf(responsibility), since: utcText(new Date(now.getTime() - MAX_AGE_MS)) }
        );
        const causes = new Map();
        for (const job of rows) if (!causes.has(causeOf(job).cause)) causes.set(causeOf(job).cause, job);
        return {
            sources: 1,
            ignored: causes.size,
            examples: [...causes.values()].slice(0, 3).map(job => `A ${job.language || 'project'} run failed${job.status === 'TIMED_OUT' ? ' (timed out)' : ''}`)
        };
    }
};
