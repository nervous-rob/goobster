/**
 * What a person's delegated responsibilities did over a period, and what
 * it cost (DA-6; documentation/delegated_pilot.md, "The outcome summary").
 *
 * One read model over records that already exist; it stores nothing. Per
 * responsibility it counts:
 *  - results code checked (a plan step whose files were verified, a repair
 *    whose check afterwards was clean), apart from results a run only
 *    reported (a finding, or "nothing needs you");
 *  - what was changed, what was asked of the person and how they answered,
 *    what was refused, undone, rolled back or stopped for review;
 *  - what left the portal (digest entries and contacts);
 *  - cost, read from the work ledger through costReportService: settled
 *    tokens of the runs, of the message labels judged for the
 *    responsibility and of the research a run started. That service ships
 *    with research expeditions; in an installation without them the runs'
 *    own token counts are used instead and the figure is marked as such.
 *
 * It does not decide whether a result was useful, whether an action was
 * wanted, or how responsive foreground chat stayed: those are the person's
 * to record, and `notMeasured` says so. It never counts notes created or
 * tool calls as success. It returns counts and names, never a title of a
 * finding, a prompt or a result text.
 */

const db = require('../db');
const runs = require('./assistantRunService');
const control = require('./assistantControlService');
const requireOptional = require('../utils/optionalModule').forModule(module);

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const DAY_MS = 86_400_000;
/** Statuses in which a responsibility is listed even when it did nothing in the period. */
const LIVE = new Set(['ACTIVE', 'PAUSED', 'NEEDS_REVIEW']);
/** What this summary cannot know; the pilot record has a line for each. */
const NOT_MEASURED = Object.freeze(['usefulness', 'unwanted_actions', 'foreground_responsiveness']);

const utcText = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const parse = (text, fallback) => { try { return JSON.parse(text || '') ?? fallback; } catch { return fallback; } };

class AssistantOutcomeError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'AssistantOutcomeError';
        this.code = code;
        this.status = status;
    }
}

function emptyCounts() {
    return {
        work: { proposed: 0, completed: 0, failed: 0, waiting: 0, open: 0, withdrawn: 0 },
        runs: { total: 0, completed: 0, failed: 0, waiting: 0, review: 0, cancelled: 0, running: 0 },
        verified: { planSteps: 0, repairs: 0, total: 0 },
        reported: { findings: 0, noChange: 0 },
        changes: { applied: 0, outside: 0 },
        notes: { proposed: 0, applied: 0, dismissed: 0, stale: 0, waiting: 0, direct: 0, undone: 0 },
        repairs: { applied: 0, verified: 0, succeeded: 0, failed: 0, rolledBack: 0 },
        requests: { asked: 0, answered: 0, open: 0 },
        refusals: { total: 0, byCode: {} },
        stopped: { total: 0, byCode: {} },
        review: 0,
        delivery: { updates: 0, digest: 0, contacts: 0 },
        cost: { tokens: 0, heldTokens: 0, searches: 0, computeSeconds: 0, resources: {}, failures: 0, provisional: false }
    };
}

function addCounts(into, from) {
    for (const [key, value] of Object.entries(from)) {
        if (typeof value === 'number') into[key] = (into[key] || 0) + value;
        else if (typeof value === 'boolean') into[key] = Boolean(into[key]) || value;
        else if (value && typeof value === 'object') {
            if (!into[key] || typeof into[key] !== 'object') into[key] = {};
            addCounts(into[key], value);
        }
    }
    return into;
}

function ratios(counts) {
    const per = (n) => (n > 0 ? Math.round(counts.cost.tokens / n) : null);
    return {
        // No result of that kind means no figure, never zero.
        tokensPerVerified: per(counts.verified.total),
        tokensPerResult: per(counts.verified.total + counts.reported.findings)
    };
}

class AssistantOutcomeService {
    /** The work ledger's cost report, or null in an installation without research expeditions. */
    _ledger() {
        return requireOptional('./costReportService', { feature: 'expeditions' });
    }

    /**
     * @param {Object} params
     * @param {string} params.userId   the person whose responsibilities are summarized
     * @param {number} [params.days]   length of the period ending now (1 to 90, default 14)
     * @param {Date} [params.from]     start of the period, instead of `days`
     * @param {Date} [params.to]       end of the period (default now)
     * @param {Date} [params.now]
     */
    async summarize({ userId, days = null, from = null, to = null, now = new Date() } = {}) {
        const owner = String(userId || '');
        if (!owner) throw new AssistantOutcomeError('BAD_REQUEST', 'A summary is for one person.');
        let length = DEFAULT_DAYS;
        if (days !== null && days !== undefined && days !== '') {
            length = Number(days);
            if (!Number.isSafeInteger(length) || length < 1 || length > MAX_DAYS) {
                throw new AssistantOutcomeError('BAD_PERIOD', `Choose a period of 1 to ${MAX_DAYS} days.`);
            }
        }
        const until = to instanceof Date ? to : now;
        const since = from instanceof Date ? from : new Date(until.getTime() - length * DAY_MS);
        if (!(since < until)) throw new AssistantOutcomeError('BAD_PERIOD', 'The period ends after it starts.');
        const window = { since: utcText(since), until: utcText(until) };
        const scope = { owner, ...window };
        const ledger = this._ledger();
        const source = ledger ? 'ledger' : 'runs';

        const responsibilities = await db.all(
            'SELECT id, title, status, revision, budgetsJson, rulesJson, projectId FROM assistant_responsibilities WHERE ownerUserId = @owner ORDER BY id',
            { owner }
        );
        const byId = new Map(responsibilities.map(row => [Number(row.id), { row, counts: emptyCounts(), models: new Map(), active: false }]));
        const entry = (id) => byId.get(Number(id)) || null;
        const touch = (id) => { const found = entry(id); if (found) found.active = true; return found; };

        // Work that was proposed in the period, by where it stands now.
        const work = await db.all(
            `SELECT responsibilityId AS rid, status, COUNT(*) AS n FROM assistant_initiatives
             WHERE ownerUserId = @owner AND createdAt >= @since AND createdAt <= @until GROUP BY responsibilityId, status`, scope
        );
        for (const row of work) {
            const found = touch(row.rid);
            if (!found) continue;
            const n = Number(row.n);
            found.counts.work.proposed += n;
            const slot = { COMPLETED: 'completed', FAILED: 'failed', WAITING: 'waiting', REVIEW: 'waiting', CANCELLED: 'withdrawn', SUPERSEDED: 'withdrawn' }[row.status] || 'open';
            found.counts.work[slot] += n;
        }

        // Runs that started in the period.
        const runRows = await db.all(
            `SELECT r.id, r.responsibilityId AS rid, r.status, r.outcome, r.stopCode, r.searches, r.computeSeconds, r.tokensUsed,
                    r.promptVersion, r.provider, r.model, i.planStepId
             FROM assistant_runs r LEFT JOIN assistant_initiatives i ON i.id = r.initiativeId
             WHERE r.ownerUserId = @owner AND r.startedAt >= @since AND r.startedAt <= @until ORDER BY r.id`, scope
        );
        const runOwner = new Map();
        for (const row of runRows) {
            const found = touch(row.rid);
            if (!found) continue;
            runOwner.set(String(row.id), found);
            const counts = found.counts;
            counts.runs.total += 1;
            const slot = { COMPLETED: 'completed', FAILED: 'failed', WAITING: 'waiting', REVIEW: 'review', CANCELLED: 'cancelled', RUNNING: 'running' }[row.status];
            if (slot) counts.runs[slot] += 1;
            if (row.status === 'COMPLETED') {
                // A plan-step run completes only after its files were verified against the workspace.
                if (row.planStepId != null) counts.verified.planSteps += 1;
                else if (row.outcome === 'NO_CHANGE') counts.reported.noChange += 1;
                else counts.reported.findings += 1;
            } else if (row.stopCode) {
                counts.stopped.total += 1;
                counts.stopped.byCode[row.stopCode] = (counts.stopped.byCode[row.stopCode] || 0) + 1;
            }
            counts.cost.searches += Number(row.searches || 0);
            counts.cost.computeSeconds += Number(row.computeSeconds || 0);
            if (source === 'runs') {
                // What the run reserved or spent, research it started included; not a settled figure.
                counts.cost.tokens += Number(row.tokensUsed || 0);
                if (Number(row.tokensUsed || 0) > 0) counts.cost.provisional = true;
            }
            const key = JSON.stringify([row.provider || null, row.model || null, row.promptVersion || null]);
            found.models.set(key, (found.models.get(key) || 0) + 1);
        }

        // What those runs did, from the journal: changes made, calls refused, writes left uncertain.
        const journal = await db.all(
            `SELECT o.runId, o.tool, o.effect, o.status, o.refusalCode,
                    CASE WHEN COALESCE(o.resultText, '') = '' OR o.resultText LIKE 'Not %' THEN 0 ELSE 1 END AS took
             FROM assistant_run_operations o JOIN assistant_runs r ON r.id = o.runId
             WHERE r.ownerUserId = @owner AND r.startedAt >= @since AND r.startedAt <= @until`, scope
        );
        for (const row of journal) {
            const found = runOwner.get(String(row.runId));
            if (!found) continue;
            const counts = found.counts;
            const spec = Object.prototype.hasOwnProperty.call(runs.TOOLS, row.tool) ? runs.TOOLS[row.tool] : null;
            if (row.status === 'REFUSED') {
                const code = row.refusalCode || 'REFUSED';
                counts.refusals.total += 1;
                counts.refusals.byCode[code] = (counts.refusals.byCode[code] || 0) + 1;
            } else if (row.status === 'UNCERTAIN') {
                counts.review += 1;
            } else if (row.status === 'SUCCEEDED' && row.effect === 'write' && Number(row.took) && !spec?.proposes && !spec?.quiet) {
                counts.changes.applied += 1;
                if (spec?.budget === 'externalOperations') counts.changes.outside += 1;
            }
        }

        // Changes to the person's saved notes: suggested, applied by them, dismissed, undone.
        const notes = await db.all(
            `SELECT responsibilityId AS rid, kind, status, COUNT(*) AS n FROM kg_change_sets
             WHERE userId = @owner AND responsibilityId IS NOT NULL AND createdAt >= @since AND createdAt <= @until
             GROUP BY responsibilityId, kind, status`, scope
        );
        for (const row of notes) {
            const found = touch(row.rid);
            if (!found) continue;
            const n = Number(row.n);
            const counts = found.counts.notes;
            if (row.kind === 'saved_note_edit') {
                counts.proposed += n;
                const slot = { APPLIED: 'applied', REJECTED: 'dismissed', STALE: 'stale', PROPOSED: 'waiting', REVERTED: 'undone' }[row.status];
                if (slot) counts[slot] += n;
                // An applied suggestion that was then undone was applied first.
                if (row.status === 'REVERTED') counts.applied += n;
            } else if (row.kind === 'direct_change') {
                counts.direct += n;
                if (row.status === 'REVERTED') counts.undone += n;
            }
        }

        // Repairs applied under the responsibility's grant, and how the check afterwards went.
        const repairs = await db.all(
            `SELECT responsibilityId AS rid, status, rollback, verifiedAt FROM assistant_process_repairs
             WHERE ownerUserId = @owner AND responsibilityId IS NOT NULL AND actorKind = 'assistant'
               AND appliedAt IS NOT NULL AND appliedAt >= @since AND appliedAt <= @until`, scope
        );
        for (const row of repairs) {
            const found = touch(row.rid);
            if (!found) continue;
            const counts = found.counts.repairs;
            counts.applied += 1;
            const held = row.verifiedAt && ['OBSERVING', 'SUCCEEDED'].includes(row.status);
            if (held) { counts.verified += 1; found.counts.verified.repairs += 1; }
            if (row.status === 'SUCCEEDED') counts.succeeded += 1;
            if (row.status === 'FAILED') counts.failed += 1;
            if (row.rollback === 'restored') counts.rolledBack += 1;
        }

        // What the person was told and asked, and what left the portal.
        const told = await db.all(
            `SELECT responsibilityId AS rid, COUNT(*) AS updates,
                    SUM(CASE WHEN gateJson IS NOT NULL THEN 1 ELSE 0 END) AS asked,
                    SUM(CASE WHEN gateJson IS NOT NULL AND gateResolvedAt IS NULL THEN 1 ELSE 0 END) AS waiting
             FROM assistant_updates
             WHERE audienceKind = 'user' AND audienceUserId = @owner AND responsibilityId IS NOT NULL
               AND createdAt >= @since AND createdAt <= @until GROUP BY responsibilityId`, scope
        );
        for (const row of told) {
            const found = touch(row.rid);
            if (!found) continue;
            found.counts.delivery.updates += Number(row.updates || 0);
            found.counts.requests.asked += Number(row.asked || 0);
            found.counts.requests.open += Number(row.waiting || 0);
            found.counts.requests.answered += Number(row.asked || 0) - Number(row.waiting || 0);
        }
        const sent = await db.all(
            `SELECT responsibilityId AS rid, outboundKind AS kind, COUNT(*) AS n FROM assistant_updates
             WHERE audienceKind = 'user' AND audienceUserId = @owner AND responsibilityId IS NOT NULL
               AND outboundAt IS NOT NULL AND outboundAt >= @since AND outboundAt <= @until GROUP BY responsibilityId, outboundKind`, scope
        );
        for (const row of sent) {
            const found = touch(row.rid);
            if (!found) continue;
            if (row.kind === 'digest') found.counts.delivery.digest += Number(row.n);
            else if (row.kind === 'contact') found.counts.delivery.contacts += Number(row.n);
        }

        if (ledger) await this._costs({ ledger, byId, runOwner, since: window.since, owner });

        const hostDefaults = await control.budgetDefaults();
        const totals = emptyCounts();
        const items = [];
        for (const { row, counts, models, active } of byId.values()) {
            if (!active && !LIVE.has(row.status)) continue;
            counts.verified.total = counts.verified.planSteps + counts.verified.repairs;
            addCounts(totals, counts);
            const stored = parse(row.budgetsJson, {});
            items.push({
                id: Number(row.id),
                title: row.title,
                status: row.status,
                revision: Number(row.revision),
                // The daily limits in force now: the grant's own, never above the host's.
                limits: {
                    ...runs.budgets(row, hostDefaults),
                    externalOperations: runs.externalBudget(row),
                    repairAttempts: Number.isSafeInteger(stored.repairAttempts) ? stored.repairAttempts : null,
                    interruption: parse(row.rulesJson, {}).interruption || 'home'
                },
                ...counts,
                ...ratios(counts),
                models: [...models.entries()].map(([key, count]) => {
                    const [provider, model, prompt] = JSON.parse(key);
                    return { provider, model, prompt, runs: count };
                })
            });
        }
        return {
            period: { from: window.since, to: window.until, days: Math.max(1, Math.round((until - since) / DAY_MS)) },
            // The instructions a run started now would be given.
            prompt: runs.promptVersion().label,
            responsibilities: items,
            totals: { ...totals, ...ratios(totals) },
            costSource: source,
            notMeasured: [...NOT_MEASURED]
        };
    }

    /**
     * Cost from the work ledger (costReportService): a run's own tokens,
     * the tokens of research it started, and the tokens spent judging chat
     * messages for the responsibility. Ledger rows since the period began;
     * a run that started in the period is charged in full.
     */
    async _costs({ ledger, byId, runOwner, since, owner }) {
        const charge = (found, row) => {
            const cost = found.counts.cost;
            cost.tokens += row.actualTokens;
            cost.heldTokens += row.estimatedTokens;
            cost.failures += row.failures;
            if (row.estimatedTokens > 0) cost.provisional = true;
            for (const [kind, quantity] of Object.entries(row.resources)) cost.resources[kind] = (cost.resources[kind] || 0) + quantity;
        };
        if (runOwner.size) {
            for (const row of await ledger.workCosts({ workKind: 'assistant_run', from: since })) {
                const found = runOwner.get(String(row.workId));
                if (found) charge(found, row);
            }
            const children = await db.all(
                `SELECT o.runId, e.id FROM assistant_run_operations o
                 JOIN assistant_runs r ON r.id = o.runId
                 JOIN spitball_expeditions e ON e.executionAttemptId = 'assistant_run:' || CAST(o.runId AS TEXT) || ':' || CAST(o.id AS TEXT)
                 WHERE o.tool = 'startResearch' AND r.ownerUserId = @owner AND r.startedAt >= @since`,
                { owner, since }
            );
            if (children.length) {
                const parent = new Map(children.map(row => [String(row.id), runOwner.get(String(row.runId))]));
                for (const row of await ledger.workCosts({ workKind: 'expedition', from: since })) {
                    const found = parent.get(String(row.workId));
                    if (found) charge(found, row);
                }
            }
        }
        for (const row of await ledger.workCosts({ workKind: 'assistant_classification', from: since })) {
            const found = byId.get(Number(row.workId));
            if (!found) continue;
            charge(found, row);
            if (row.actualTokens || row.estimatedTokens) found.active = true;
        }
    }
}

module.exports = new AssistantOutcomeService();
module.exports.AssistantOutcomeService = AssistantOutcomeService;
module.exports.AssistantOutcomeError = AssistantOutcomeError;
module.exports.DEFAULT_DAYS = DEFAULT_DAYS;
module.exports.MAX_DAYS = MAX_DAYS;
module.exports.NOT_MEASURED = NOT_MEASURED;
