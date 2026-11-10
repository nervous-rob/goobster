/**
 * The assistant-first Home projection (DA-2; delegated_assistant_spec.md
 * section 4, delegated_assistant_architecture.md section 9.3).
 *
 * `project()` builds the `assistant` block of `GET /api/app/home` from
 * records that already exist: responsibilities, initiatives, canonical
 * updates with this person's receipts, the process assessment and the
 * Inbox. It is a READ and nothing else: it never runs a model, a search or
 * a job, never grants or activates anything, never marks an item read,
 * delivered or resolved, and never enables Attention.
 *
 * Rules the shape encodes:
 *  - Needs you is the Inbox's Needs-you filter (the same query), previewed.
 *  - What changed never repeats a card already shown under Needs you.
 *  - Unseen updates, open requests, running work and blocked or degraded
 *    processes are separate numbers; nothing here sums them.
 *  - A process's health is judged from its evidence on every read, so it
 *    stays on its card after the update about it was acknowledged.
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
const requireOptional = require('../utils/optionalModule').forModule(module);

/**
 * Assistant services ship with the `assistant` feature and are absent in a
 * reduced payload. Both arguments stay literal for scripts/lib/requireGraph.js.
 */
const loaded = (module_) => {
    if (!module_) throw new Error('the assistant feature is not installed');
    return module_;
};
const updatesService = () => loaded(requireOptional('./assistantUpdateService', { feature: 'assistant' }));
const responsibilityService = () => loaded(requireOptional('./assistantResponsibilityService', { feature: 'assistant' }));
const processService = () => loaded(requireOptional('./assistantProcessService', { feature: 'assistant' }));
const controlService = () => loaded(requireOptional('./assistantControlService', { feature: 'assistant' }));

const SCHEMA_VERSION = 1;
const NEEDS_YOU_PREVIEW = 5;
const BRIEF_PREVIEW = 6;
const BRIEF_SCAN = 30;
const RESPONSIBILITY_PREVIEW = 8;
/** Where the steward records its last pass, and how old that may be before Home calls its picture stale. */
const HEARTBEAT_KEY = 'assistant_steward_pass';
const STALE_AFTER_MS = 15 * 60 * 1000;

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
                hostPaused: null,
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
        const summary = await section('updates', () => updatesService().summary({ userId: owner, now }), null);
        const running = await section('running', () => this._running(owner), null);
        const health = await section('processes', () => this._processHealth(owner, now), null);
        const freshness = await section('freshness', () => this._freshness(now), { state: 'unknown', lastPassAt: null });
        // The host's stop-all (documentation/delegated_operations.md); null when it could not be read.
        const hostPaused = await section('hostPaused', () => controlService().isPaused(), null);
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
            hostPaused,
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
                component.id === 'processes' ? health : { blocked: 0, degraded: 0 },
                freshness.state
            )),
            needsYou: needsYou ? needsYou.items : [],
            brief,
            partial
        };
    }

    /** One component card's signals; null means unknown, not zero. */
    _component(component, counts, running, health, freshness) {
        const unavailable = Boolean(component.feature && features.enforcedOff(component.feature));
        const known = counts !== null && counts !== undefined;
        const unseen = known ? counts.unseen : null;
        const needsAction = known ? counts.needsAction : null;
        const blocked = health ? health.blocked : null;
        const degraded = health ? health.degraded : null;
        let state = 'quiet';
        if (unavailable) state = 'unavailable';
        else if (!known) state = 'unknown';
        else if (needsAction > 0) state = 'needs_you';
        else if (blocked > 0) state = 'blocked';
        else if (degraded > 0) state = 'degraded';
        else if (running > 0) state = 'working';
        else if (unseen > 0) state = 'updates';
        else if (health === null || freshness !== 'current') state = 'unknown';
        return {
            id: component.id,
            state,
            unavailable: unavailable ? { feature: component.feature } : null,
            unseen: unavailable ? null : unseen,
            needsAction: unavailable ? null : needsAction,
            running: unavailable ? null : running,
            blocked: unavailable ? null : blocked,
            degraded: unavailable ? null : degraded,
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
                // The same decision card the Inbox item carries, or null.
                decision: item.decision || null,
                request: item.access ? 'access_request' : item.friend ? 'friend_request' : item.update?.gate?.kind || null
            }))
        };
    }

    async _responsibilities(owner, now) {
        const service = responsibilityService();
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

    /**
     * How the person's recurring processes are doing, from the assessment
     * (assistantProcessService.assess). `blocked` counts the ones not doing
     * their job at all (blocked, stalled or unreachable); `degraded` the ones
     * running with a problem. Neither depends on what has been read.
     */
    async _processHealth(owner, now) {
        const { counts } = await processService().assess({ userId: owner, now });
        return { blocked: counts.notWorking, degraded: counts.degraded };
    }

    async _freshness(now) {
        const beat = await require('./instanceStateService').get(HEARTBEAT_KEY);
        const at = beat?.at ? Date.parse(beat.at) : NaN;
        if (!Number.isFinite(at)) return { state: 'unknown', lastPassAt: null };
        return {
            state: now.getTime() - at <= STALE_AFTER_MS ? 'current' : 'stale',
            lastPassAt: new Date(at).toISOString()
        };
    }

    /** Unseen informational updates, newest first, minus what Needs you shows. */
    async _brief(owner, shown, now) {
        const { updates } = await updatesService().list({ userId: owner, limit: BRIEF_SCAN, now });
        const listed = updates
            .filter(update => update.unseen && !update.needsAction && !update.gate && !shown.has(update.id))
            .slice(0, BRIEF_PREVIEW);
        // What the person may say about each of their own findings (DA-10); null when
        // it is not theirs to answer or could not be read.
        const feedback = require('./assistantFeedbackService');
        const states = new Map();
        for (const update of listed) {
            if (update.audience?.kind !== 'private') continue;
            try {
                states.set(update.id, await feedback.stateForUpdate({ userId: owner, updateId: update.id }));
            } catch (error) {
                logger.warn?.(`[assistant home] feedback state unavailable: ${error.message}`);
            }
        }
        return listed
            .map(update => ({
                id: update.id,
                revision: update.revision,
                kind: update.kind,
                title: update.title,
                summary: update.summary,
                componentIds: update.componentIds,
                audience: update.audience,
                producer: update.producer,
                responsibilityId: update.responsibilityId,
                initiativeId: update.initiativeId,
                actions: update.actions,
                inboxItemId: update.inboxItemId,
                happenedAt: update.happenedAt,
                feedback: states.get(update.id) || null
            }));
    }
}

module.exports = new AssistantHomeService();
module.exports.AssistantHomeService = AssistantHomeService;
module.exports.HEARTBEAT_KEY = HEARTBEAT_KEY;
module.exports.STALE_AFTER_MS = STALE_AFTER_MS;
