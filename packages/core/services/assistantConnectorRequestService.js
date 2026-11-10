/**
 * Requests for an outside action a delegated run may never take itself
 * (DA-11e, ADR 0030; documentation/delegated_connectors.md, "Asking first").
 *
 * A connector's manifest lists such actions as `asks` (Notion: moving a
 * page or block to the trash). A run can only file a request, with
 * `askConnector`. The request is a canonical update with a gate
 * (`connector_request`), so it shows under Needs you on Home and in the
 * Inbox, and the person decides it there through
 * `assistantGateService.decide`, which is never reachable from a model
 * call. Approving makes the change at that moment, with that person's own
 * credential, after checking again that the pilot, the connector, the
 * grant and the target are all still as they were. Refusing changes
 * nothing. One request is one action: nothing is approved in advance.
 *
 * `label` (a page title) is the person's own content from outside and is
 * private user data: it is in the row, the update and the card only, never
 * in a log or a ledger row.
 */

const db = require('../db');
const registry = require('./assistant/connectors/registry');
const integrations = require('./userIntegrationService');
const access = require('./assistantAccessService');
const { features } = require('../features/featureState');

/** Requests one responsibility may have waiting at once. */
const MAX_OPEN = 5;
const LIVE_STATUSES = new Set(['ACTIVE', 'PAUSED', 'NEEDS_REVIEW']);
const identityKey = (id) => `connector_request:${id}`;

class AssistantConnectorRequestError extends Error {
    constructor(code, message, status = 409) {
        super(message);
        this.name = 'AssistantConnectorRequestError';
        this.code = code;
        this.status = status;
    }
}

function utcText(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

const clip = (value, max) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

class AssistantConnectorRequestService {
    constructor() {
        this.MAX_OPEN = MAX_OPEN;
    }

    async get(id) {
        const n = Number(id);
        if (!Number.isSafeInteger(n) || n < 1) return null;
        return await db.get('SELECT * FROM assistant_connector_requests WHERE id = @id', { id: n }) || null;
    }

    /** The request one asking call filed, or null: how a resumed run learns whether it already asked. */
    async forOperation(operationId) {
        return await db.get('SELECT * FROM assistant_connector_requests WHERE operationId = @operationId', { operationId: String(operationId) }) || null;
    }

    /** What the person is asked, in one line. */
    question(row, connector, ask) {
        return `${ask?.action || 'Do it'}: ${row.label}, in ${connector?.name || row.connector}?`;
    }

    /**
     * File a request for the person to answer. Idempotent on `operationId`;
     * a request already waiting for the same action is returned instead of a
     * second one.
     *
     * @param {Object} params
     * @param {string} params.userId - whose credential would be used, and who is asked
     * @param {Object} params.run - the run's row (id, responsibilityId, initiativeId)
     * @param {Object} params.connector - the registry's manifest
     * @param {Object} params.ask - one of its `asks`
     * @param {string} params.resource
     * @param {string} params.target
     * @param {string} params.label
     * @param {string} params.operationId
     * @returns {Promise<{ request: Object, created: boolean }>}
     * @throws {AssistantConnectorRequestError} ASK_LIMIT
     */
    async ask({ userId, run, connector, ask, resource, target, label, operationId }) {
        const prior = await this.forOperation(operationId);
        if (prior) return { request: prior, created: false };
        const same = await db.get(
            `SELECT * FROM assistant_connector_requests
             WHERE responsibilityId = @rid AND connector = @connector AND resource = @resource
               AND operation = @operation AND target = @target AND status = 'PENDING'`,
            { rid: run.responsibilityId, connector: connector.id, resource, operation: ask.operation, target }
        );
        if (same) return { request: same, created: false };
        const open = await db.get(
            "SELECT COUNT(*) AS n FROM assistant_connector_requests WHERE responsibilityId = @rid AND status = 'PENDING'",
            { rid: run.responsibilityId }
        );
        if (Number(open?.n || 0) >= MAX_OPEN) {
            throw new AssistantConnectorRequestError('ASK_LIMIT', `${MAX_OPEN} requests are already waiting for an answer.`);
        }
        const id = await db.insert(
            `INSERT INTO assistant_connector_requests
                (ownerUserId, responsibilityId, runId, operationId, connector, resource, operation, target, label)
             VALUES (@userId, @rid, @runId, @operationId, @connector, @resource, @operation, @target, @label)`,
            {
                userId: String(userId), rid: run.responsibilityId, runId: run.id, operationId: String(operationId),
                connector: connector.id, resource, operation: ask.operation, target, label: clip(label, 200)
            }
        );
        const request = await this.get(id);
        const responsibility = await db.get('SELECT title FROM assistant_responsibilities WHERE id = @id', { id: run.responsibilityId });
        await require('./assistantUpdateService').publish({
            audience: { userId: String(userId) },
            identityKey: identityKey(id),
            kind: 'question',
            title: clip(this.question(request, connector, ask), 200),
            summary: `Asked while working on "${clip(responsibility?.title, 120)}". Goobster cannot do this itself: it happens only if you approve it. ${ask.consequence}`,
            components: ['responsibilities'],
            gate: { kind: 'connector_request', id: String(id) },
            actions: [{ kind: 'open_responsibility', id: String(run.responsibilityId) }],
            responsibilityId: run.responsibilityId,
            initiativeId: run.initiativeId || null,
            deliver: true
        });
        return { request, created: true };
    }

    async _settle(row, status, resultCode = null) {
        const result = await db.run(
            `UPDATE assistant_connector_requests SET status = @status, resultCode = @resultCode, decidedAt = @now
             WHERE id = @id AND status = 'PENDING'`,
            { id: row.id, status, resultCode, now: utcText() }
        );
        await require('./assistantUpdateService').resolveGate({ audience: { userId: row.ownerUserId }, identityKey: identityKey(row.id) });
        return result.changes > 0;
    }

    /** Does the responsibility still grant writing to that connector resource? */
    async _granted(row) {
        const responsibility = await db.get(
            'SELECT status, operationsJson FROM assistant_responsibilities WHERE id = @id', { id: row.responsibilityId }
        );
        if (!responsibility || !LIVE_STATUSES.has(responsibility.status)) return false;
        let grants;
        try { grants = JSON.parse(responsibility.operationsJson || '[]'); } catch { grants = []; }
        const ref = registry.refOf(row.connector, row.resource);
        return grants.some(entry => entry?.operation === 'external.write' && entry.resource?.kind === 'external'
            && (entry.resource.ids || []).includes(ref));
    }

    /**
     * The person's own answer to one request. Only ever called for a click
     * on a signed-in surface (through the gate descriptor).
     *
     * Approving checks, now: the pilot, the host's stop, the connector and
     * its feature, the grant, the credential, the person's own restriction
     * on the service; then runs the ask with the
     * person's credential. A check that can come back (the pilot, a missing
     * credential, Notion being unreachable) leaves the request waiting and
     * says why. One that cannot (the grant is gone, the target left the
     * resource) withdraws it.
     *
     * @param {{ userId: string, id: number|string, approve: boolean }} params
     * @returns {Promise<{ status: string, message: string }>}
     * @throws {AssistantConnectorRequestError}
     */
    async decide({ userId, id, approve }) {
        const row = await this.get(id);
        if (!row || row.ownerUserId !== String(userId)) throw new AssistantConnectorRequestError('NOT_FOUND', 'No such request.', 404);
        if (row.status !== 'PENDING') throw new AssistantConnectorRequestError('ALREADY_DECIDED', 'This request was already answered.');
        if (!approve) {
            if (!(await this._settle(row, 'DECLINED'))) throw new AssistantConnectorRequestError('ALREADY_DECIDED', 'This request was already answered.');
            return { status: 'DECLINED', message: 'Nothing was changed.' };
        }

        const withdraw = async (code, message) => {
            await this._settle(row, 'WITHDRAWN', code);
            return new AssistantConnectorRequestError('REQUEST_WITHDRAWN', message);
        };
        if (!(await access.allows(String(userId), 'reach'))) {
            throw new AssistantConnectorRequestError(access.REFUSAL_CODE, 'Outside connectors are not open to your account on this installation.', 403);
        }
        if (await require('./assistantControlService').isPaused()) {
            throw new AssistantConnectorRequestError('HOST_STOPPED', 'The host has stopped all delegated work. Nothing was changed; the request is still waiting.');
        }
        const connector = registry.get(row.connector);
        const ask = connector ? registry.operationOf(connector, 'ask', row.operation) : null;
        if (!connector || !ask) throw await withdraw('NO_SUCH_CONNECTOR', 'That connector is no longer installed. Nothing was changed.');
        if (connector.feature && features.enforcedOff(connector.feature)) {
            throw new AssistantConnectorRequestError('FEATURE_UNAVAILABLE', 'That connector is switched off on this installation. Nothing was changed.');
        }
        if (!(await this._granted(row))) {
            throw await withdraw('GRANT_GONE', 'The responsibility no longer grants writing there, so this request was withdrawn. Nothing was changed.');
        }
        const token = await integrations.getToken(String(userId), connector.credential.provider);
        if (!token) {
            throw new AssistantConnectorRequestError('NO_CREDENTIAL', `Connect ${connector.name} in Settings first. Nothing was changed; the request is still waiting.`);
        }

        let barred = 'RESTRICTION_UNAVAILABLE';
        try { barred = connector.permits ? await connector.permits({ userId: String(userId), resource: row.resource }) : null; } catch { /* could not be read: not allowed */ }
        if (barred) {
            throw new AssistantConnectorRequestError(barred, `Your own ${connector.name} settings do not allow that (${barred}). Nothing was changed; the request is still waiting.`, 403);
        }

        let detail;
        try {
            detail = await ask.run({ resource: row.resource, target: row.target, token });
        } catch (error) {
            const code = String(error?.code || 'ERROR').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40);
            // The manifest says which refusals mean the request can never be carried out.
            if (error?.declined === true && ask.voids.includes(code)) {
                throw await withdraw(code, `That is no longer something this request can be about (${code}), so it was withdrawn. Nothing was changed.`);
            }
            // The reason stays out of logs and ledgers; the person gets the code.
            throw new AssistantConnectorRequestError(
                error?.declined === true ? code : 'OUTCOME_UNKNOWN',
                error?.declined === true
                    ? `${connector.name} did not do it (${code}). Nothing was changed; the request is still waiting.`
                    : `${connector.name} did not answer, so it may or may not have happened. Approving again is safe.`,
                502
            );
        }
        // Two clicks at once both ask for the same idempotent change; the first to finish records it.
        await this._settle(row, 'APPROVED');
        const text = clip(detail, 200).replace(/[.\s]+$/, '');
        return { status: 'APPROVED', message: `${text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : 'Done'}.` };
    }

    /**
     * Withdraw waiting requests that can no longer be approved: the
     * responsibility ended or no longer grants writing there, the connector
     * is gone, or (with `userId` and `connectorId`) the person revoked it.
     * Nothing outside is touched.
     *
     * @param {{ userId?: string, connectorId?: string }} [only]
     * @returns {Promise<number>} how many were withdrawn
     */
    async withdrawStale({ userId = null, connectorId = null } = {}) {
        const revoked = userId != null && connectorId != null;
        const rows = revoked
            ? await db.all(
                "SELECT * FROM assistant_connector_requests WHERE status = 'PENDING' AND ownerUserId = @userId AND connector = @connector",
                { userId: String(userId), connector: String(connectorId) }
            )
            : await db.all("SELECT * FROM assistant_connector_requests WHERE status = 'PENDING' ORDER BY id LIMIT 500", {});
        let withdrawn = 0;
        for (const row of rows) {
            const code = revoked ? 'REVOKED' : (!registry.get(row.connector) ? 'NO_SUCH_CONNECTOR' : (await this._granted(row) ? null : 'GRANT_GONE'));
            if (code && await this._settle(row, 'WITHDRAWN', code)) withdrawn += 1;
        }
        return withdrawn;
    }

    /** Retention: answered requests older than `days`. A waiting request is kept. */
    async prune({ days = 180, now = new Date() } = {}) {
        const cutoff = utcText(new Date(now.getTime() - days * 86400000));
        const result = await db.run(
            "DELETE FROM assistant_connector_requests WHERE status <> 'PENDING' AND decidedAt < @cutoff", { cutoff }
        );
        return result.changes || 0;
    }
}

module.exports = new AssistantConnectorRequestService();
module.exports.AssistantConnectorRequestService = AssistantConnectorRequestService;
module.exports.AssistantConnectorRequestError = AssistantConnectorRequestError;
module.exports.identityKey = identityKey;
