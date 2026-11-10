/**
 * Feedback on delegated work, and what is learned from it (DA-10, ADR 0031;
 * documentation/delegated_feedback.md).
 *
 * A person answers one of their own findings, or one piece of proposed
 * work, with one of seven kinds. Each kind changes exactly one thing, in
 * the one system that thing belongs to, and each change is shown where it
 * lives and can be put back there:
 *
 *   useful, already_knew   a counter on the source adapter (./assistant/sourceWeights.js)
 *   less_of_this           the adapter's weight, which scales its daily proposal cap
 *   wrong                  the note the run wrote is marked disputed (a revision; nothing is deleted)
 *   keep_wording           the note the run wrote becomes a saved note of the person's
 *   wrong_time             the hour it was sent is added to the hours to avoid (Attention policy)
 *   stop_responsibility    the ordinary pause or revoke, confirmed by the person
 *
 * A kind is offered only where it has that effect: no "wrong" on a finding
 * that wrote no note, no "wrong time" on one that never left the portal,
 * no "less of this" on work the person asked for. A kind is given at most
 * once per item; a repeat changes nothing.
 *
 * `assistant_feedback` holds codes, ids and numbers. There is no free-text
 * feedback, and nothing recorded here is ever given to a model.
 *
 * Weak signals are separate from the seven kinds. Starting or dismissing a
 * proposal, accepting or rejecting a result (`noteDecision`), and leaving
 * an item alone for a week (`sweepIgnored`, recorded once as `ignored`)
 * only move the adapter's counters, which can lower its rate to one a day
 * and no further.
 *
 * Behind the pilot gate (capability `feedback`): until the pilot decision
 * is recorded only the owner can give feedback or have weak signals
 * counted. Seeing and resetting what was learned is never gated. Giving
 * feedback is a person's own action, so it works while the host's
 * stop-all is on, like pausing; the pass that records ignored items does
 * not run during a stop.
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');
const { dmScopeId } = require('../utils/dmScope');
const weights = require('./assistant/sourceWeights');

/** What a person can say, in the order it is offered. */
const KINDS = ['useful', 'already_knew', 'wrong', 'less_of_this', 'wrong_time', 'keep_wording', 'stop_responsibility'];
/** Recorded by the steward, never given by a person. */
const IGNORED = 'ignored';
/** Kinds that need a finding: a proposal has found, written and sent nothing yet. */
const FINDING_ONLY = ['useful', 'already_knew', 'wrong', 'wrong_time', 'keep_wording'];
const FINDING_KINDS = ['finding', 'progress'];
const STOP_ACTIONS = { ACTIVE: ['pause', 'revoke'], PAUSED: ['revoke'], NEEDS_REVIEW: ['revoke'] };
const CAPABILITY = 'feedback';
/** An item nobody touched for this long is weak feedback. */
const IGNORED_AFTER_DAYS = 7;
const IGNORED_BATCH = 200;
const RETENTION_DAYS = 180;
/** Notes one "wrong" or "keep this wording" touches at most. */
const MAX_NOTES = 10;

class AssistantFeedbackError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message);
        this.name = 'AssistantFeedbackError';
        this.code = code;
        this.status = status;
        if (details) this.details = details;
    }
}

const notFound = () => new AssistantFeedbackError('NOT_FOUND', 'No such item.', 404);
const utcText = (date = new Date()) => date.toISOString().slice(0, 19).replace('T', ' ');
const parse = (raw, fallback) => {
    if (!raw) return fallback;
    try { return JSON.parse(raw) ?? fallback; } catch { return fallback; }
};
const positive = (value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const hourText = hour => `${String(hour).padStart(2, '0')}:00`;
const perDay = cap => (cap === null ? 'without a daily limit' : cap === 0 ? 'nothing' : `up to ${cap} a day`);

const access = () => require('./assistantAccessService');
const sources = () => require('./assistant/sources');
const live = () => require('./assistantLiveService');

class AssistantFeedbackService {
    constructor() {
        this.KINDS = KINDS;
        this.IGNORED = IGNORED;
        this.IGNORED_AFTER_DAYS = IGNORED_AFTER_DAYS;
        this.RETENTION_DAYS = RETENTION_DAYS;
        this.AssistantFeedbackError = AssistantFeedbackError;
    }

    present(row) {
        return {
            id: Number(row.id),
            kind: row.kind,
            updateId: row.updateId == null ? null : Number(row.updateId),
            initiativeId: row.initiativeId == null ? null : Number(row.initiativeId),
            responsibilityId: row.responsibilityId == null ? null : Number(row.responsibilityId),
            adapter: row.adapter || null,
            effect: { code: row.effectCode || null, ...parse(row.effectJson, {}) },
            createdAt: row.createdAt
        };
    }

    // --- What an item is, and what can be said about it ----------------------

    /**
     * The item, its work, its responsibility and its source adapter, all
     * checked to be this person's own. Anything else is "no such item".
     */
    async _context({ userId, updateId = null, initiativeId = null }) {
        const owner = String(userId || '');
        let update = null;
        let initiative = null;
        if (updateId != null) {
            const id = positive(updateId);
            update = id ? await db.get('SELECT * FROM assistant_updates WHERE id = @id', { id }) : null;
            // A project's shared finding is answered by its producer on their own notice of it.
            if (!update || update.audienceKind !== 'user' || update.audienceUserId !== owner) throw notFound();
            if (update.initiativeId != null) {
                initiative = await db.get('SELECT * FROM assistant_initiatives WHERE id = @id', { id: update.initiativeId });
            }
        } else {
            const id = positive(initiativeId);
            initiative = id ? await db.get('SELECT * FROM assistant_initiatives WHERE id = @id', { id }) : null;
            if (!initiative) throw notFound();
        }
        if (initiative && initiative.ownerUserId !== owner) {
            if (!update) throw notFound();
            initiative = null;
        }
        const responsibilityId = initiative?.responsibilityId ?? update?.responsibilityId ?? null;
        let responsibility = responsibilityId == null ? null : await db.get(
            'SELECT * FROM assistant_responsibilities WHERE id = @id', { id: responsibilityId }
        );
        if (responsibility && responsibility.ownerUserId !== owner) responsibility = null;
        const adapterKind = initiative?.sourceKind || null;
        const adapter = adapterKind ? sources()[adapterKind] || null : null;
        return {
            userId: owner, update, initiative, responsibility, adapterKind,
            learns: Boolean(responsibility) && weights.learnsFrom(adapter, parse(initiative?.originJson, null))
        };
    }

    /**
     * The notes a finding rests on: the ones its run wrote. A note the run
     * only confirmed was written by other work and is not this finding's.
     */
    async _citedNotes(ctx) {
        if (!ctx.initiative || features.enforcedOff('knowledge')) return [];
        const run = await db.get(
            'SELECT id FROM assistant_runs WHERE initiativeId = @id AND ownerUserId = @userId',
            { id: ctx.initiative.id, userId: ctx.userId }
        );
        if (!run) return [];
        const rows = await db.all(
            `SELECT p.nodeId FROM kg_provenance p
             WHERE p.sourceKind = 'tool' AND p.sourceId = @runId
               AND NOT EXISTS (SELECT 1 FROM kg_provenance q
                               WHERE q.nodeId = p.nodeId AND q.sourceKind = 'tool' AND q.id < p.id)
             ORDER BY p.nodeId LIMIT @limit`,
            { runId: run.id, limit: MAX_NOTES }
        );
        const kg = require('./knowledgeGraphService');
        const notes = [];
        for (const { nodeId } of rows) {
            const note = await kg.getPersonalNote({ guildId: dmScopeId(ctx.userId), userId: ctx.userId, nodeId });
            if (note && !note.archivedAt) notes.push({ ...note, runId: Number(run.id) });
        }
        return notes;
    }

    async _given(ctx) {
        const clauses = [];
        const params = { userId: ctx.userId };
        if (ctx.update) {
            clauses.push('updateId = @updateId');
            params.updateId = ctx.update.id;
        }
        if (ctx.initiative) {
            clauses.push('initiativeId = @initiativeId');
            params.initiativeId = ctx.initiative.id;
        }
        return db.all(
            `SELECT * FROM assistant_feedback WHERE userId = @userId AND (${clauses.join(' OR ')}) ORDER BY id`, params
        );
    }

    /** Which kinds have an effect on this item right now, and how a stop would be done. */
    async _offer(ctx, { notes = null, weight = undefined } = {}) {
        const offered = new Set();
        const finding = Boolean(ctx.update);
        if (finding && (!FINDING_KINDS.includes(ctx.update.kind) || (ctx.update.gateJson && !ctx.update.gateResolvedAt))) {
            return { offered: [], stop: null };
        }
        if (ctx.learns) {
            const row = weight === undefined ? await weights.get(ctx.responsibility.id, ctx.adapterKind) : weight;
            if (finding) {
                offered.add('useful');
                offered.add('already_knew');
            }
            if (!row || weights.stepOf(row.weight) < weights.STEPS.length - 1) offered.add('less_of_this');
        }
        if (finding) {
            const cited = notes || await this._citedNotes(ctx);
            if (cited.some(note => (note.claimStatus || 'current') === 'current')) offered.add('wrong');
            if (cited.some(note => note.generated && note.curation !== 'saved')) offered.add('keep_wording');
            if (ctx.update.outboundAt) offered.add('wrong_time');
        }
        let stop = null;
        if (ctx.responsibility) {
            const shown = require('./assistantResponsibilityService').present(ctx.responsibility);
            const actions = STOP_ACTIONS[shown.status] || null;
            if (actions) {
                offered.add('stop_responsibility');
                stop = { responsibilityId: shown.id, revision: shown.revision, title: shown.title, actions };
            }
        }
        return { offered: KINDS.filter(kind => offered.has(kind)), stop };
    }

    _state(ctx, offer, given, allowed) {
        const said = [...new Set(given.map(row => row.kind).filter(kind => KINDS.includes(kind)))];
        return {
            offered: allowed ? offer.offered.filter(kind => !said.includes(kind)) : [],
            given: KINDS.filter(kind => said.includes(kind)),
            stop: allowed && !said.includes('stop_responsibility') ? offer.stop : null,
            adapter: ctx.adapterKind
        };
    }

    /**
     * What a person may say about one of their findings, and what they
     * already said. Null for anything that is not theirs to answer.
     */
    async stateForUpdate({ userId, updateId }) {
        let ctx;
        try {
            ctx = await this._context({ userId, updateId });
        } catch (error) {
            if (error instanceof AssistantFeedbackError) return null;
            throw error;
        }
        const allowed = await access().allows(userId, CAPABILITY);
        return this._state(ctx, allowed ? await this._offer(ctx) : { offered: [], stop: null }, await this._given(ctx), allowed);
    }

    /**
     * The same for a list of the person's own work items, in a fixed
     * number of queries. `rows` are stored `assistant_initiatives` rows.
     * @returns {Promise<Map<number, Object>>}
     */
    async statesForInitiatives({ userId, rows }) {
        const out = new Map();
        const owner = String(userId);
        const mine = (rows || []).filter(row => row && row.ownerUserId === owner);
        if (!mine.length) return out;
        const allowed = await access().allows(owner, CAPABILITY);
        const params = { userId: owner };
        const marks = mine.map((row, index) => { params[`i${index}`] = row.id; return `@i${index}`; });
        const given = await db.all(
            `SELECT * FROM assistant_feedback WHERE userId = @userId AND initiativeId IN (${marks.join(', ')})`, params
        );
        const responsibilities = new Map((await db.all(
            'SELECT * FROM assistant_responsibilities WHERE ownerUserId = @userId', { userId: owner }
        )).map(row => [Number(row.id), row]));
        const learned = new Map((await db.all(
            'SELECT * FROM assistant_source_weights WHERE ownerUserId = @userId', { userId: owner }
        )).map(row => [`${row.responsibilityId}:${row.adapter}`, row]));
        for (const row of mine) {
            const responsibility = responsibilities.get(Number(row.responsibilityId)) || null;
            const adapter = sources()[row.sourceKind] || null;
            const ctx = {
                userId: owner, update: null, initiative: row, responsibility, adapterKind: row.sourceKind,
                learns: Boolean(responsibility) && weights.learnsFrom(adapter, parse(row.originJson, null))
            };
            const offer = allowed
                ? await this._offer(ctx, { weight: learned.get(`${row.responsibilityId}:${row.sourceKind}`) || null })
                : { offered: [], stop: null };
            out.set(Number(row.id), this._state(ctx, offer, given.filter(entry => Number(entry.initiativeId) === Number(row.id)), allowed));
        }
        return out;
    }

    // --- Giving feedback ----------------------------------------------------

    /**
     * Record one answer and make its one change, together.
     * @param {Object} params
     * @param {string} params.userId
     * @param {number} [params.updateId] - a finding of theirs, or
     * @param {number} [params.initiativeId] - a piece of their proposed work
     * @param {string} params.kind - one of KINDS
     * @param {'pause'|'revoke'} [params.stop] - stop_responsibility: which, after the person confirmed it
     * @param {number} [params.expectedRevision] - stop_responsibility: the responsibility revision they saw
     * @returns {Promise<{ feedback: Object, existing: boolean, message: string, state: Object }>}
     */
    async give({ userId, updateId = null, initiativeId = null, kind, stop = null, expectedRevision = null, now = new Date() }) {
        if (!userId) throw new AssistantFeedbackError('BAD_REQUEST', 'A user id is required.');
        if (!KINDS.includes(kind)) {
            throw new AssistantFeedbackError('INVALID_KIND', `kind must be one of ${KINDS.join(', ')}.`);
        }
        if (features.enforcedOff('assistant')) throw notFound();
        if (!(await access().allows(userId, CAPABILITY))) {
            throw new AssistantFeedbackError(access().REFUSAL_CODE, 'Feedback on delegated work is still in the owner-only pilot.', 403);
        }
        const target = { userId, updateId, initiativeId };
        let result;
        try {
            result = await db.transaction(async () => {
                const ctx = await this._context(target);
                const before = await this._given(ctx);
                const already = before.find(row => row.kind === kind);
                if (already) return { ctx, row: already, existing: true, message: 'You already said that about this one.' };
                const notes = ctx.update ? await this._citedNotes(ctx) : [];
                const offer = await this._offer(ctx, { notes });
                if (!offer.offered.includes(kind)) {
                    throw new AssistantFeedbackError('NOT_OFFERED', FINDING_ONLY.includes(kind) && !ctx.update
                        ? 'That can be said about a finding, not about work that has not run.'
                        : 'That would change nothing for this item.', 409);
                }
                const effect = await this._apply(kind, ctx, { notes, offer, stop, expectedRevision, now });
                const id = await db.insert(
                    `INSERT INTO assistant_feedback (userId, updateId, initiativeId, responsibilityId, adapter, kind, effectCode, effectJson)
                     VALUES (@userId, @updateId, @initiativeId, @responsibilityId, @adapter, @kind, @effectCode, @effectJson)`,
                    {
                        userId: ctx.userId,
                        updateId: ctx.update?.id ?? null,
                        initiativeId: ctx.initiative?.id ?? null,
                        responsibilityId: ctx.responsibility?.id ?? null,
                        adapter: ctx.adapterKind,
                        kind,
                        effectCode: effect.code,
                        effectJson: effect.detail ? JSON.stringify(effect.detail) : null
                    }
                );
                const row = await db.get('SELECT * FROM assistant_feedback WHERE id = @id', { id });
                return { ctx, row, existing: false, message: effect.message, deliver: effect.deliver === true };
            });
        } catch (error) {
            // Two clicks that raced: the second finds the first one's row.
            if (!/unique|duplicate/i.test(String(error?.message || ''))) throw error;
            const ctx = await this._context(target);
            const row = (await this._given(ctx)).find(entry => entry.kind === kind);
            if (!row) throw error;
            result = { ctx, row, existing: true, message: 'You already said that about this one.' };
        }
        if (result.deliver) {
            // A pause or revoke owes its owner an Inbox envelope: filed after the commit.
            try { await require('./assistantUpdateService').deliverPending({ userId: String(userId) }); } catch { /* the steward retries */ }
        }
        live().changed(String(userId), ['update', 'initiative']);
        const ctx = await this._context(target);
        return {
            feedback: this.present(result.row),
            existing: result.existing,
            message: result.message,
            state: this._state(ctx, await this._offer(ctx), await this._given(ctx), true)
        };
    }

    /** The one change a kind makes. Runs inside `give`'s transaction. */
    async _apply(kind, ctx, { notes, offer, stop, expectedRevision, now }) {
        if (kind === 'useful' || kind === 'already_knew') {
            await weights.count({
                responsibility: ctx.responsibility, adapter: ctx.adapterKind,
                signal: kind === 'useful' ? 'acceptances' : 'dismissals'
            });
            return {
                code: 'COUNTED',
                message: kind === 'useful'
                    ? 'Noted as useful. It counts in favour of this source for this responsibility.'
                    : 'Noted. It counts against this source for this responsibility; nothing else changes.'
            };
        }
        if (kind === 'less_of_this') {
            const usual = weights.usualCap(sources()[ctx.adapterKind]);
            const earlier = weights.describe(await weights.get(ctx.responsibility.id, ctx.adapterKind)
                || { responsibilityId: ctx.responsibility.id, adapter: ctx.adapterKind, weight: 1 });
            const moved = await weights.lower({ responsibility: ctx.responsibility, adapter: ctx.adapterKind });
            const current = weights.describe(await weights.get(ctx.responsibility.id, ctx.adapterKind));
            return {
                code: moved.changed ? 'RATE_LOWERED' : 'NO_CHANGE',
                detail: { from: moved.from, to: moved.to, usual, cap: current.cap },
                message: current.stopped
                    ? 'This source proposes nothing for this responsibility now. Reset it on the responsibility to hear from it again.'
                    : `This source may now propose ${perDay(current.cap)} for this responsibility (it was ${perDay(earlier.cap)}). You can reset it on the responsibility.`
            };
        }
        if (kind === 'wrong' || kind === 'keep_wording') {
            const changes = require('./knowledgeChangeSetService');
            const change = kind === 'wrong' ? 'dispute' : 'keep';
            const changeSetIds = [];
            for (const note of notes) {
                const recorded = await changes.recordFeedback({
                    guildId: dmScopeId(ctx.userId), userId: ctx.userId, nodeId: note.id, change,
                    runId: note.runId, responsibilityId: ctx.responsibility?.id ?? null
                });
                if (recorded.ok) changeSetIds.push(recorded.id);
            }
            if (!changeSetIds.length) {
                throw new AssistantFeedbackError('NOT_OFFERED', 'The note changed, so there was nothing to do.', 409);
            }
            const count = changeSetIds.length;
            return {
                code: kind === 'wrong' ? 'CORRECTION_OPENED' : 'NOTE_SAVED',
                detail: { changeSetIds },
                message: kind === 'wrong'
                    ? `Marked ${count === 1 ? 'the note this wrote' : `${count} notes this wrote`} as disputed. Nothing was deleted; correct or undo it under "Changes to your notes".`
                    : `Kept ${count === 1 ? 'the note' : `${count} notes`} as written. ${count === 1 ? 'It is' : 'They are'} yours now and will not be rewritten.`
            };
        }
        if (kind === 'wrong_time') {
            const sentAt = new Date(`${String(ctx.update.outboundAt).replace(' ', 'T')}Z`);
            const clock = await require('./assistantDeliveryService').clock(ctx.userId, sentAt);
            const hour = Math.floor(clock.minute / 60);
            const added = await require('./attentionPolicyService').addAvoidHour({ userId: ctx.userId, hour });
            if (added.code === 'FULL') {
                throw new AssistantFeedbackError('AVOID_HOURS_FULL',
                    'Half the day is already marked as a wrong time. Set quiet hours in Settings instead.', 409);
            }
            return {
                code: added.added ? 'HOUR_AVOIDED' : 'NO_CHANGE',
                detail: { hour },
                message: added.added
                    ? `Updates from your responsibilities will not be sent between ${hourText(hour)} and ${hourText((hour + 1) % 24)} again. What is looked for does not change. You can undo this in Settings.`
                    : `${hourText(hour)} was already marked as a wrong time.`
            };
        }
        // stop_responsibility: the ordinary lifecycle action, which the person confirmed.
        if (!offer.stop.actions.includes(stop)) {
            throw new AssistantFeedbackError('INVALID_STOP', `stop must be one of ${offer.stop.actions.join(', ')}.`);
        }
        if (positive(expectedRevision) === null) {
            throw new AssistantFeedbackError('BAD_REQUEST', 'expectedRevision is the revision of the responsibility you confirmed.');
        }
        await require('./assistantResponsibilityService').act({
            userId: ctx.userId, id: ctx.responsibility.id, action: stop, expectedRevision, deferDelivery: true
        });
        return {
            code: stop === 'pause' ? 'PAUSED' : 'REVOKED',
            detail: { responsibilityId: Number(ctx.responsibility.id) },
            message: stop === 'pause' ? 'Paused. Resume it on the Assistant page.' : 'Revoked. It will do nothing further.',
            deliver: true
        };
    }

    // --- Weak signals ----------------------------------------------------------

    /**
     * A person started or dismissed a proposal, or accepted or rejected a
     * result: one weak signal for the adapter it came from. Called by the
     * initiative service inside the transaction of the action, with the
     * row as it was before. Records no feedback row: the initiative itself
     * is the record of what the person did.
     */
    async noteDecision(row, action) {
        const signal = action === 'queue' && row.status === 'CANDIDATE' ? 'acceptances'
            : action === 'accept' ? 'acceptances'
                : action === 'cancel' && row.status === 'CANDIDATE' ? 'dismissals'
                    : action === 'reject' ? 'dismissals' : null;
        if (!signal) return false;
        if (!weights.learnsFrom(sources()[row.sourceKind], parse(row.originJson, null))) return false;
        if (!(await access().allows(row.ownerUserId, CAPABILITY))) return false;
        // Left alone for a week and dismissed afterwards is one dismissal, not two.
        if (signal === 'dismissals' && await db.get(
            `SELECT id FROM assistant_feedback WHERE userId = @userId AND initiativeId = @id AND kind = '${IGNORED}'`,
            { userId: row.ownerUserId, id: row.id }
        )) return false;
        await weights.count({
            responsibility: { id: row.responsibilityId, ownerUserId: row.ownerUserId }, adapter: row.sourceKind, signal
        });
        return true;
    }

    /**
     * The steward's step: a proposal nobody started or dismissed, or a
     * finding nobody opened, for `IGNORED_AFTER_DAYS` is recorded once as
     * `ignored` and counts as one dismissal. Does nothing while the host
     * has stopped delegated work (people are not expected to look then).
     * @returns {Promise<{ recorded: number, skipped?: string }>}
     */
    async sweepIgnored({ now = new Date() } = {}) {
        if (features.enforcedOff('assistant')) return { recorded: 0, skipped: 'feature' };
        if (await require('./assistantControlService').isPaused()) return { recorded: 0, skipped: 'paused' };
        const cutoff = utcText(new Date(now.getTime() - IGNORED_AFTER_DAYS * 86400000));
        // Only sources that learn: the rest are never recorded, so they must not fill the batch.
        const kinds = Object.keys(sources()).filter(kind => sources()[kind]?.learns);
        if (!kinds.length) return { recorded: 0 };
        const params = { cutoff, limit: IGNORED_BATCH };
        const marks = kinds.map((kind, index) => { params[`k${index}`] = kind; return `@k${index}`; });
        const eligible = `i.sourceKind IN (${marks.join(', ')})
            AND NOT EXISTS (SELECT 1 FROM assistant_feedback f WHERE f.initiativeId = i.id AND f.kind = '${IGNORED}')`;
        const proposals = await db.all(
            `SELECT i.* FROM assistant_initiatives i
             WHERE i.status = 'CANDIDATE' AND i.updatedAt < @cutoff AND ${eligible}
             ORDER BY i.updatedAt, i.id LIMIT @limit`,
            params
        );
        const findings = await db.all(
            `SELECT i.* FROM assistant_updates u
             JOIN assistant_initiatives i ON i.id = u.initiativeId AND i.ownerUserId = u.audienceUserId
             LEFT JOIN assistant_update_receipts c ON c.updateId = u.id AND c.userId = u.audienceUserId
             WHERE u.audienceKind = 'user' AND u.kind = 'finding' AND u.updatedAt < @cutoff
               AND COALESCE(c.acknowledgedRevision, 0) < u.materialRevision AND ${eligible}
             ORDER BY u.updatedAt, u.id LIMIT @limit`,
            params
        );
        const allowed = new Map();
        let recorded = 0;
        const items = [
            ...proposals.map(row => ({ ...row, ignoredAs: 'proposal' })),
            ...findings.map(row => ({ ...row, ignoredAs: 'finding' }))
        ];
        for (const row of items) {
            try {
                const owner = row.ownerUserId;
                if (!allowed.has(owner)) allowed.set(owner, await access().allows(owner, CAPABILITY));
                if (!allowed.get(owner)) continue;
                if (!weights.learnsFrom(sources()[row.sourceKind], parse(row.originJson, null))) continue;
                recorded += await db.transaction(async () => {
                    const again = await db.get(
                        `SELECT id FROM assistant_feedback WHERE userId = @userId AND initiativeId = @id AND kind = '${IGNORED}'`,
                        { userId: owner, id: row.id }
                    );
                    if (again) return 0;
                    await db.run(
                        `INSERT INTO assistant_feedback (userId, initiativeId, responsibilityId, adapter, kind, effectCode, effectJson)
                         VALUES (@userId, @initiativeId, @responsibilityId, @adapter, '${IGNORED}', 'COUNTED', @effectJson)`,
                        {
                            userId: owner, initiativeId: row.id, responsibilityId: row.responsibilityId, adapter: row.sourceKind,
                            effectJson: JSON.stringify({ item: row.ignoredAs })
                        }
                    );
                    await weights.count({
                        responsibility: { id: row.responsibilityId, ownerUserId: owner }, adapter: row.sourceKind, signal: 'dismissals'
                    });
                    return 1;
                });
            } catch (error) {
                logger.warn?.(`[assistant feedback] could not record an ignored item: ${error.message}`);
            }
        }
        if (recorded) live().changed([...allowed.keys()].filter(owner => allowed.get(owner)), 'initiative');
        return { recorded };
    }

    // --- What was learned -----------------------------------------------------

    /** Every learned rate of this person's responsibilities (never gated). */
    async learned({ userId }) {
        if (!userId) return [];
        return weights.listFor(userId);
    }

    /**
     * Forget what was learned about one source of one responsibility, so
     * it proposes at its usual rate again. Never gated: what was learned
     * stays resettable when the pilot closes. The feedback given stays on
     * record.
     */
    async resetRate({ userId, responsibilityId, adapter }) {
        const id = positive(responsibilityId);
        const owned = id ? await db.get(
            'SELECT id FROM assistant_responsibilities WHERE id = @id AND ownerUserId = @userId', { id, userId: String(userId) }
        ) : null;
        if (!owned) throw new AssistantFeedbackError('NOT_FOUND', 'No such responsibility.', 404);
        if (!adapter || !sources()[String(adapter)]) {
            throw new AssistantFeedbackError('INVALID_SOURCE', 'No such source.', 404);
        }
        const removed = await weights.reset({ userId, responsibilityId: id, adapter: String(adapter) });
        if (removed) live().changed(String(userId), 'initiative');
        return { reset: removed > 0, learned: await this.learned({ userId }) };
    }

    // --- Housekeeping ----------------------------------------------------------

    /**
     * Retention: feedback whose finding and work are both gone, after
     * `days`; and what was learned for a responsibility that ended that
     * long ago.
     */
    async prune({ days = RETENTION_DAYS, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        const feedback = (await db.run(
            `DELETE FROM assistant_feedback
             WHERE createdAt < @cutoff
               AND (updateId IS NULL OR NOT EXISTS (SELECT 1 FROM assistant_updates u WHERE u.id = assistant_feedback.updateId))
               AND (initiativeId IS NULL OR NOT EXISTS (SELECT 1 FROM assistant_initiatives i WHERE i.id = assistant_feedback.initiativeId))`,
            { cutoff }
        )).changes || 0;
        return { feedback, weights: await weights.prune({ days, now }) };
    }
}

module.exports = new AssistantFeedbackService();
module.exports.AssistantFeedbackService = AssistantFeedbackService;
module.exports.AssistantFeedbackError = AssistantFeedbackError;
module.exports.KINDS = KINDS;
module.exports.CAPABILITY = CAPABILITY;
