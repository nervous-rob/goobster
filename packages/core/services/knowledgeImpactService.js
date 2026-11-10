/**
 * What rests on a source that was withdrawn (DA-3 leftover, ADR 0027;
 * documentation/delegated_knowledge.md, "When a source is withdrawn").
 *
 * When a source is retracted, this finds the person's notes that cite it
 * and the active project assumptions (open missions that link a claim from
 * it as evidence), and files ONE review for them. It never deletes
 * anything and never changes a note by itself:
 *
 *  - The citing rows are marked withdrawn (`kg_provenance.retractedAt`), so
 *    the evidence stops counting; the notes and their text stay.
 *  - The review proposes marking each note "disputed" - an explicit label,
 *    not removal - and the person decides, with the same gate, the same
 *    stale checks and the same revert as a saved-note proposal.
 *  - A source that is gone or cannot be reached is unverifiable, not false:
 *    the review says "unverifiable", never "wrong".
 *
 * Bounded: at most `CHANGE_SETS.maxNotesPerReview` notes are named; the rest
 * are counted. Reviewing the same source while a review is open returns it.
 */

const db = require('../db');
const kg = require('./knowledgeGraphService');
const changes = require('./knowledgeChangeSetService');
const { CHANGE_SETS, PROVENANCE_KINDS } = require('../config/knowledgeGraphConfig');

const OPEN_MISSION_STATUSES = ['DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'REVIEW'];

class ImpactError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ImpactError';
        this.status = status;
        this.code = code;
    }
}

const clip = (value, max) => {
    const text = value == null ? '' : String(value).trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

class KnowledgeImpactService {
    /**
     * The source rows a retraction of this source covers: a research source
     * also covers the claims extracted from it.
     * @returns {Promise<{ label: string|null, pairs: Array<{ kind: string, id: number }>, claimIds: number[] }|null>}
     */
    async _resolve({ userId, sourceKind, sourceId }) {
        const id = Number(sourceId);
        if (!Number.isSafeInteger(id) || id <= 0) return null;
        if (sourceKind === 'research_source') {
            const source = await db.get(
                'SELECT id, title, url FROM research_sources WHERE id = @id AND userId = @userId', { id, userId: String(userId) }
            );
            if (!source) return null;
            const claims = await db.all('SELECT id FROM research_claims WHERE sourceId = @id', { id });
            const claimIds = claims.map(row => Number(row.id));
            return {
                label: source.title || source.url || `source #${id}`,
                pairs: [{ kind: 'research_source', id }, ...claimIds.map(claim => ({ kind: 'research_claim', id: claim }))],
                claimIds
            };
        }
        if (sourceKind === 'research_claim') {
            const claim = await db.get(
                `SELECT c.id, c.text FROM research_claims c JOIN research_sources s ON s.id = c.sourceId
                 WHERE c.id = @id AND s.userId = @userId`, { id, userId: String(userId) }
            );
            if (!claim) return null;
            return { label: clip(claim.text, 80), pairs: [{ kind: 'research_claim', id }], claimIds: [id] };
        }
        // Any other kind a note can cite (a memory, a saved file): the person's own notes are what is searched.
        return { label: `${sourceKind} #${id}`, pairs: [{ kind: sourceKind, id }], claimIds: [] };
    }

    /** Open missions of this person's projects that link one of these claims as evidence. */
    async _assumptions({ userId, claimIds }) {
        if (!claimIds.length) return [];
        const params = { userId: String(userId) };
        const names = claimIds.map((claim, index) => {
            params[`c${index}`] = claim;
            return `@c${index}`;
        });
        const statuses = OPEN_MISSION_STATUSES.map((status, index) => {
            params[`s${index}`] = status;
            return `@s${index}`;
        });
        const rows = await db.all(
            `SELECT m.id AS missionId, m.title, m.status, p.slug, ev.id AS evidenceId, ev.criterionId, ev.polarity
             FROM project_mission_evidence ev
             JOIN project_missions m ON m.id = ev.missionId
             JOIN observatory_projects p ON p.id = m.projectId
             WHERE ev.kind = 'claim' AND ev.refId IN (${names.join(', ')})
               AND m.userId = @userId AND m.status IN (${statuses.join(', ')})
             ORDER BY m.id, ev.id LIMIT 50`,
            params
        );
        return rows.map(row => ({
            missionId: Number(row.missionId),
            title: clip(row.title, 120),
            status: row.status,
            project: row.slug,
            criterionId: row.criterionId || null,
            polarity: row.polarity
        }));
    }

    /**
     * Review what rests on a withdrawn source.
     * @param {{ userId: string, guildId: string, sourceKind: string, sourceId: number|string, reason?: string }} params
     * @returns {Promise<{ affected: number, id: number|null, existing?: boolean, notes: number, assumptions: number }>}
     */
    async reviewRetraction({ userId, guildId, sourceKind, sourceId, reason = '' }) {
        if (!PROVENANCE_KINDS.includes(sourceKind)) throw new ImpactError(400, 'BAD_REQUEST', 'That kind of source is not tracked.');
        const resolved = await this._resolve({ userId, sourceKind, sourceId });
        if (!resolved) throw new ImpactError(404, 'NOT_FOUND', 'No such source.');

        return db.transaction(async () => {
            const cited = new Map();
            for (const pair of resolved.pairs) {
                const rows = await kg.notesCitingSource({
                    guildId, userId, sourceKind: pair.kind, sourceId: pair.id, limit: CHANGE_SETS.maxNotesPerReview + 1
                });
                for (const row of rows) if (!cited.has(row.id)) cited.set(row.id, row);
            }
            const assumptions = await this._assumptions({ userId, claimIds: resolved.claimIds });
            for (const pair of resolved.pairs) {
                await kg.withdrawSource({ guildId, userId, sourceKind: pair.kind, sourceId: pair.id });
            }

            // Notes already labelled as not current need nothing from the person.
            const candidates = [...cited.values()].filter(note => (note.claimStatus || 'current') === 'current');
            if (!candidates.length && !assumptions.length) return { affected: 0, id: null, notes: 0, assumptions: 0 };

            const open = await db.all(
                `SELECT * FROM kg_change_sets WHERE userId = @userId AND kind = 'source_retraction' AND status = 'PROPOSED'`,
                { userId: String(userId) }
            );
            const sourceKey = `${sourceKind}:${Number(sourceId)}`;
            const same = open.find(row => JSON.parse(row.impactJson || '{}')?.source?.key === sourceKey);
            if (same) {
                return { affected: candidates.length, id: Number(same.id), existing: true, notes: candidates.length, assumptions: assumptions.length };
            }

            const named = candidates.slice(0, CHANGE_SETS.maxNotesPerReview);
            const impact = {
                source: { key: sourceKey, kind: sourceKind, id: Number(sourceId), label: clip(resolved.label, 160) },
                reason: clip(reason, CHANGE_SETS.maxReasonLength) || null,
                notes: named.map(note => ({ id: Number(note.id), label: note.label, revision: Number(note.revision), curation: note.curation })),
                moreNotes: candidates.length - named.length,
                assumptions
            };
            const id = Number(await db.insert(
                `INSERT INTO kg_change_sets
                    (userId, guildId, scopeKey, kind, status, operationsJson, rationale, impactJson, policyCode)
                 VALUES (@userId, @guildId, @scopeKey, 'source_retraction', 'PROPOSED', @operationsJson, @rationale,
                         @impactJson, 'SOURCE_RETRACTED')`,
                {
                    userId: String(userId), guildId, scopeKey: kg.resolveScopeKey({ subjectType: 'USER', subjectId: userId }),
                    operationsJson: JSON.stringify(named.map(note => ({ op: 'dispute', nodeId: Number(note.id) }))),
                    rationale: impact.reason, impactJson: JSON.stringify(impact)
                }
            ));
            await changes.publishGate(await changes.get(id));
            return { affected: candidates.length, id, notes: candidates.length, assumptions: assumptions.length };
        }).then(async (result) => {
            // The Inbox envelope was left pending inside the transaction.
            if (result.id && !result.existing) {
                await require('./assistantUpdateService').deliverPending({ userId: String(userId) }).catch(() => {});
            }
            return result;
        });
    }
}

module.exports = new KnowledgeImpactService();
module.exports.ImpactError = ImpactError;
