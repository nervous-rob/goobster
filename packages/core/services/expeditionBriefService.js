/**
 * Research briefs (roadmap #254): a private artifact written from one
 * Expedition's stored sources and claims. Spec: documentation/research_brief.md
 *
 * The rules this service enforces:
 *
 *  - **The generated text is immutable.** generatedJson and generatedHash
 *    are written exactly once, when a GENERATING row becomes READY. No
 *    method here updates them afterwards, and every read re-hashes the
 *    stored text so a tampered row is reported (`integrity: 'mismatch'`)
 *    instead of trusted.
 *  - **Edits are an overlay.** The owner's wording and factual corrections
 *    live in overlayJson, applied at read time on top of the original
 *    (utils/expeditionBrief.render), so generated and edited text stay
 *    distinguishable and the edit type (none / wording / factual) is a
 *    property of the overlay, never a rewrite.
 *  - **Private to the expedition's owner.** Every read, generation, edit,
 *    review, acceptance and export path resolves the expedition through
 *    spitballExpeditionService.getExpedition (owner-only, strangers get the
 *    same 404 as a missing row) and re-checks the brief's own userId. A
 *    project member who can list a project's expeditions cannot read a
 *    brief they did not run; share links are deliberately later work.
 *  - **The cost joins the expedition's work.** Generation runs inside the
 *    expedition's work reference `(expedition, <id>)` with the expedition's
 *    payer (the project owner for a project expedition), so
 *    costReportService.costPerResult({ workKind: 'expedition' }) needs no
 *    new column. A failed attempt keeps its FAILED row and writes one
 *    work_failures row (phase `brief`), never the prompt or the output.
 *  - **Acceptance and use are explicit.** `acceptedAt` and `usedAt` are set
 *    only by the owner's actions and never inferred from a READY row or
 *    from the quality status; measure() reports cost per accepted brief as
 *    N/A (null) when nothing is accepted.
 */

'use strict';

const db = require('../db');
const logger = require('../utils/logger');
const workContext = require('../utils/workContext');
const { editConflict } = require('../utils/editConflict');
const brief = require('../utils/expeditionBrief');
const expeditionService = require('./spitballExpeditionService');
const { SpitballError } = require('./spitballExpeditionService');

/** Codes that name a cause the person can act on; anything else is a generation failure. */
const PASSTHROUGH_CODES = new Set(['BUDGET_EXCEEDED', 'CANCELLED', 'BUSY', 'ACCOUNT_DISABLED', 'BRIEF_FORMAT_INVALID']);
/** Visible output allowance; thinking headroom is added by utils/aiTokenBudget.js. */
const MAX_VISIBLE_TOKENS = 2200;

const utc = (date = new Date()) => date.toISOString().slice(0, 19).replace('T', ' ');
const parseJson = text => {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
};
const clip = (value, max) => {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, max) : null;
};

class ExpeditionBriefService {
    /**
     * @param {Object} [deps]
     * @param {Object} [deps.ai] - { chat } (defaults to aiService, resolved lazily)
     * @param {Object} [deps.expeditions] - spitballExpeditionService
     * @param {Object} [deps.costs] - costReportService
     * @param {Object} [deps.failures] - workFailureService
     */
    constructor({ ai = null, expeditions = expeditionService, costs = null, failures = null } = {}) {
        this._ai = ai;
        this.expeditions = expeditions;
        this._costs = costs;
        this._failures = failures;
    }

    get ai() {
        if (!this._ai) this._ai = require('./aiService');
        return this._ai;
    }

    get costs() {
        if (!this._costs) this._costs = require('./costReportService');
        return this._costs;
    }

    get failures() {
        if (!this._failures) this._failures = require('./workFailureService');
        return this._failures;
    }

    // --- Ownership -----------------------------------------------------------------

    /** Owner-checked expedition (404 for strangers and for missing rows). */
    async _ownedExpedition(expeditionId, userId) {
        if (!userId) throw new SpitballError(400, 'BAD_REQUEST', 'A user is required.');
        return this.expeditions.getExpedition(expeditionId, { userId });
    }

    /**
     * Owner-checked brief row. The brief's denormalized userId and the
     * expedition's userId must both name the caller; an id alone grants nothing.
     */
    async _ownedRow(briefId, userId, { handle = db } = {}) {
        if (!userId) throw new SpitballError(400, 'BAD_REQUEST', 'A user is required.');
        const id = Number(briefId);
        const row = Number.isInteger(id) && id > 0
            ? await handle.get(
                `SELECT b.* FROM expedition_briefs b
                 JOIN spitball_expeditions e ON e.id = b.expeditionId
                 WHERE b.id = @id AND b.userId = @userId AND e.userId = @userId`,
                { id, userId: String(userId) }
            )
            : null;
        if (!row) throw new SpitballError(404, 'NOT_FOUND', 'No such brief.');
        return row;
    }

    // --- Generation ----------------------------------------------------------------

    /**
     * Gather the expedition's stored evidence and write a new brief. The
     * expedition must not be running (its evidence would still be moving).
     * A generation failure still returns the (FAILED) brief so the attempt
     * is visible and counted.
     * @returns {Promise<Object>} the brief detail (see get())
     */
    async generate({ expeditionId, userId, signal = null } = {}) {
        const expedition = await this._ownedExpedition(expeditionId, userId);
        if (['QUEUED', 'RUNNING'].includes(expedition.status)) {
            throw new SpitballError(409, 'EXPEDITION_ACTIVE', 'Wait for the expedition to stop before writing a brief from its evidence.');
        }
        const [sources, claims, cycles] = await Promise.all([
            this.expeditions.listSources(expedition.id, { userId }),
            this.expeditions.listClaims(expedition.id, { userId }),
            this.expeditions.listCycles(expedition.id, { userId })
        ]);
        const packet = brief.buildEvidencePacket({ expedition, sources, claims, cycles });
        if (packet.claims.length === 0) {
            throw new SpitballError(409, 'NO_EVIDENCE', 'This expedition has no accepted sources with claims to write from.');
        }
        const payer = await this.expeditions.payerFor(expedition);
        const modelConfig = expedition.modelConfig || {};
        const briefId = await db.insert(
            `INSERT INTO expedition_briefs (expeditionId, userId, payer, status, promptVersion, modelProvider, modelName)
             VALUES (@expeditionId, @userId, @payer, 'GENERATING', @promptVersion, @modelProvider, @modelName)`,
            {
                expeditionId: expedition.id,
                userId: String(userId),
                payer: payer || null,
                promptVersion: brief.PROMPT_VERSION,
                modelProvider: modelConfig.provider || null,
                modelName: modelConfig.model || null
            }
        );

        const messages = brief.buildMessages(packet);
        await workContext.run(
            { kind: 'expedition', id: expedition.id, actor: String(userId), payer: payer || String(userId) },
            async () => {
                try {
                    const opts = { max_tokens: MAX_VISIBLE_TOKENS, usageContext: { userId: String(userId), guildId: expedition.guildId } };
                    if (modelConfig.provider) opts.provider = modelConfig.provider;
                    if (modelConfig.model) opts.model = modelConfig.model;
                    if (signal) opts.signal = signal;
                    const response = await this.ai.chat(messages, opts);
                    const parsed = brief.parseGenerated(response?.content, packet);
                    const generated = brief.finalizeGenerated(parsed, packet);
                    const generatedJson = JSON.stringify(generated);
                    // The one and only write of the generated text. Guarded on
                    // status so a late callback can never overwrite a READY row.
                    await db.run(
                        `UPDATE expedition_briefs
                         SET status = 'READY', generatedJson = @generatedJson, generatedHash = @generatedHash,
                             generatedAt = @now, updatedAt = @now
                         WHERE id = @id AND status = 'GENERATING'`,
                        { id: briefId, generatedJson, generatedHash: brief.hashGenerated(generated), now: utc() }
                    );
                } catch (error) {
                    const code = PASSTHROUGH_CODES.has(error?.code) ? error.code : 'BRIEF_GENERATION_FAILED';
                    const reason = clip(error?.message, 300) || 'The brief could not be generated.';
                    await db.run(
                        `UPDATE expedition_briefs
                         SET status = 'FAILED', errorCode = @code, lastError = @reason, updatedAt = @now
                         WHERE id = @id AND status = 'GENERATING'`,
                        { id: briefId, code, reason, now: utc() }
                    );
                    await this.failures.note({
                        kind: 'expedition', workId: expedition.id, actor: String(userId),
                        phase: 'brief', code, reason
                    });
                    logger.warn?.(`[brief] Expedition #${expedition.id} brief #${briefId} failed: ${code}`);
                }
            },
            { replace: true }
        );
        return this.get(briefId, { userId });
    }

    // --- Reads -----------------------------------------------------------------------

    /** Every brief written for one of the caller's expeditions, newest first. */
    async list({ expeditionId, userId } = {}) {
        const expedition = await this._ownedExpedition(expeditionId, userId);
        const rows = await db.all(
            `SELECT * FROM expedition_briefs WHERE expeditionId = @expeditionId AND userId = @userId ORDER BY id DESC`,
            { expeditionId: expedition.id, userId: String(userId) }
        );
        return rows.map(row => this._shapeSummary(row));
    }

    /**
     * One brief: metadata, the immutable generated text, the overlay, the
     * review, the rendered view (generated + overlay, distinguishable) and
     * the derived quality status.
     */
    async get(briefId, { userId } = {}) {
        const row = await this._ownedRow(briefId, userId);
        return this._shapeDetail(row);
    }

    // --- Overlay ---------------------------------------------------------------------

    /**
     * Replace the edit overlay. The whole overlay is sent each time (an edit
     * with empty text removes that target's edit); `expectedRevision` makes
     * a stale tab lose with EDIT_CONFLICT instead of overwriting.
     */
    async updateOverlay(briefId, { userId, edits, expectedRevision = null } = {}) {
        return db.transaction(async (tx) => {
            const row = await this._ownedRow(briefId, userId, { handle: tx });
            if (row.status !== 'READY') throw new SpitballError(409, 'NOT_READY', 'Only a generated brief can be edited.');
            const generated = parseJson(row.generatedJson);
            const previous = parseJson(row.overlayJson);
            const overlay = brief.normalizeOverlay({ edits }, generated, { previous });
            const revision = expectedRevision == null ? Number(row.overlayRevision) : Number(expectedRevision);
            const changed = await tx.run(
                `UPDATE expedition_briefs
                 SET overlayJson = @overlayJson, overlayRevision = overlayRevision + 1, updatedAt = @now
                 WHERE id = @id AND overlayRevision = @revision`,
                { id: row.id, overlayJson: JSON.stringify(overlay), revision, now: utc() }
            );
            if (!changed.changes) {
                const current = await tx.get('SELECT overlayRevision FROM expedition_briefs WHERE id = @id', { id: row.id });
                throw editConflict(current?.overlayRevision);
            }
            return this._shapeDetail(await tx.get('SELECT * FROM expedition_briefs WHERE id = @id', { id: row.id }));
        });
    }

    // --- Review, acceptance, use -------------------------------------------------------

    /** Replace the owner's review record (marks, rationale, gates, notes). */
    async updateReview(briefId, { userId, marks, rationale, gates, notes, expectedRevision = null } = {}) {
        return db.transaction(async (tx) => {
            const row = await this._ownedRow(briefId, userId, { handle: tx });
            if (row.status !== 'READY') throw new SpitballError(409, 'NOT_READY', 'Only a generated brief can be reviewed.');
            const generated = parseJson(row.generatedJson);
            const review = brief.normalizeReview({ marks, rationale, gates, notes }, generated);
            const revision = expectedRevision == null ? Number(row.reviewRevision) : Number(expectedRevision);
            const changed = await tx.run(
                `UPDATE expedition_briefs
                 SET reviewJson = @reviewJson, reviewRevision = reviewRevision + 1, updatedAt = @now
                 WHERE id = @id AND reviewRevision = @revision`,
                { id: row.id, reviewJson: JSON.stringify(review), revision, now: utc() }
            );
            if (!changed.changes) {
                const current = await tx.get('SELECT reviewRevision FROM expedition_briefs WHERE id = @id', { id: row.id });
                throw editConflict(current?.reviewRevision);
            }
            return this._shapeDetail(await tx.get('SELECT * FROM expedition_briefs WHERE id = @id', { id: row.id }));
        });
    }

    /** The owner's explicit acceptance (or its withdrawal). Never inferred. */
    async setAccepted(briefId, { userId, accepted } = {}) {
        const row = await this._ownedRow(briefId, userId);
        if (row.status !== 'READY') throw new SpitballError(409, 'NOT_READY', 'Only a generated brief can be accepted.');
        await db.run(
            `UPDATE expedition_briefs SET acceptedAt = @acceptedAt, updatedAt = @now WHERE id = @id`,
            { id: row.id, acceptedAt: accepted ? utc() : null, now: utc() }
        );
        return this.get(row.id, { userId });
    }

    /** Actual use, recorded separately from acceptance, with an optional short note. */
    async setUsed(briefId, { userId, used, note = null } = {}) {
        const row = await this._ownedRow(briefId, userId);
        if (row.status !== 'READY') throw new SpitballError(409, 'NOT_READY', 'Only a generated brief can be marked used.');
        await db.run(
            `UPDATE expedition_briefs SET usedAt = @usedAt, useNote = @useNote, updatedAt = @now WHERE id = @id`,
            { id: row.id, usedAt: used ? utc() : null, useNote: used ? clip(note, brief.CAPS.maxUseNoteChars) : null, now: utc() }
        );
        return this.get(row.id, { userId });
    }

    // --- Export ----------------------------------------------------------------------

    /** @returns {Promise<{ filename: string, markdown: string }>} */
    async exportMarkdown(briefId, { userId } = {}) {
        const row = await this._ownedRow(briefId, userId);
        if (row.status !== 'READY') throw new SpitballError(409, 'NOT_READY', 'Only a generated brief can be exported.');
        const generated = parseJson(row.generatedJson);
        const expedition = await this.expeditions.getById(row.expeditionId);
        const markdown = brief.exportMarkdown({
            brief: row, expedition, generated,
            overlay: parseJson(row.overlayJson), review: parseJson(row.reviewJson)
        });
        return { filename: brief.exportFilename({ brief: row, generated }), markdown };
    }

    // --- Measurement -----------------------------------------------------------------

    /**
     * What #265 measures: briefs written, accepted and used, the edit type
     * per brief, the quality-bar status, and the expedition-level cost of
     * every expedition that has a brief in the window - including failed
     * attempts - divided by the accepted briefs. Tokens and resource
     * quantities stay separate units; zero accepted means N/A (null), not 0.
     */
    async measure({ userId, days = 30 } = {}) {
        if (!userId) throw new SpitballError(400, 'BAD_REQUEST', 'A user is required.');
        const window = Math.min(Math.max(Math.trunc(Number(days) || 30), 1), 365);
        const since = utc(new Date(Date.now() - window * 86_400_000));
        const rows = await db.all(
            `SELECT id, expeditionId, status, overlayJson, reviewJson, generatedJson, acceptedAt, usedAt, createdAt
             FROM expedition_briefs WHERE userId = @userId AND createdAt >= @since ORDER BY id`,
            { userId: String(userId), since }
        );
        const briefs = {
            total: rows.length, ready: 0, failed: 0, generating: 0,
            accepted: 0, used: 0, acceptedAndUsed: 0,
            editType: { none: 0, wording: 0, factual: 0 },
            quality: { unreviewed: 0, 'not-ready': 0, 'ready-to-show': 0 }
        };
        const acceptedIds = [];
        for (const row of rows) {
            if (row.status === 'READY') briefs.ready += 1;
            else if (row.status === 'FAILED') briefs.failed += 1;
            else briefs.generating += 1;
            if (row.acceptedAt) { briefs.accepted += 1; acceptedIds.push(row.id); }
            if (row.usedAt) briefs.used += 1;
            if (row.acceptedAt && row.usedAt) briefs.acceptedAndUsed += 1;
            if (row.status === 'READY') {
                const overlay = parseJson(row.overlayJson);
                briefs.editType[brief.editTypeOf(overlay)] += 1;
                const quality = brief.qualityStatus({ generated: parseJson(row.generatedJson), overlay, review: parseJson(row.reviewJson) });
                briefs.quality[quality.status] += 1;
            }
        }
        const expeditionIds = [...new Set(rows.map(row => String(row.expeditionId)))];
        const idSet = new Set(expeditionIds);
        const costRows = expeditionIds.length > 0
            ? (await this.costs.workCosts({ workKind: 'expedition' })).filter(row => idSet.has(String(row.workId)))
            : [];
        const totals = { actualTokens: 0, estimatedTokens: 0, resources: {}, failures: 0 };
        for (const row of costRows) {
            totals.actualTokens += row.actualTokens;
            totals.estimatedTokens += row.estimatedTokens;
            totals.failures += row.failures;
            for (const [kind, quantity] of Object.entries(row.resources)) {
                totals.resources[kind] = (totals.resources[kind] || 0) + quantity;
            }
        }
        let status = 'unavailable';
        if (expeditionIds.length > 0) {
            const flags = await db.get(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN status = 'held' OR reconcile = 1 THEN 1 ELSE 0 END) AS uncertain
                 FROM usage_reservations
                 WHERE workKind = 'expedition' AND workId IN (${expeditionIds.map((_, i) => `@w${i}`).join(',')})`,
                Object.fromEntries(expeditionIds.map((id, i) => [`w${i}`, id]))
            );
            if (Number(flags?.total || 0) > 0) status = Number(flags?.uncertain || 0) > 0 ? 'provisional' : 'settled';
        }
        // N/A (null) - never 0 - when nothing was accepted or no cost was recorded.
        const perAccepted = briefs.accepted > 0 && status !== 'unavailable'
            ? {
                actualTokens: totals.actualTokens / briefs.accepted,
                resources: Object.fromEntries(Object.entries(totals.resources).map(([kind, quantity]) => [kind, quantity / briefs.accepted]))
            }
            : null;
        let note;
        if (briefs.accepted === 0) note = 'No accepted brief in this window: cost per accepted brief is not available (not zero).';
        else if (status === 'unavailable') note = 'No token reservation was recorded for these expeditions: cost per accepted brief is not available (not zero).';
        else note = 'Expedition-level work (research cycles and every brief attempt, failed ones included) for the expeditions with a brief in this window, divided by accepted briefs. Tokens and resource units are separate; there is no price.'
            + (status === 'provisional' ? ' Some settlements are estimates (held or reconcile = 1); treat the totals as provisional.' : '');
        return {
            days: window,
            since,
            briefs,
            expeditions: expeditionIds.length,
            cost: { status, totals, perAccepted, acceptedBriefIds: acceptedIds, note }
        };
    }

    // --- Privacy ---------------------------------------------------------------------

    /** Row counts for the leftover audit and the transparency report. */
    async auditUser(userId) {
        const row = await db.get(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN acceptedAt IS NOT NULL THEN 1 ELSE 0 END) AS accepted,
                    SUM(CASE WHEN usedAt IS NOT NULL THEN 1 ELSE 0 END) AS used,
                    SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
             FROM expedition_briefs WHERE userId = @userId`,
            { userId: String(userId) }
        );
        const paying = await db.get(
            'SELECT COUNT(*) AS c FROM expedition_briefs WHERE payer = @userId AND userId <> @userId',
            { userId: String(userId) }
        );
        return {
            briefs: Number(row?.total || 0),
            accepted: Number(row?.accepted || 0),
            used: Number(row?.used || 0),
            failed: Number(row?.failed || 0),
            paidForOthers: Number(paying?.c || 0)
        };
    }

    /**
     * Erasure: the person's briefs go (they also cascade with the
     * expeditions); briefs someone else owns that this person paid for keep
     * the row with the payer nulled, the same rule as resource_events.
     * @param {Object} [handle] - transaction handle when called inside one
     */
    async forgetUser(userId, handle = db) {
        const deleted = (await handle.run('DELETE FROM expedition_briefs WHERE userId = @userId', { userId: String(userId) })).changes;
        const anonymized = (await handle.run(
            'UPDATE expedition_briefs SET payer = NULL WHERE payer = @userId', { userId: String(userId) }
        )).changes;
        return { deleted, anonymized };
    }

    // --- Shaping ---------------------------------------------------------------------

    _meta(row) {
        return {
            id: row.id,
            expeditionId: row.expeditionId,
            status: row.status,
            payer: row.payer || null,
            generatedAt: row.generatedAt || null,
            generatedHash: row.generatedHash || null,
            promptVersion: row.promptVersion || null,
            model: { provider: row.modelProvider || null, name: row.modelName || null },
            errorCode: row.errorCode || null,
            lastError: row.lastError || null,
            overlayRevision: Number(row.overlayRevision || 0),
            reviewRevision: Number(row.reviewRevision || 0),
            acceptedAt: row.acceptedAt || null,
            usedAt: row.usedAt || null,
            useNote: row.useNote || null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        };
    }

    _shapeSummary(row) {
        const meta = this._meta(row);
        if (row.status !== 'READY') return { ...meta, editType: null, quality: null, findings: 0 };
        const generated = parseJson(row.generatedJson);
        const overlay = parseJson(row.overlayJson);
        const quality = brief.qualityStatus({ generated, overlay, review: parseJson(row.reviewJson) });
        return { ...meta, editType: quality.editType, quality: quality.status, findings: generated?.findings?.length || 0 };
    }

    _shapeDetail(row) {
        const meta = this._meta(row);
        if (row.status !== 'READY') {
            return { brief: meta, generated: null, overlay: { edits: [] }, review: null, rendered: null, quality: null, integrity: null };
        }
        const generated = parseJson(row.generatedJson);
        const overlay = parseJson(row.overlayJson) || { edits: [] };
        const review = parseJson(row.reviewJson);
        const quality = brief.qualityStatus({ generated, overlay, review });
        return {
            brief: meta,
            generated,
            overlay,
            review,
            rendered: brief.render(generated, overlay),
            quality,
            integrity: generated && brief.hashGenerated(generated) === row.generatedHash ? 'verified' : 'mismatch'
        };
    }
}

module.exports = new ExpeditionBriefService();
module.exports.ExpeditionBriefService = ExpeditionBriefService;
