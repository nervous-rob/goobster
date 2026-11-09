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
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');
const requireOptional = require('../utils/optionalModule').forModule(module);

const IDENTITY_PREFIX = 'project_gate:';
const OPEN_MISSION_STATUSES = ['DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED', 'REVIEW'];
const GATE_COLUMNS = new Set(['approve', 'review', 'unblock', 'answer']);
const OWNERS_PER_PASS = 200;

class AssistantGateService {
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
module.exports.IDENTITY_PREFIX = IDENTITY_PREFIX;
