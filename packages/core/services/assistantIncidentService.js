/**
 * Process incidents and what the assistant says about them (DA-5a, ADR 0019).
 *
 * `assistantProcessService.assess()` judges each process on every read and
 * records nothing. This service is the part that remembers: on the steward
 * pass it turns "this process is not working" into one incident per cause,
 * keeps that incident through recovery, and files one canonical update for
 * it. It observes and reports. It never pauses, repairs, archives or
 * deletes a process, and it never runs a model.
 *
 * An incident opens when a process has failed `incidentFailures` times
 * running or has been stalled for `stalledIncidentSeconds` while this
 * installation was running. Processes
 * failing with the same upstream cause share one incident (`cause:<CODE>`),
 * and a process that depends on a failing one joins that incident as a
 * dependent instead of getting its own.
 *
 * Lifecycle: OPEN -> RECOVERING -> RESOLVED.
 *  - While any member is failing, or has had fewer than `recoveryOk` clean
 *    runs since it failed, the incident stays OPEN.
 *  - RECOVERING lasts `cooldownSeconds`. A failure inside it reopens the
 *    same incident and announces nothing new.
 *  - Only after the cooldown is it RESOLVED, with one closing revision of
 *    its update. A later failure streak is a new occurrence.
 *
 * Nothing is opened or announced for a person who has not turned Attention
 * on; an incident that is already open still runs to its end.
 *
 * Seams for later stages: a repair attempt (DA-5c) refers to an incident by
 * id and adds a gate to its update; a pause or archive proposal (DA-5b)
 * adds a gate to the `process_relevance:<ref>` update filed here.
 *
 * Spec: documentation/process_stewardship.md.
 */

const db = require('../db');
const logger = require('../utils/logger');
const { features } = require('../features/featureState');
const assessment = require('./assistant/processes/assessment');

const INCIDENT_IDENTITY = 'process_incident:';
const RELEVANCE_IDENTITY = 'process_relevance:';
const OWNER_PAGE = 100;
const MEMBERS_NAMED = 6;
const CRITICALITY_RANK = { low: 0, normal: 1, high: 2 };
const WINDOW_DAYS = 90;
/** What a stall incident records as its cause (there is no failure code to record). */
const STALL_CODES = ['SCHEDULE_OVERDUE', 'CADENCE_MISSED'];

/** How loudly a candidate may land, by the most critical process involved. */
const HEALTH_WEIGHT = {
    high: { urgency: 0.9, importance: 0.9 },
    normal: { urgency: 0.7, importance: 0.7 },
    low: { urgency: 0.45, importance: 0.45 }
};

/** Why a process's purpose is over, in a sentence. */
const ENDED_TEXT = {
    GOAL_RESOLVED: 'The goal it was set up for is resolved.',
    GOAL_ABANDONED: 'The goal it was set up for was dropped.',
    TARGET_MERGED: 'What it was watching has been merged.',
    TARGET_CLOSED: 'What it was watching has been closed.',
    TARGET_DONE: 'What it was watching is finished.',
    TARGET_DELETED: 'What it was watching has been deleted.',
    TARGET_GONE: 'What it was watching is gone.',
    TARGET_SUPERSEDED: 'What it was watching has been replaced.',
    FIRED_FOR_GOOD: 'It has fired as many times as it was set to.'
};

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function quoted(name) {
    return `"${String(name || 'A process').slice(0, 80)}"`;
}

function nameList(names) {
    const shown = names.slice(0, MEMBERS_NAMED).map(quoted).join(', ');
    return names.length > MEMBERS_NAMED ? `${shown} and ${names.length - MEMBERS_NAMED} more` : shown;
}

class AssistantIncidentService {
    constructor() {
        this.DEFAULTS = assessment.DEFAULTS;
    }

    _present(row, members) {
        return {
            id: Number(row.id),
            key: row.incidentKey,
            occurrence: Number(row.occurrence),
            status: row.status,
            causeCode: row.causeCode || null,
            criticality: row.criticality,
            resolution: row.resolution || null,
            updateId: row.updateId == null ? null : Number(row.updateId),
            openedAt: row.openedAt,
            recoveringSince: row.recoveringSince || null,
            resolvedAt: row.resolvedAt || null,
            members: members.map(member => ({
                ref: `${member.processKind}:${member.processId}`,
                name: member.name || null,
                role: member.role,
                state: member.state
            }))
        };
    }

    /** A person's incidents that are not resolved, oldest first, each with its members. */
    async list({ userId }) {
        const owner = String(userId);
        const rows = await db.all(
            "SELECT * FROM assistant_process_incidents WHERE ownerUserId = @owner AND status <> 'RESOLVED' ORDER BY id",
            { owner }
        );
        if (!rows.length) return { incidents: [] };
        const members = await db.all(
            `SELECT m.* FROM assistant_process_incident_members m
             JOIN assistant_process_incidents i ON i.id = m.incidentId
             WHERE i.ownerUserId = @owner AND i.status <> 'RESOLVED'
             ORDER BY m.incidentId, m.processKind, m.processId`,
            { owner }
        );
        return {
            incidents: rows.map(row => this._present(row, members.filter(member => Number(member.incidentId) === Number(row.id))))
        };
    }

    /**
     * The incident each process is part of right now, by reference. A process
     * in two (it recovered from one cause and is failing for another) shows
     * the one it is still failing in.
     * @returns {Promise<Map<string, Object>>}
     */
    async membership({ userId }) {
        const out = new Map();
        const { incidents } = await this.list({ userId });
        for (const incident of incidents) {
            for (const member of incident.members) {
                const held = out.get(member.ref);
                if (held && held.state !== 'clear' && member.state === 'clear') continue;
                out.set(member.ref, {
                    id: incident.id,
                    key: incident.key,
                    status: incident.status,
                    causeCode: incident.causeCode,
                    role: member.role,
                    state: member.state,
                    openedAt: incident.openedAt,
                    recoveringSince: incident.recoveringSince,
                    members: incident.members.length
                });
            }
        }
        return out;
    }

    /** People to look at this pass: Attention on and something observed or described, or an incident still open. */
    async _owners(after, now) {
        const rows = await db.all(
            `SELECT userId, MAX(announce) AS announce FROM (
                 SELECT p.userId AS userId, 1 AS announce FROM attention_policies p
                 WHERE p.enabled = 1 AND p.userId > @after AND (
                     EXISTS (SELECT 1 FROM assistant_process_observations o WHERE o.ownerUserId = p.userId AND o.observedAt >= @since)
                     OR EXISTS (SELECT 1 FROM assistant_process_contracts c WHERE c.ownerUserId = p.userId))
                 UNION ALL
                 SELECT i.ownerUserId AS userId, 0 AS announce FROM assistant_process_incidents i
                 WHERE i.status <> 'RESOLVED' AND i.ownerUserId > @after
             ) owners GROUP BY userId ORDER BY userId LIMIT ${OWNER_PAGE}`,
            { after, since: utcText(new Date(now.getTime() - WINDOW_DAYS * 86400000)) }
        );
        return rows.map(row => ({ userId: String(row.userId), announce: Number(row.announce) === 1 }));
    }

    /**
     * One pass over incidents and relevance announcements.
     *
     * @param {Object} [params]
     * @param {string} [params.userId] - one person, or everyone due
     * @param {Date} [params.now]
     * @param {Date} [params.upSince] - since when this installation has been
     *   running without a gap. A schedule that slipped while nothing ran is
     *   not the process's failure, so a stall opens an incident only once it
     *   has lasted `stalledIncidentSeconds` of that time. Omitted: no limit.
     * @returns {Promise<{ owners: number, opened: number, reopened: number, recovering: number, resolved: number, relevance: number }>}
     */
    async reconcile({ userId = null, now = new Date(), upSince = null } = {}) {
        const result = { owners: 0, opened: 0, reopened: 0, recovering: 0, resolved: 0, relevance: 0 };
        if (features.enforcedOff('assistant')) return result;
        let after = '';
        for (;;) {
            let owners;
            if (userId) {
                const policy = await require('./attentionPolicyService').get(String(userId));
                owners = [{ userId: String(userId), announce: Boolean(policy?.enabled) }];
            } else {
                owners = await this._owners(after, now);
            }
            for (const owner of owners) {
                try {
                    const outcome = await this._reconcileOwner(owner.userId, { now, announce: owner.announce, upSince });
                    result.owners += 1;
                    for (const key of ['opened', 'reopened', 'recovering', 'resolved', 'relevance']) result[key] += outcome[key];
                } catch (error) {
                    logger.warn?.(`[assistant incidents] pass failed for one person: ${error.message}`);
                }
            }
            if (userId || owners.length < OWNER_PAGE) break;
            after = owners[owners.length - 1].userId;
        }
        return result;
    }

    async _reconcileOwner(owner, { now, announce, upSince }) {
        const result = { opened: 0, reopened: 0, recovering: 0, resolved: 0, relevance: 0 };
        const { processes: entries } = await require('./assistantProcessService').assess({ userId: owner, now });
        const byRef = new Map(entries.map(entry => [entry.ref, entry]));
        const { incidents: open } = await this.list({ userId: owner });
        const settings = assessment.DEFAULTS;
        const upSeconds = upSince ? Math.max(0, (now.getTime() - new Date(upSince).getTime()) / 1000) : Infinity;

        // An incident this process is already in, for the cause it is failing with now.
        const held = (ref, causeCode) => open.find(incident => incident.members.some(member => member.ref === ref)
            && (incident.key === `process:${ref}` || (incident.key.startsWith('cause:') && causeCode && incident.causeCode === causeCode)));

        const desired = new Map();
        const placed = new Map();
        const place = (key, causeCode, entry, role) => {
            const want = desired.get(key) || { key, causeCode: causeCode || null, members: new Map() };
            want.members.set(entry.ref, { entry, role });
            desired.set(key, want);
            placed.set(entry.ref, key);
        };
        for (const entry of entries) {
            const judged = entry.assessment;
            if (!entry.described.enabled || judged.reasons.execution === 'DEPENDENCY_BLOCKED') continue;
            const sticky = held(entry.ref, judged.health.causeCode);
            let failing;
            if (sticky) {
                // Already in an incident: one more failure keeps it there.
                failing = judged.health.failRun >= 1 || assessment.NOT_WORKING.includes(judged.execution);
            } else if (!announce) {
                continue;
            } else if (judged.health.sharedCause) {
                failing = true;
            } else {
                failing = assessment.incidentWorthy(judged, { upSeconds });
            }
            if (!failing) continue;
            if (judged.health.sharedCause && announce) place(`cause:${judged.health.sharedCause}`, judged.health.sharedCause, entry, 'failing');
            else if (sticky) place(sticky.key, sticky.causeCode, entry, 'failing');
            else place(`process:${entry.ref}`, judged.execution === 'stalled' ? judged.reasons.execution : judged.health.causeCode, entry, 'failing');
        }
        for (let round = 0; round < 8; round += 1) {
            let changed = false;
            for (const entry of entries) {
                const upstream = entry.assessment.health.blockedBy;
                if (placed.has(entry.ref) || entry.assessment.reasons.execution !== 'DEPENDENCY_BLOCKED' || !placed.has(upstream)) continue;
                place(placed.get(upstream), null, entry, 'dependent');
                changed = true;
            }
            if (!changed) break;
        }

        const stateOf = (member, incidentKey) => {
            if (placed.get(member.ref) === incidentKey) return 'failing';
            if (placed.has(member.ref)) return 'elsewhere';
            const entry = byRef.get(member.ref);
            if (!entry || !entry.described.enabled || member.role !== 'failing') return 'clear';
            const health = entry.assessment.health;
            return health.okRun >= 1 && health.okRun < settings.recoveryOk && health.priorFailRun >= 1 ? 'recovering' : 'clear';
        };

        for (const want of desired.values()) {
            let incident = open.find(candidate => candidate.key === want.key);
            let created = false;
            if (!incident) {
                incident = await this._open(owner, want, now);
                created = true;
                result.opened += 1;
            } else if (incident.status === 'RECOVERING') {
                await db.run(
                    "UPDATE assistant_process_incidents SET status = 'OPEN', recoveringSince = NULL, revision = revision + 1, updatedAt = @now WHERE id = @id",
                    { id: incident.id, now: utcText(now) }
                );
                result.reopened += 1;
            }
            const grew = await this._syncMembers(owner, incident, want, stateOf, now);
            if (announce && (created || grew || !incident.updateId)) await this._announce(owner, incident.id, now);
        }

        for (const incident of open) {
            if (desired.has(incident.key)) continue;
            const states = [];
            for (const member of incident.members) {
                const state = stateOf(member, incident.key);
                states.push(state);
                await this._setMemberState(incident.id, member, state === 'elsewhere' ? 'clear' : state);
            }
            if (states.includes('recovering')) continue;
            const stamp = utcText(now);
            if (states.includes('elsewhere')) {
                await this._resolve(incident.id, 'merged', stamp);
                result.resolved += 1;
            } else if (incident.status === 'OPEN') {
                await db.run(
                    "UPDATE assistant_process_incidents SET status = 'RECOVERING', recoveringSince = @now, revision = revision + 1, updatedAt = @now WHERE id = @id AND status = 'OPEN'",
                    { id: incident.id, now: stamp }
                );
                result.recovering += 1;
            } else if (now.getTime() - (assessment.toMs(incident.recoveringSince) ?? now.getTime()) >= settings.cooldownSeconds * 1000) {
                const working = incident.members.some(member => byRef.get(member.ref)?.described.enabled);
                await this._resolve(incident.id, working ? 'recovered' : 'removed', stamp);
                if (announce && working) await this._announce(owner, incident.id, now);
                result.resolved += 1;
            }
        }

        if (announce) result.relevance = await this._announceRelevance(owner, entries);
        return result;
    }

    async _open(owner, want, now) {
        const stamp = utcText(now);
        return db.transaction(async () => {
            const last = await db.get(
                'SELECT MAX(occurrence) AS top FROM assistant_process_incidents WHERE ownerUserId = @owner AND incidentKey = @key',
                { owner, key: want.key }
            );
            const id = await db.insert(
                `INSERT INTO assistant_process_incidents (ownerUserId, incidentKey, occurrence, status, causeCode, openedAt, updatedAt)
                 VALUES (@owner, @key, @occurrence, 'OPEN', @causeCode, @now, @now)`,
                { owner, key: want.key, occurrence: Number(last?.top || 0) + 1, causeCode: want.causeCode, now: stamp }
            );
            return { id: Number(id), key: want.key, status: 'OPEN', causeCode: want.causeCode, updateId: null, members: [] };
        });
    }

    /** Bring the member rows in line with this pass. Returns whether a process joined. */
    async _syncMembers(owner, incident, want, stateOf, now) {
        let grew = false;
        let criticality = 'low';
        const known = new Map(incident.members.map(member => [member.ref, member]));
        for (const [ref, { entry, role }] of want.members) {
            const level = entry.contract?.criticality || 'normal';
            if (role === 'failing' && CRITICALITY_RANK[level] > CRITICALITY_RANK[criticality]) criticality = level;
            const member = known.get(ref);
            if (!member) {
                await db.run(
                    `INSERT INTO assistant_process_incident_members (incidentId, ownerUserId, processKind, processId, name, role, state, joinedAt)
                     VALUES (@incidentId, @owner, @kind, @id, @name, @role, 'failing', @now)
                     ON CONFLICT (incidentId, processKind, processId) DO UPDATE SET role = excluded.role, state = 'failing', name = excluded.name`,
                    { incidentId: incident.id, owner, kind: entry.kind, id: String(entry.id), name: String(entry.described.name || '').slice(0, 200), role, now: utcText(now) }
                );
                grew = true;
            } else if (member.state !== 'failing' || member.role !== role) {
                await db.run(
                    `UPDATE assistant_process_incident_members SET state = 'failing', role = @role
                     WHERE incidentId = @incidentId AND processKind = @kind AND processId = @id`,
                    { incidentId: incident.id, kind: entry.kind, id: String(entry.id), role }
                );
            }
        }
        for (const member of incident.members) {
            if (want.members.has(member.ref)) continue;
            const state = stateOf(member, incident.key);
            await this._setMemberState(incident.id, member, state === 'elsewhere' ? 'clear' : state);
        }
        await db.run(
            'UPDATE assistant_process_incidents SET criticality = @criticality WHERE id = @id AND criticality <> @criticality',
            { id: incident.id, criticality }
        );
        return grew;
    }

    async _setMemberState(incidentId, member, state) {
        if (member.state === state) return;
        const [kind, id] = member.ref.split(':');
        await db.run(
            `UPDATE assistant_process_incident_members SET state = @state
             WHERE incidentId = @incidentId AND processKind = @kind AND processId = @id`,
            { incidentId, kind, id, state }
        );
    }

    async _resolve(id, resolution, stamp) {
        await db.run(
            `UPDATE assistant_process_incidents
             SET status = 'RESOLVED', resolution = @resolution, resolvedAt = @now, revision = revision + 1, updatedAt = @now
             WHERE id = @id AND status <> 'RESOLVED'`,
            { id, resolution, now: stamp }
        );
    }

    /**
     * What an incident's update says. The wording depends only on who is in
     * the incident and whether it is over, so a pass that changes nothing
     * material publishes nothing new.
     */
    _wording(row, members) {
        const failing = members.filter(member => member.role === 'failing');
        const waiting = members.filter(member => member.role === 'dependent');
        const names = failing.map(member => member.name);
        const code = row.causeCode && !STALL_CODES.includes(row.causeCode) ? ` (${row.causeCode})` : '';
        const shared = String(row.incidentKey).startsWith('cause:');
        if (row.status === 'RESOLVED') {
            return {
                title: shared ? `The problem that blocked ${names.length} of your processes has cleared` : `${quoted(names[0])} is working again`,
                summary: `${shared ? `${nameList(names)} have` : 'It has'} run cleanly for a day. This had been open since ${String(row.openedAt).slice(0, 10)}.`
            };
        }
        const tail = `${waiting.length ? ` ${nameList(waiting.map(member => member.name))} cannot run until ${waiting.length === 1 ? 'it does' : 'they do'}.` : ''} Nothing was changed.`;
        if (shared) {
            return {
                title: `${names.length} of your processes are blocked by the same problem`,
                summary: `${nameList(names)} are failing for one shared reason${code}.${tail}`
            };
        }
        if (STALL_CODES.includes(row.causeCode)) {
            return {
                title: `${quoted(names[0])} has stopped running`,
                summary: `It is more than a day past when it should have run.${tail}`
            };
        }
        return {
            title: `${quoted(names[0])} keeps failing`,
            summary: `It has failed at least ${assessment.DEFAULTS.incidentFailures} times in a row${code}.${tail}`
        };
    }

    /** File or refresh the incident's one canonical update. */
    async _announce(owner, incidentId, now) {
        const row = await db.get('SELECT * FROM assistant_process_incidents WHERE id = @id', { id: incidentId });
        const members = await db.all(
            'SELECT * FROM assistant_process_incident_members WHERE incidentId = @id ORDER BY processKind, processId', { id: incidentId }
        );
        if (!row || !members.some(member => member.role === 'failing')) return null;
        const refs = members.map(member => `${member.processKind}:${member.processId}`);
        const { update } = await require('./assistantUpdateService').publish({
            audience: { userId: owner },
            identityKey: `${INCIDENT_IDENTITY}${row.id}`,
            kind: 'process',
            ...this._wording(row, members),
            components: ['processes'],
            source: { kind: 'process_incident', id: row.id, revision: row.status === 'RESOLVED' ? 'resolved' : 'open' },
            evidence: refs.slice(0, 20).map(ref => ({ kind: 'process', id: ref })),
            actions: [{ kind: 'open_process', id: refs[0] }],
            deliver: true,
            happenedAt: now
        });
        if (Number(row.updateId) !== Number(update.id)) {
            await db.run('UPDATE assistant_process_incidents SET updateId = @updateId WHERE id = @id', { id: row.id, updateId: update.id });
        }
        return update.id;
    }

    /**
     * One informational update per process whose purpose is over while it is
     * still switched on. Its identity is the process; a contract change or a
     * different reason is a new revision. DA-5b adds the proposal to act.
     */
    async _announceRelevance(owner, entries) {
        let announced = 0;
        for (const entry of entries) {
            if (entry.assessment.relevance !== 'retirement_candidate') continue;
            const reason = entry.assessment.reasons.relevance;
            try {
                const { changed } = await require('./assistantUpdateService').publish({
                    audience: { userId: owner },
                    identityKey: `${RELEVANCE_IDENTITY}${entry.ref}`,
                    kind: 'process',
                    title: `${quoted(entry.described.name)} may no longer be needed`,
                    summary: `${ENDED_TEXT[reason] || 'What it was for is over.'} It is still switched on. Nothing was changed.`,
                    components: ['processes'],
                    source: { kind: 'process', id: entry.ref, revision: `r${entry.contract.revision}:${reason}` },
                    evidence: [{ kind: 'process', id: entry.ref }],
                    actions: [{ kind: 'open_process', id: entry.ref }],
                    deliver: true
                });
                if (changed) announced += 1;
            } catch (error) {
                logger.warn?.(`[assistant incidents] relevance update failed: ${error.message}`);
            }
        }
        return announced;
    }

    async _unraised(userId, candidates) {
        if (!candidates.length) return [];
        const rows = await db.all(
            "SELECT dedupeKey FROM attention_notices WHERE userId = @userId AND (dedupeKey LIKE 'process_health:%' OR dedupeKey LIKE 'process_relevance:%' OR dedupeKey LIKE 'process_review:%')",
            { userId }
        );
        const raised = new Set(rows.map(row => row.dedupeKey));
        return candidates.filter(candidate => !raised.has(candidate.key));
    }

    /**
     * Attention generator `process_health`: one candidate per open incident,
     * keyed on the incident (a new occurrence is a new incident row), so a
     * group of failures is one interruption and a flapping process is none.
     */
    async healthCandidates(ctx) {
        if (features.enforcedOff('assistant') || !ctx?.userId) return [];
        const rows = await db.all(
            `SELECT i.id, i.criticality, u.title, u.summary FROM assistant_process_incidents i
             JOIN assistant_updates u ON u.id = i.updateId
             WHERE i.ownerUserId = @userId AND i.status = 'OPEN' ORDER BY i.id`,
            { userId: String(ctx.userId) }
        );
        return this._unraised(String(ctx.userId), rows.map(row => ({
            key: `process_health:${row.id}`,
            category: 'schedule',
            title: row.title,
            detail: row.summary,
            ...(HEALTH_WEIGHT[row.criticality] || HEALTH_WEIGHT.normal),
            confidence: 0.9,
            actionability: 0.75,
            reason: 'A recurring process has an open incident.'
        })));
    }

    /**
     * Attention generator `process_relevance`: a process whose purpose is
     * over while it is still switched on (keyed on the contract revision and
     * the reason), and a review date the person set that has passed. An
     * ignored result alone produces nothing here.
     */
    async relevanceCandidates(ctx) {
        if (features.enforcedOff('assistant') || !ctx?.userId) return [];
        const userId = String(ctx.userId);
        const { processes } = await require('./assistantProcessService').assess({ userId, now: new Date(ctx.now || Date.now()) });
        const out = [];
        for (const entry of processes) {
            const judged = entry.assessment;
            if (judged.relevance === 'retirement_candidate') {
                out.push({
                    key: `process_relevance:${entry.ref}:r${entry.contract.revision}:${judged.reasons.relevance}`,
                    category: 'schedule',
                    title: `${quoted(entry.described.name)} may no longer be needed`,
                    detail: `${ENDED_TEXT[judged.reasons.relevance] || 'What it was for is over.'} It is still switched on.`,
                    urgency: 0.4,
                    importance: 0.55,
                    confidence: 0.85,
                    actionability: 0.8,
                    reason: 'A process outlived what it was set up for.'
                });
            } else if (judged.signals.reviewDue && entry.described.enabled) {
                out.push({
                    key: `process_review:${entry.ref}:${String(entry.contract.reviewAt).slice(0, 10)}`,
                    category: 'schedule',
                    title: `Time to look at ${quoted(entry.described.name)} again`,
                    detail: `You asked to review it on ${String(entry.contract.reviewAt).slice(0, 10)}.`,
                    urgency: 0.4,
                    importance: 0.5,
                    confidence: 0.9,
                    actionability: 0.8,
                    reason: 'A review date set on a process contract has passed.'
                });
            }
        }
        return this._unraised(userId, out);
    }

    /** Retention: resolved incidents older than `days` (their members go with them). */
    async prune({ days = 180, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        const where = "status = 'RESOLVED' AND resolvedAt < @cutoff";
        await db.run(
            `DELETE FROM assistant_process_incident_members WHERE incidentId IN (SELECT id FROM assistant_process_incidents WHERE ${where})`,
            { cutoff }
        );
        const result = await db.run(`DELETE FROM assistant_process_incidents WHERE ${where}`, { cutoff });
        return { incidents: result.changes || 0 };
    }
}

module.exports = new AssistantIncidentService();
module.exports.AssistantIncidentService = AssistantIncidentService;
module.exports.INCIDENT_IDENTITY = INCIDENT_IDENTITY;
module.exports.RELEVANCE_IDENTITY = RELEVANCE_IDENTITY;
