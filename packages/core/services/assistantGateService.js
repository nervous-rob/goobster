/**
 * Adopts gates that already exist in other domains into canonical assistant
 * updates, so Home, the Inbox's Needs-you filter and a project's Needs-you
 * board all show the same request (DA-2; delegated_assistant_spec.md,
 * "Inbox and Needs you: one collection, two views").
 *
 * The domain keeps owning the gate. For each open project gate (a plan to
 * approve or start, a review, a blocked mission, a human step to answer)
 * this publishes one `assistant_updates` row per person and occurrence,
 * identity `project_gate:<card id>`, with one Inbox envelope (never a Discord
 * echo: adoption must not replay an old notification). When the domain gate
 * goes away, the update's gate is resolved; the item stays in history.
 *
 * Only the project's owner gets the actionable copy: mission approval and
 * review are the owner's decisions. Called from the steward pass and from
 * `mission.*` hints, never from a Home or Inbox read.
 *
 * `projectBoard()` is the project's Needs-you board read over those same
 * gates (DA-4b): the project says what is open, the canonical update says
 * which request it is, and a decision made on the board goes through
 * `decide()` like one made on Home.
 *
 * It also holds the `gateDecisions` registry (DA-7a): one descriptor per
 * gate kind that says what a person can decide and dispatches the decision
 * to the service that owns the gate (assistantGateDescriptors.js). Home, the
 * Inbox and a chat card all go through `decide()`; it checks the card the
 * person acted on against the current one, calls the domain service, and
 * never writes an outcome itself. `decide()` is for a person's own click on
 * an authenticated surface. It must never be reachable from a model tool
 * call: a model call is not a confirmation.
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');
const requireOptional = require('../utils/optionalModule').forModule(module);

const IDENTITY_PREFIX = 'project_gate:';
const OPEN_MISSION_STATUSES = ['DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'REVIEW'];
const GATE_COLUMNS = new Set(['approve', 'review', 'unblock', 'answer']);
const OWNERS_PER_PASS = 200;

/** Where a person can press a decision. Each is a signed-in portal surface. */
const SURFACES = ['home', 'inbox', 'chat', 'project'];
/** Assistant plan steps listed on one board read. */
const BOARD_STEP_LIMIT = 40;
/** A request that lives on its own Inbox item is addressed as `inbox-<item id>`. */
const INBOX_REF = /^inbox-(\d{1,15})$/;
const UPDATE_REF = /^\d{1,15}$/;
const LIMITS = { label: 60, text: 400, option: 40, diff: 40, diffText: 300 };

class AssistantGateError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'AssistantGateError';
        this.status = status;
        this.code = code;
        if (details) this.details = details;
    }
}

const clip = (value, max) => {
    const text = value == null ? '' : String(value).trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
}

class AssistantGateService {
    constructor() {
        this.SURFACES = SURFACES;
        /** @type {Map<string, Object>} gate kind -> descriptor */
        this.gateDecisions = new Map();
        for (const [kind, descriptor] of Object.entries(require('./assistantGateDescriptors'))) {
            this.registerDecision(kind, descriptor);
        }
    }

    // --- Deciding a request where it is shown ---------------------------------

    /**
     * Register the decisions of one gate kind. A kind has one descriptor;
     * see assistantGateDescriptors.js for the contract.
     * @param {string} kind - the gate kind (`project_approve`, `friend_request`, ...)
     * @param {{ describe: Function, decide: Function, settle?: Function, staleCodes?: string[], inboxSourceType?: string }} descriptor
     */
    registerDecision(kind, descriptor) {
        const name = String(kind || '');
        if (!/^[a-z][a-z0-9_]{1,39}$/.test(name)) throw new TypeError('A gate kind is a short lower_snake name.');
        if (typeof descriptor?.describe !== 'function' || typeof descriptor?.decide !== 'function') {
            throw new TypeError(`The ${name} gate descriptor needs describe() and decide().`);
        }
        if (this.gateDecisions.has(name)) throw new Error(`The ${name} gate already has a decision descriptor.`);
        this.gateDecisions.set(name, descriptor);
    }

    /** Gate kinds a person can decide in place. */
    decisionKinds() {
        return [...this.gateDecisions.keys()];
    }

    _kindForInboxSource(sourceType) {
        if (!sourceType) return null;
        for (const [kind, descriptor] of this.gateDecisions) {
            if (descriptor.inboxSourceType === sourceType) return kind;
        }
        return null;
    }

    /**
     * Resolve a gate reference as this person: an update id (a canonical
     * update with a gate they can see) or `inbox-<id>` (one of their own
     * Inbox items whose request has a descriptor). Null when there is none.
     */
    async _locate(userId, ref) {
        const text = String(ref ?? '');
        if (UPDATE_REF.test(text)) {
            const row = await require('./assistantUpdateService').rowFor({ userId, id: Number(text) });
            const gate = parseJson(row?.gateJson, null);
            if (!row || !gate?.kind) return null;
            return {
                ref: String(row.id),
                source: 'update',
                kind: String(gate.kind),
                id: String(gate.id),
                occurrence: Number(gate.occurrence) || 1,
                open: !row.gateResolvedAt,
                updateId: Number(row.id),
                updateRevision: Number(row.materialRevision),
                inboxItemId: row.inboxItemId ? Number(row.inboxItemId) : null,
                audienceUserId: row.audienceKind === 'user' ? row.audienceUserId : null,
                actions: parseJson(row.actionsJson, [])
            };
        }
        const match = INBOX_REF.exec(text);
        if (!match) return null;
        const item = await db.get(
            'SELECT id, sourceType, sourceId FROM inbox_items WHERE id = @id AND userId = @userId',
            { id: Number(match[1]), userId: String(userId) }
        );
        return item ? this._inboxGate(item) : null;
    }

    _inboxGate(item) {
        const kind = this._kindForInboxSource(item.sourceType);
        if (!kind || item.sourceId == null) return null;
        return {
            ref: `inbox-${item.id}`,
            source: 'inbox',
            kind,
            id: String(item.sourceId),
            occurrence: 1,
            open: true,
            updateId: null,
            updateRevision: null,
            inboxItemId: Number(item.id),
            audienceUserId: null,
            actions: []
        };
    }

    /**
     * The card for one located gate: what the descriptor says now, in the
     * one shape every surface renders. Null when this person may not act.
     */
    async _card(gate, viewer) {
        const descriptor = this.gateDecisions.get(gate.kind);
        if (!descriptor) return null;
        const described = await descriptor.describe(gate, viewer);
        if (!described) return null;
        // Open needs both: the domain says so, and the adopted gate is not yet closed.
        const open = gate.open && described.state === 'open';
        return {
            ref: gate.ref,
            kind: gate.kind,
            state: open ? 'open' : 'resolved',
            title: clip(described.title, LIMITS.text),
            detail: clip(described.detail, LIMITS.text) || null,
            // A proposed text change, shown as a bounded diff (ADR 0027); absent on a card that proposes none.
            ...(Array.isArray(described.diff)
                ? {
                    diff: described.diff.slice(0, LIMITS.diff).map(entry => ({
                        op: ['same', 'add', 'del', 'skip'].includes(entry.op) ? entry.op : 'same',
                        text: clip(entry.text, LIMITS.diffText)
                    }))
                }
                : {}),
            outcome: open ? null : (clip(described.outcome, LIMITS.text) || 'This request is no longer open.'),
            occurrence: gate.occurrence,
            revision: String(described.revision ?? gate.updateRevision ?? 1),
            options: open
                ? (described.options || []).map(option => ({
                    id: clip(option.id, LIMITS.option),
                    label: clip(option.label, LIMITS.label),
                    effect: clip(option.effect, LIMITS.text) || null,
                    danger: option.danger === true
                }))
                : []
        };
    }

    /**
     * The current decision card for a gate reference, or null. A read: it
     * changes nothing. This is what a chat card renders (DA-7b).
     * @param {{ userId: string, ref: string|number }} params
     */
    async card({ userId, ref }) {
        if (!userId || features.enforcedOff('assistant')) return null;
        const gate = await this._locate(userId, ref);
        return gate ? this._card(gate, { userId: String(userId) }) : null;
    }

    /**
     * The open decision card behind one of this person's Inbox items, or
     * null (no descriptor, already settled, or not theirs to decide). Called
     * while listing the Inbox, so a failure is logged and never thrown.
     * @param {{ userId: string, item: { id: number, sourceType: string|null, sourceId: string|null }, update?: Object|null }} params
     *   `update` is the item's canonical update as the Inbox presents it
     */
    async cardForInboxItem({ userId, item, update = null }) {
        try {
            if (!userId || !item || features.enforcedOff('assistant')) return null;
            let gate;
            if (update?.gate) {
                if (!update.gateOpen || !this.gateDecisions.has(update.gate.kind)) return null;
                gate = {
                    ref: String(update.id),
                    source: 'update',
                    kind: String(update.gate.kind),
                    id: String(update.gate.id),
                    occurrence: Number(update.gate.occurrence) || 1,
                    open: true,
                    updateId: Number(update.id),
                    updateRevision: Number(update.revision),
                    inboxItemId: Number(item.id),
                    audienceUserId: String(userId),
                    actions: update.actions || []
                };
            } else {
                gate = this._inboxGate(item);
            }
            if (!gate) return null;
            const card = await this._card(gate, { userId: String(userId) });
            return card && card.state === 'open' ? card : null;
        } catch (error) {
            logger.warn?.(`[assistant gates] decision card unavailable: ${error.message}`);
            return null;
        }
    }

    _stale(current) {
        const message = !current
            ? 'This request is no longer available.'
            : current.state === 'open'
                ? 'This request changed after it was shown. Check it again before deciding.'
                : `This request was already settled. ${current.outcome}`;
        return new AssistantGateError(409, 'STALE_GATE', message, { current: current || null });
    }

    /**
     * Take one decision on a request, as the person who pressed it.
     *
     * The card they acted on is named by `occurrence` and `revision`. When
     * the request has been settled, reopened or changed since, nothing is
     * decided and the answer is 409 `STALE_GATE` with the current card in
     * `details.current`. Otherwise the owning domain service decides, with
     * its own checks, and the canonical update's gate follows through the
     * usual reconciliation.
     *
     * @param {Object} params
     * @param {string} params.userId - the signed-in person; never taken from a body
     * @param {string} [params.userName]
     * @param {string|number} params.ref - an update id, or `inbox-<item id>`
     * @param {string} params.option - one of the card's option ids
     * @param {number} params.occurrence
     * @param {string|number} params.revision
     * @param {'home'|'inbox'|'chat'|'project'} params.surface - where the person pressed it
     * @param {Object} [params.gateway] - for the domain's own notices
     * @returns {Promise<{ decided: { ref: string, kind: string, option: string, message: string }, current: Object|null }>}
     */
    async decide({ userId, userName = null, ref, option, occurrence, revision, surface, gateway = null }) {
        if (!userId) throw new AssistantGateError(400, 'INVALID_DECISION', 'A user id is required.');
        // The route is gated with the rest of the feature; this covers a caller that is not a route.
        if (features.enforcedOff('assistant')) {
            throw new AssistantGateError(404, 'FEATURE_UNAVAILABLE', 'That feature is not available on this installation.');
        }
        if (!SURFACES.includes(surface)) {
            throw new AssistantGateError(400, 'INVALID_DECISION', `surface must be one of ${SURFACES.join(', ')}.`);
        }
        if (typeof option !== 'string' || !option) throw new AssistantGateError(400, 'INVALID_DECISION', 'option is required.');
        if (!Number.isSafeInteger(Number(occurrence)) || revision === undefined || revision === null || revision === '') {
            throw new AssistantGateError(400, 'INVALID_DECISION', 'occurrence and revision name the card being decided.');
        }
        const viewer = { userId: String(userId), userName: userName || null };
        const gate = await this._locate(viewer.userId, ref);
        if (!gate) throw new AssistantGateError(404, 'NOT_FOUND', 'No such request.');
        const descriptor = this.gateDecisions.get(gate.kind);
        if (!descriptor) {
            throw new AssistantGateError(409, 'NOT_DECIDABLE_HERE', 'This request is decided where it lives. Open it to answer.');
        }
        const shown = await this._card(gate, viewer);
        // Not this person's decision: indistinguishable from a request that does not exist.
        if (!shown) throw new AssistantGateError(404, 'NOT_FOUND', 'No such request.');
        if (shown.state !== 'open' || Number(occurrence) !== shown.occurrence || String(revision) !== shown.revision) {
            throw this._stale(shown);
        }
        if (!shown.options.some(entry => entry.id === option)) {
            throw new AssistantGateError(400, 'INVALID_DECISION', `option must be one of ${shown.options.map(entry => entry.id).join(', ')}.`);
        }

        let outcome;
        try {
            outcome = await descriptor.decide(gate, viewer, option, {
                occurrence: shown.occurrence, revision: shown.revision, surface, gateway
            });
        } catch (error) {
            if (error?.code === 'STALE_GATE' || (descriptor.staleCodes || []).includes(error?.code)) {
                const fresh = await this._locate(viewer.userId, ref);
                throw this._stale(fresh ? await this._card(fresh, viewer).catch(() => null) : null);
            }
            throw error;
        }

        let current = null;
        try {
            if (descriptor.settle) await descriptor.settle(gate, viewer);
            const fresh = await this._locate(viewer.userId, ref);
            current = fresh ? await this._card(fresh, viewer) : null;
        } catch (error) {
            // The decision is made; only the refreshed card is missing.
            logger.warn?.(`[assistant gates] could not refresh a decided request: ${error.message}`);
        }
        return {
            decided: { ref: gate.ref, kind: gate.kind, option, message: clip(outcome?.message, LIMITS.text) || 'Done.' },
            current
        };
    }

    // --- The project board, on the canonical gates -----------------------------

    /**
     * The Needs-you board of one project, or of every project the person
     * can reach (DA-4b; documentation/assistant_home.md, "Project boards").
     *
     * The project still says what is open: the cards come from
     * projectMissionService.listNeedsYou, read now, so the board is never
     * behind the plan. What this adds is the identity. Each gate card is
     * matched to the canonical update Home and the Inbox show for it and
     * carries:
     *
     *  - `mine`: whether the request is this person's to decide. A plan's
     *    approval, start, review, unblocking and answers are filed for the
     *    project's owner, exactly as adoption files them; for anyone else
     *    the card says who it is waiting on (`waitingOn: 'owner'`).
     *  - `gate`: `{ ref, inboxItemId, unseen, snoozedUntil }` once the gate
     *    has been adopted, so the card links to the same Inbox item.
     *  - `decision`: the same decision card Home and the Inbox render, when
     *    the kind can be decided in place. The board posts it to
     *    `decide()` with surface `project`.
     *
     * It also lists assistant plan steps that wait on a person: a step
     * Goobster proposed to carry out and nobody has started, a step whose
     * work is waiting on its responsibility, and, for the project's owner,
     * a ready step that none of their responsibilities carries out. These
     * are prompts, not gates: they have no canonical update.
     *
     * A read: it adopts nothing, files nothing and acknowledges nothing.
     *
     * @param {{ userId: string, project?: string|null, owner?: string|null, setup?: boolean }} params
     * @returns {Promise<{ cards: Object[], text: string, canonical: boolean }>}
     */
    async projectBoard({ userId, project = null, owner = null, setup = true } = {}) {
        const missions = features.enforcedOff('projects') ? null : requireOptional('./projectMissionService', { feature: 'projects' });
        if (!missions) return { cards: [], text: '', canonical: false };
        const viewer = String(userId);
        const board = await missions.listNeedsYou({ userId: viewer, project, owner, setup });
        if (features.enforcedOff('assistant')) return { ...board, canonical: false };
        const gateCards = (board.cards || []).filter(card => GATE_COLUMNS.has(card.column));
        const updates = await require('./assistantUpdateService').personalByIdentity({
            userId: viewer,
            identityKeys: gateCards.filter(card => String(card.ownerId) === viewer).map(card => `${IDENTITY_PREFIX}${card.id}`)
        });
        const cards = [];
        for (const card of board.cards || []) {
            if (!GATE_COLUMNS.has(card.column)) {
                cards.push({ ...card, mine: true, waitingOn: null, gate: null, decision: null });
                continue;
            }
            const mine = String(card.ownerId) === viewer;
            const update = mine ? updates.get(`${IDENTITY_PREFIX}${card.id}`) : null;
            const open = Boolean(update?.gate && !update.gate.resolved);
            let decision = null;
            if (open && this.gateDecisions.has(update.gate.kind)) {
                try {
                    const described = await this._card({
                        ref: String(update.id),
                        source: 'update',
                        kind: String(update.gate.kind),
                        id: String(update.gate.id),
                        occurrence: Number(update.gate.occurrence) || 1,
                        open: true,
                        updateId: Number(update.id),
                        updateRevision: Number(update.revision),
                        inboxItemId: update.inboxItemId,
                        audienceUserId: viewer,
                        actions: update.actions || []
                    }, { userId: viewer });
                    decision = described && described.state === 'open' ? described : null;
                } catch (error) {
                    logger.warn?.(`[assistant gates] decision card unavailable: ${error.message}`);
                }
            }
            cards.push({
                ...card,
                mine,
                waitingOn: mine ? null : 'owner',
                gate: open
                    ? { ref: String(update.id), inboxItemId: update.inboxItemId, unseen: update.unseen, snoozedUntil: update.snoozedUntil }
                    : null,
                decision
            });
        }
        cards.push(...await this._assistantStepCards(viewer, missions, { project, owner }));
        const order = { approve: 0, answer: 1, unblock: 2, review: 3, assistant: 4, setup: 5 };
        cards.sort((a, b) => (order[a.column] ?? 9) - (order[b.column] ?? 9)
            || String(a.projectName).localeCompare(String(b.projectName)));
        const mineCount = cards.filter(card => card.mine).length;
        const lines = [
            `📋 Needs you (${mineCount})${cards.length > mineCount ? `, waiting on others (${cards.length - mineCount})` : ''}`,
            ...cards.slice(0, 30).map(card => `- [${card.column}] ${card.projectSlug}: ${card.title}${card.mine ? '' : ' (waiting on the project owner)'}`)
        ];
        return { cards, text: lines.join('\n'), canonical: true };
    }

    /** Ready assistant steps of approved, running plans that wait on this person. */
    async _assistantStepCards(viewer, missions, { project = null, owner = null }) {
        const params = { viewer, limit: BOARD_STEP_LIMIT };
        let only = '';
        if (project) {
            // listNeedsYou already refused a project this person cannot reach.
            const row = await missions._requireProject(viewer, project, owner);
            only = 'AND p.id = @projectId';
            params.projectId = Number(row.id);
        }
        const steps = await db.all(
            `SELECT s.id AS stepId, s.title, m.id AS missionId, m.title AS missionTitle, m.status AS missionStatus,
                    p.slug, p.name, p.userId AS ownerId
             FROM project_mission_steps s
             JOIN project_missions m ON m.id = s.missionId
             JOIN observatory_projects p ON p.id = m.projectId
             WHERE s.kind = 'agent' AND s.status = 'READY' AND m.status = 'ACTIVE'
               AND m.approvedAt IS NOT NULL AND m.approvedRevision = m.planRevision
               AND (p.userId = @viewer OR EXISTS (
                    SELECT 1 FROM project_members pm WHERE pm.projectId = p.id AND pm.userId = @viewer))
               ${only}
             ORDER BY p.id ASC, s.sortOrder ASC, s.id ASC LIMIT @limit`,
            params
        );
        const cards = [];
        for (const step of steps) {
            const work = await db.get(
                `SELECT id, status, waitReason FROM assistant_initiatives
                 WHERE ownerUserId = @viewer AND planStepId = @stepId
                   AND status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING')
                 ORDER BY id DESC LIMIT 1`,
                { viewer, stepId: step.stepId }
            );
            const base = {
                column: 'assistant',
                id: `agent:${Number(step.missionId)}:${Number(step.stepId)}`,
                stepId: Number(step.stepId),
                projectSlug: step.slug,
                projectName: step.name,
                ownerId: step.ownerId,
                missionId: Number(step.missionId),
                missionTitle: step.missionTitle,
                missionStatus: step.missionStatus,
                title: step.title,
                mine: true,
                waitingOn: null,
                gate: null,
                decision: null
            };
            if (work?.status === 'CANDIDATE') {
                cards.push({ ...base, initiativeId: Number(work.id), state: 'proposed', detail: 'Goobster proposed to carry out this step. Start it from Assistant, or do the step yourself in the Plan.' });
            } else if (work?.status === 'WAITING' && ['responsibility', 'access', 'user_question'].includes(work.waitReason)) {
                cards.push({ ...base, initiativeId: Number(work.id), state: 'waiting', detail: 'The work on this step is waiting on you. Open Assistant to see why.' });
            } else if (!work && String(step.ownerId) === viewer) {
                cards.push({ ...base, initiativeId: null, state: 'undelegated', detail: 'This step is for Goobster, and none of your responsibilities carries out plan steps in this project. Delegate it from Assistant, or do the step yourself in the Plan.' });
            }
        }
        return cards;
    }

    // --- Adopting project gates -----------------------------------------------

    /** Owners who have, or had adopted, an open project gate. */
    async _owners() {
        const marks = OPEN_MISSION_STATUSES.map(status => `'${status}'`).join(', ');
        const rows = await db.all(
            `SELECT DISTINCT userId FROM project_missions WHERE status IN (${marks})
             UNION
             SELECT DISTINCT audienceUserId AS userId FROM assistant_updates
             WHERE audienceKind = 'user' AND identityKey LIKE '${IDENTITY_PREFIX}%'
               AND gateJson IS NOT NULL AND gateResolvedAt IS NULL
             LIMIT ${OWNERS_PER_PASS}`,
            {}
        );
        return rows.map(row => String(row.userId)).filter(Boolean);
    }

    /**
     * Reconcile adopted project gates with the missions' current state.
     * @param {{ userId?: string }} [params] - one owner, or every owner with open gates
     * @returns {Promise<{ adopted: number, resolved: number }>}
     */
    async adoptProjectGates({ userId = null } = {}) {
        const result = { adopted: 0, resolved: 0 };
        if (features.enforcedOff('assistant') || features.enforcedOff('projects')) return result;
        const owners = userId ? [String(userId)] : await this._owners();
        for (const owner of owners) {
            try {
                const outcome = await this._adoptFor(owner);
                result.adopted += outcome.adopted;
                result.resolved += outcome.resolved;
            } catch (error) {
                logger.warn?.(`[assistant gates] adoption failed for one owner: ${error.message}`);
            }
        }
        return result;
    }

    async _adoptFor(owner) {
        const updates = require('./assistantUpdateService');
        const missions = requireOptional('./projectMissionService', { feature: 'projects' });
        if (!missions) return { adopted: 0, resolved: 0 };
        const board = await missions.listNeedsYou({ userId: owner, setup: false });
        const audience = { userId: owner };
        const live = new Set();
        let adopted = 0;
        for (const card of board.cards || []) {
            if (!GATE_COLUMNS.has(card.column) || String(card.ownerId) !== owner) continue;
            const identityKey = `${IDENTITY_PREFIX}${card.id}`;
            live.add(identityKey);
            // The same gate id opening again (a mission blocked a second
            // time) is a new occurrence: it reopens the gate and is unseen.
            const previous = await db.get(
                `SELECT gateJson, gateResolvedAt FROM assistant_updates
                 WHERE audienceKind = 'user' AND audienceUserId = @owner AND identityKey = @identityKey`,
                { owner, identityKey }
            );
            let occurrence = 1;
            try { occurrence = Number(JSON.parse(previous?.gateJson || 'null')?.occurrence) || 1; } catch { /* first occurrence */ }
            if (previous?.gateResolvedAt) occurrence += 1;
            const published = await updates.publish({
                audience,
                identityKey,
                kind: card.column === 'answer' ? 'question' : 'progress',
                title: `${card.projectName}: ${card.title}`,
                summary: card.detail || null,
                components: ['projects'],
                source: { kind: 'project_mission', id: card.missionId, revision: card.missionStatus },
                actions: [{ kind: card.column === 'review' ? 'open_review' : 'open_project', id: `${card.ownerId}/${card.projectSlug}` }],
                gate: { kind: `project_${card.column}`, id: card.id, occurrence },
                deliver: true
            });
            if (published.changed) adopted += 1;
        }
        const open = await db.all(
            `SELECT identityKey FROM assistant_updates
             WHERE audienceKind = 'user' AND audienceUserId = @owner AND identityKey LIKE '${IDENTITY_PREFIX}%'
               AND gateJson IS NOT NULL AND gateResolvedAt IS NULL`,
            { owner }
        );
        let resolved = 0;
        for (const row of open) {
            if (live.has(row.identityKey)) continue;
            if (await updates.resolveGate({ audience, identityKey: row.identityKey })) resolved += 1;
        }
        return { adopted, resolved };
    }
}

module.exports = new AssistantGateService();
module.exports.AssistantGateService = AssistantGateService;
module.exports.AssistantGateError = AssistantGateError;
module.exports.IDENTITY_PREFIX = IDENTITY_PREFIX;
module.exports.SURFACES = SURFACES;
