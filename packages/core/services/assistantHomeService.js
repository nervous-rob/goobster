/**
 * The assistant-first Home projection (DA-2; delegated_assistant_spec.md
 * section 4, delegated_assistant_architecture.md section 9.3).
 *
 * `project()` builds the `assistant` block of `GET /api/app/home` from
 * records that already exist: responsibilities, initiatives, canonical
 * updates with this person's receipts, typed process observations and the
 * Inbox. It is a READ and nothing else: it never runs a model, a search or
 * a job, never grants or activates anything, never marks an item read,
 * delivered or resolved, and never enables Attention.
 *
 * Rules the shape encodes:
 *  - Needs you is the Inbox's Needs-you filter (the same query), previewed.
 *  - What changed never repeats a card already shown under Needs you.
 *  - Unseen updates, open requests, running work and blocked processes are
 *    separate numbers; nothing here sums them.
 *  - A section that cannot be read is `unknown`, never a reassuring zero:
 *    its name is listed in `partial` and its counts are null.
 *  - Freshness comes from the steward's recorded last pass, not from an
 *    absence of errors.
 *
 * Works with the `assistant` feature off: the block then says
 * `availability: 'unavailable'` and still previews the Inbox's own requests.
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');

const SCHEMA_VERSION = 1;
const NEEDS_YOU_PREVIEW = 5;
const BRIEF_PREVIEW = 6;
const BRIEF_SCAN = 30;
const RESPONSIBILITY_PREVIEW = 8;
const BLOCKED_WINDOW_DAYS = 7;
const OBSERVATION_SCAN = 500;

/** Stable order; `feature` is what must be available for the component to work. */
const COMPONENTS = [
    { id: 'knowledge', feature: 'knowledge' },
    { id: 'research', feature: 'expeditions' },
    { id: 'projects', feature: 'projects' },
    { id: 'processes', feature: null },
    { id: 'conversations', feature: null }
];

/** Which component a running initiative's work shows under. */
const SOURCE_COMPONENT = { project_plan: 'projects', attention_item: 'research' };
const LIVE = ['ACTIVE', 'PAUSED', 'NEEDS_REVIEW'];

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

class AssistantHomeService {
    constructor() {
        this.SCHEMA_VERSION = SCHEMA_VERSION;
        this.COMPONENT_IDS = COMPONENTS.map(component => component.id);
    }

    /**
     * @param {{ userId: string, now?: Date }} params
     * @returns {Promise<Object>} the `assistant` block
     */
    async project({ userId, now = new Date() }) {
        const owner = String(userId);
        const partial = [];
        const section = async (name, read, fallback) => {
            try {
                return await read();
            } catch (error) {
                partial.push(name);
                logger.warn?.(`[assistant home] ${name} unavailable: ${error.message}`);
                return fallback;
            }
        };

        const featureOff = features.enforcedOff('assistant');
        const needsYou = await section('needsYou', () => this._needsYou(owner), null);
        if (featureOff) {
            return {
                schemaVersion: SCHEMA_VERSION,
                asOf: now.toISOString(),
                availability: 'unavailable',
                unavailable: { feature: 'assistant' },
                freshness: { state: 'unknown', lastPassAt: null },
                responsibilities: { counts: null, items: [] },
                counts: { unseen: null, needsAction: needsYou ? needsYou.count : null, running: null },
                components: COMPONENTS.map(component => this._component(component, null, null, null, 'unknown')),
                needsYou: needsYou ? needsYou.items : [],
                brief: [],
                partial
            };
        }

        const responsibilities = await section('responsibilities', () => this._responsibilities(owner, now), null);
        const attention = await section('attention', async () => {
            const policy = await require('./attentionPolicyService').get(owner);
            return Boolean(policy && policy.enabled);
        }, null);
        const summary = await section('updates', () => require('./assistantUpdateService').summary({ userId: owner, now }), null);
        const running = await section('running', () => this._running(owner), null);
        const blocked = await section('processes', () => this._blockedProcesses(owner, now), null);
        const freshness = await section('freshness', () => this._freshness(now), { state: 'unknown', lastPassAt: null });
        const shown = new Set((needsYou?.items || []).map(item => item.update?.id).filter(Boolean));
        const brief = await section('brief', () => this._brief(owner, shown, now), []);

        const counts = responsibilities?.counts || null;
        let availability = 'ready';
        if (attention === false) availability = 'attention_off';
        else if (counts && counts.active + counts.paused + counts.needsReview === 0) availability = 'none_delegated';
        else if (counts && counts.active === 0) availability = 'paused';
        else if (!counts || attention === null) availability = 'unknown';

        return {
            schemaVersion: SCHEMA_VERSION,
            asOf: now.toISOString(),
            availability,
            freshness,
            responsibilities: responsibilities || { counts: null, items: [] },
            // Distinct ids, separately labelled; the client never adds them up.
            counts: {
                unseen: summary ? summary.counts.unseen : null,
                needsAction: needsYou ? needsYou.count : null,
                running: running ? running.total : null
            },
            components: COMPONENTS.map(component => this._component(
                component,
                summary ? summary.components.find(entry => entry.id === component.id) : null,
                running ? (running.byComponent[component.id] || 0) : null,
                component.id === 'processes' ? blocked : 0,
                freshness.state
            )),
            needsYou: needsYou ? needsYou.items : [],
            brief,
            partial
        };
    }

    /** One component card's signals; null means unknown, not zero. */
    _component(component, counts, running, blocked, freshness) {
        const unavailable = Boolean(component.feature && features.enforcedOff(component.feature));
        const known = counts !== null && counts !== undefined;
        const unseen = known ? counts.unseen : null;
        const needsAction = known ? counts.needsAction : null;
        let state = 'quiet';
        if (unavailable) state = 'unavailable';
        else if (!known) state = 'unknown';
        else if (needsAction > 0) state = 'needs_you';
        else if (blocked > 0) state = 'blocked';
        else if (running > 0) state = 'working';
        else if (unseen > 0) state = 'updates';
        else if (freshness !== 'current') state = 'unknown';
        return {
            id: component.id,
            state,
            unavailable: unavailable ? { feature: component.feature } : null,
            unseen: unavailable ? null : unseen,
            needsAction: unavailable ? null : needsAction,
            running: unavailable ? null : running,
            blocked: unavailable ? null : (blocked ?? null),
            freshness: unavailable ? 'unknown' : freshness,
            latestUpdateId: known ? counts.latestUpdateId : null
        };
    }

    /** The same query the Inbox's Needs-you filter runs, as a short preview. */
    async _needsYou(owner) {
        const inbox = require('./inboxService');
        const page = await inbox.list({ userId: owner, view: 'needs_you', limit: NEEDS_YOU_PREVIEW });
        return {
            count: page.needsYou,
            items: page.items.map(item => ({
                inboxItemId: item.id,
                kind: item.kind,
                title: item.title,
                body: item.body ? String(item.body).slice(0, 400) : null,
                link: item.link,
                read: item.read,
                createdAt: item.createdAt,
                update: item.update,
                request: item.access ? 'access_request' : item.friend ? 'friend_request' : item.update?.gate?.kind || null
            }))
        };
    }

    async _responsibilities(owner, now) {
        const service = require('./assistantResponsibilityService');
        const { responsibilities } = await service.list({ userId: owner, now });
        const counts = { active: 0, paused: 0, needsReview: 0, draft: 0 };
        for (const item of responsibilities) {
            if (item.status === 'ACTIVE') counts.active += 1;
            else if (item.status === 'PAUSED') counts.paused += 1;
            else if (item.status === 'NEEDS_REVIEW') counts.needsReview += 1;
            else if (item.status === 'DRAFT') counts.draft += 1;
        }
        const live = responsibilities.filter(item => LIVE.includes(item.status)).slice(0, RESPONSIBILITY_PREVIEW);
        const open = new Map();
        if (live.length) {
            const params = { owner };
            const marks = live.map((item, index) => { params[`r${index}`] = item.id; return `@r${index}`; });
            const rows = await db.all(
                `SELECT responsibilityId, status, COUNT(*) AS c FROM assistant_initiatives
                 WHERE ownerUserId = @owner AND responsibilityId IN (${marks.join(', ')})
                   AND status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW')
                 GROUP BY responsibilityId, status`,
                params
            );
            for (const row of rows) {
                const entry = open.get(Number(row.responsibilityId)) || { proposed: 0, queued: 0, running: 0, waiting: 0, review: 0 };
                const key = { CANDIDATE: 'proposed', QUEUED: 'queued', RUNNING: 'running', WAITING: 'waiting', REVIEW: 'review' }[row.status];
                entry[key] += Number(row.c);
                open.set(Number(row.responsibilityId), entry);
            }
        }
        return {
            counts,
            items: live.map(item => ({
                id: item.id,
                revision: item.revision,
                status: item.status,
                title: item.title,
                outcome: item.outcome,
                projectId: item.projectId,
                expiresAt: item.expiresAt,
                updatedAt: item.updatedAt,
                initiatives: open.get(item.id) || { proposed: 0, queued: 0, running: 0, waiting: 0, review: 0 }
            }))
        };
    }

    /** Work with a valid lease right now, total and per component. */
    async _running(owner) {
        const rows = await db.all(
            `SELECT sourceKind, COUNT(*) AS c FROM assistant_initiatives
             WHERE ownerUserId = @owner AND status = 'RUNNING' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt > @now
             GROUP BY sourceKind`,
            { owner, now: utcText() }
        );
        const byComponent = {};
        let total = 0;
        for (const row of rows) {
            const component = SOURCE_COMPONENT[row.sourceKind] || 'research';
            byComponent[component] = (byComponent[component] || 0) + Number(row.c);
            total += Number(row.c);
        }
        return { total, byComponent };
    }

    /** Processes whose most recent typed observation is a failure or a block. */
    async _blockedProcesses(owner, now) {
        const cutoff = utcText(new Date(now.getTime() - BLOCKED_WINDOW_DAYS * 86400000));
        const rows = await db.all(
            `SELECT processKind, processId, outcome FROM assistant_process_observations
             WHERE ownerUserId = @owner AND observedAt >= @cutoff
             ORDER BY observedAt DESC, id DESC LIMIT ${OBSERVATION_SCAN}`,
            { owner, cutoff }
        );
        const latest = new Map();
        for (const row of rows) {
            const key = `${row.processKind}:${row.processId}`;
            if (!latest.has(key)) latest.set(key, row.outcome);
        }
        return [...latest.values()].filter(outcome => outcome === 'failed' || outcome === 'blocked').length;
    }

    async _freshness(now) {
        const steward = require('./assistantStewardService');
        const beat = await require('./instanceStateService').get(steward.HEARTBEAT_KEY);
        const at = beat?.at ? Date.parse(beat.at) : NaN;
        if (!Number.isFinite(at)) return { state: 'unknown', lastPassAt: null };
        return {
            state: now.getTime() - at <= 3 * steward.INTERVAL_MS ? 'current' : 'stale',
            lastPassAt: new Date(at).toISOString()
        };
    }

    /** Unseen informational updates, newest first, minus what Needs you shows. */
    async _brief(owner, shown, now) {
        const { updates } = await require('./assistantUpdateService').list({ userId: owner, limit: BRIEF_SCAN, now });
        return updates
            .filter(update => update.unseen && !update.needsAction && !update.gate && !shown.has(update.id))
            .slice(0, BRIEF_PREVIEW)
            .map(update => ({
                id: update.id,
                revision: update.revision,
                kind: update.kind,
                title: update.title,
                summary: update.summary,
                componentIds: update.componentIds,
                audience: update.audience,
                responsibilityId: update.responsibilityId,
                initiativeId: update.initiativeId,
                actions: update.actions,
                inboxItemId: update.inboxItemId,
                happenedAt: update.happenedAt
            }));
    }
}

module.exports = new AssistantHomeService();
module.exports.AssistantHomeService = AssistantHomeService;
