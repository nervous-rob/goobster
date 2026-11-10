/**
 * Human confirmation receipts (DA-7b, ADR 0019).
 *
 * A model can draft a responsibility. It can never confirm one, and it can
 * never press a decision on a request. The proof that a person did is a
 * receipt: a single-use secret minted for a signed-in person when a
 * confirmation is rendered to them, bound to
 *
 *   - the subject (a responsibility id, or a gate reference),
 *   - the action (`activate` / `resume`, or `decide`),
 *   - the revision they were shown, and
 *   - a hash of what they were shown (the normalized grant, or the card),
 *
 * and spent once, by a conditional `UPDATE` inside the transaction that
 * acts on it. Only the SHA-256 of the secret is stored, so a database read
 * does not yield a usable receipt.
 *
 * `mint()` refuses inside a model tool call (`utils/modelCallScope.js`), so
 * tool arguments cannot contain or forge one; it is reachable only from the
 * session-authenticated mint route. Receipts follow the mission approval
 * receipts' pattern (`project_mission_approval_receipts`) with the hash
 * added.
 *
 * Erasure and counting live in services/dormantDataService.js.
 *
 * Spec: documentation/delegated_conversation.md
 */

const crypto = require('node:crypto');
const db = require('../db');
const { features } = require('../features/featureState');
const modelCallScope = require('../utils/modelCallScope');

const FEATURE_ID = 'assistant';
const RECEIPT_TTL_MS = 15 * 60 * 1000;
const RETENTION_DAYS = 30;
const SURFACES = ['portal', 'chat'];
/** subject kind -> the actions a receipt can confirm on it. */
const SUBJECTS = {
    responsibility: ['activate', 'resume'],
    gate: ['decide']
};
/** The pilot capability that covers confirming from a conversation (DA-12a). */
const CAPABILITY = 'conversation';
const RECEIPT_FORMAT = /^(\d{1,15})\.([A-Za-z0-9_-]{20,128})$/;
/** The status an action starts from: a receipt is not minted for a button that cannot work. */
const ACTION_FROM = { activate: ['DRAFT'], resume: ['PAUSED', 'NEEDS_REVIEW'] };

class AssistantConfirmationError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message);
        this.name = 'AssistantConfirmationError';
        this.code = code;
        this.status = status;
        if (details) this.details = details;
    }
}

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/** JSON with object keys sorted at every depth, so equal content hashes equally. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

const humanOnly = () => new AssistantConfirmationError(modelCallScope.HUMAN_ONLY,
    'Only you can confirm this, from the card or the Responsibilities page. A tool call is not a confirmation.', 403);

const invalid = () => new AssistantConfirmationError('CONFIRMATION_INVALID',
    'That confirmation is no longer valid. It was shown too long ago, was already used, or what it confirmed has changed. Open it again to confirm.', 403);

class AssistantConfirmationService {
    constructor() {
        this.RECEIPT_TTL_MS = RECEIPT_TTL_MS;
        this.RETENTION_DAYS = RETENTION_DAYS;
        this.SURFACES = SURFACES;
        this.CAPABILITY = CAPABILITY;
    }

    /**
     * The authority a responsibility would carry, as one hash. Everything a
     * person is asked to confirm is in it; an edit to any of it is another
     * hash. `responsibility` is the service's presented shape.
     */
    grantHash(responsibility) {
        const r = responsibility || {};
        return sha256(canonical({
            id: Number(r.id),
            ownerUserId: r.ownerUserId || null,
            actingUserId: r.actingUserId || null,
            payerUserId: r.payerUserId || null,
            title: r.title || null,
            outcome: r.outcome || null,
            attentionItemId: r.attentionItemId ?? null,
            projectId: r.projectId ?? null,
            planId: r.planId ?? null,
            scopes: r.scopes || {},
            operations: r.operations || [],
            budgets: r.budgets || {},
            rules: r.rules || {},
            expiresAt: r.expiresAt || null
        }));
    }

    /** The decision card a person was shown, as one hash. */
    cardHash(card) {
        const c = card || {};
        return sha256(canonical({
            ref: String(c.ref),
            kind: c.kind || null,
            title: c.title || null,
            detail: c.detail || null,
            options: (c.options || []).map(option => ({ id: option.id, label: option.label, effect: option.effect || null }))
        }));
    }

    /** The revision text a gate receipt is bound to. */
    gateRevision(card) {
        return `${Number(card.occurrence)}:${String(card.revision)}`;
    }

    async _pilotAllows(userId) {
        return require('./assistantAccessService').allows(String(userId), CAPABILITY);
    }

    _pilotOnly() {
        return new AssistantConfirmationError(require('./assistantAccessService').REFUSAL_CODE,
            'Delegating by conversation is limited to the installation\'s owner until the pilot decision is recorded.', 403,
            { capability: CAPABILITY });
    }

    /**
     * Mint a receipt for what a signed-in person is being shown right now.
     *
     * @param {Object} params
     * @param {string} params.userId - the session's person; never from a body
     * @param {'responsibility'|'gate'} params.subject
     * @param {string|number} params.id - the responsibility id, or the gate reference
     * @param {'activate'|'resume'|'decide'} params.action
     * @param {string|number} params.revision - the revision on the screen
     * @param {number} [params.occurrence] - a gate card's occurrence
     * @param {'portal'|'chat'} params.surface
     * @returns {Promise<{ receipt: string, expiresAt: string, surface: string, shown: Object }>}
     *   `shown` is what the receipt is bound to: the caller displays this, not its own copy
     */
    async mint({ userId, subject, id, action, revision, occurrence = null, surface, now = new Date() }) {
        if (modelCallScope.active()) throw humanOnly();
        if (features.enforcedOff(FEATURE_ID)) {
            throw new AssistantConfirmationError('FEATURE_UNAVAILABLE', 'That feature is not available on this installation.', 404);
        }
        if (!userId) throw new AssistantConfirmationError('INVALID_CONFIRMATION', 'A user id is required.');
        if (!Object.prototype.hasOwnProperty.call(SUBJECTS, subject)) {
            throw new AssistantConfirmationError('INVALID_CONFIRMATION', `subject must be one of ${Object.keys(SUBJECTS).join(', ')}.`);
        }
        if (!SUBJECTS[subject].includes(action)) {
            throw new AssistantConfirmationError('INVALID_CONFIRMATION', `action must be one of ${SUBJECTS[subject].join(', ')}.`);
        }
        if (!SURFACES.includes(surface)) {
            throw new AssistantConfirmationError('INVALID_CONFIRMATION', `surface must be one of ${SURFACES.join(', ')}.`);
        }
        if (revision === undefined || revision === null || revision === '') {
            throw new AssistantConfirmationError('INVALID_CONFIRMATION', 'revision names what is being confirmed.');
        }
        // Home and the Inbox decide a request without one; only a chat card needs it.
        if (subject === 'gate' && surface !== 'chat') {
            throw new AssistantConfirmationError('INVALID_CONFIRMATION', 'A request is confirmed with a receipt only from a chat card.');
        }
        const owner = String(userId);
        if (surface === 'chat' && !(await this._pilotAllows(owner))) throw this._pilotOnly();

        const bound = subject === 'responsibility'
            ? await this._bindResponsibility({ owner, id, action, revision, now })
            : await this._bindGate({ owner, ref: id, occurrence, revision });

        const nonce = crypto.randomBytes(32).toString('base64url');
        const expiresAt = utcText(new Date(now.getTime() + RECEIPT_TTL_MS));
        const receiptId = await db.insert(
            `INSERT INTO assistant_confirmation_receipts
                (userId, subjectKind, subjectId, action, revision, grantHash, surface, nonceHash, createdAt, expiresAt)
             VALUES (@userId, @subjectKind, @subjectId, @action, @revision, @grantHash, @surface, @nonceHash, @createdAt, @expiresAt)`,
            {
                userId: owner,
                subjectKind: subject,
                subjectId: bound.subjectId,
                action,
                revision: bound.revision,
                grantHash: bound.hash,
                surface,
                nonceHash: sha256(nonce),
                createdAt: utcText(now),
                expiresAt
            }
        );
        return { receipt: `${receiptId}.${nonce}`, expiresAt, surface, shown: bound.shown };
    }

    async _bindResponsibility({ owner, id, action, revision, now }) {
        const responsibilities = require('./assistantResponsibilityService');
        // 404 for anyone else's: no existence leak.
        const shown = await responsibilities.get({ userId: owner, id, now });
        if (shown.proposedBy === 'model' && !(await this._pilotAllows(owner))) throw this._pilotOnly();
        if (Number(revision) !== shown.revision) {
            throw new AssistantConfirmationError('REVISION_CONFLICT',
                'This responsibility changed since you loaded it. Reload and try again.', 409, { revision: shown.revision });
        }
        if (!ACTION_FROM[action].includes(shown.status)) {
            throw new AssistantConfirmationError('INVALID_TRANSITION',
                `Cannot ${action} a ${shown.status.toLowerCase().replace('_', ' ')} responsibility.`, 409, { status: shown.status });
        }
        return { subjectId: String(shown.id), revision: String(shown.revision), hash: this.grantHash(shown), shown };
    }

    async _bindGate({ owner, ref, occurrence, revision }) {
        const gates = require('./assistantGateService');
        const card = await gates.card({ userId: owner, ref });
        if (!card) throw new AssistantConfirmationError('NOT_FOUND', 'No such request.', 404);
        if (card.state !== 'open' || Number(occurrence) !== card.occurrence || String(revision) !== card.revision) {
            throw new AssistantConfirmationError('STALE_GATE',
                card.state === 'open'
                    ? 'This request changed after it was shown. Check it again before deciding.'
                    : `This request was already settled. ${card.outcome}`,
                409, { current: card });
        }
        return { subjectId: card.ref, revision: this.gateRevision(card), hash: this.cardHash(card), shown: card };
    }

    /**
     * Spend a receipt. Call it inside the transaction that performs the
     * confirmed action, with what that action is about to act on: the
     * receipt is spent only when every bound value still matches, it has
     * not expired and nobody spent it first. Anything else throws 403
     * `CONFIRMATION_INVALID`, and nothing says which part failed.
     *
     * @param {Object} params
     * @param {string} params.userId
     * @param {string} params.receipt - `<id>.<secret>` as `mint()` returned it
     * @param {'responsibility'|'gate'} params.subject
     * @param {string|number} params.id
     * @param {string} params.action
     * @param {string|number} params.revision - the subject's revision now
     * @param {string} params.hash - `grantHash()` / `cardHash()` of the subject now
     * @param {'portal'|'chat'} [params.surface] - when the caller requires one
     * @returns {Promise<{ receiptId: number }>}
     */
    async redeem({ userId, receipt, subject, id, action, revision, hash, surface = null, now = new Date() }) {
        if (modelCallScope.active()) throw humanOnly();
        const match = RECEIPT_FORMAT.exec(typeof receipt === 'string' ? receipt : '');
        if (!match || !userId) throw invalid();
        const params = {
            id: Number(match[1]),
            nonceHash: sha256(match[2]),
            userId: String(userId),
            subjectKind: String(subject),
            subjectId: String(id),
            action: String(action),
            revision: String(revision),
            grantHash: String(hash),
            now: utcText(now)
        };
        if (surface) params.surface = String(surface);
        const result = await db.run(
            `UPDATE assistant_confirmation_receipts SET consumedAt = @now
             WHERE id = @id AND nonceHash = @nonceHash AND userId = @userId
               AND subjectKind = @subjectKind AND subjectId = @subjectId AND action = @action
               AND revision = @revision AND grantHash = @grantHash${surface ? ' AND surface = @surface' : ''}
               AND consumedAt IS NULL AND expiresAt >= @now`,
            params
        );
        if (result.changes !== 1) throw invalid();
        return { receiptId: params.id };
    }

    /** Drop the receipts of a subject that no longer exists. */
    async forgetSubject({ subject, id }) {
        const result = await db.run(
            'DELETE FROM assistant_confirmation_receipts WHERE subjectKind = @subjectKind AND subjectId = @subjectId',
            { subjectKind: String(subject), subjectId: String(id) }
        );
        return result.changes;
    }

    /**
     * Retention: a receipt is useless once spent or expired; it is kept for
     * 30 days as the record that a person confirmed, then deleted.
     * @returns {Promise<number>} rows deleted
     */
    async prune({ days = RETENTION_DAYS, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000));
        const result = await db.run(
            'DELETE FROM assistant_confirmation_receipts WHERE expiresAt < @cutoff',
            { cutoff }
        );
        return result.changes;
    }
}

module.exports = new AssistantConfirmationService();
module.exports.AssistantConfirmationService = AssistantConfirmationService;
module.exports.AssistantConfirmationError = AssistantConfirmationError;
module.exports.RECEIPT_TTL_MS = RECEIPT_TTL_MS;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
