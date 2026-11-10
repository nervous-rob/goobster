/**
 * Outside connectors for delegated work (DA-11d, ADR 0028;
 * documentation/delegated_connectors.md): what a person can see of the
 * installed connectors, whether one is reachable for them right now, and
 * how they take it back.
 *
 * Credentials are the person's own, in `user_integrations`, and are never
 * returned from here. A connector is reachable when it is installed, its
 * feature (if any) is on and the person has its credential connected, so
 * revoking it - which deletes that token - ends its use at the very next
 * authorize() or guard, not at the end of the run.
 */

const db = require('../db');
const registry = require('./assistant/connectors/registry');
const integrations = require('./userIntegrationService');
const access = require('./assistantAccessService');
const { features } = require('../features/featureState');

const LIVE_STATUSES = ['ACTIVE', 'PAUSED', 'NEEDS_REVIEW'];

class AssistantConnectorError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'AssistantConnectorError';
        this.code = code;
        this.status = status;
    }
}

class AssistantConnectorService {
    /**
     * Is the connector's resource usable by `userId` right now? Returns true,
     * the id of the feature that is off, or false.
     * @param {string} userId
     * @param {string} ref `<connector>:<resource>`
     */
    async reachable(userId, ref) {
        const parsed = registry.parseRef(ref);
        if (!parsed) return false;
        const { connector } = parsed;
        if (connector.feature && features.enforcedOff(connector.feature)) return connector.feature;
        const connected = await integrations.connectedProviders(String(userId));
        return Boolean(connected[connector.credential.provider]);
    }

    /** Is this person's credential for the connector connected? Does not stamp lastUsedAt. */
    async connected(userId, connector) {
        const connected = await integrations.connectedProviders(String(userId));
        return Boolean(connected[connector.credential.provider]);
    }

    /**
     * The installed connectors as one person sees them: the manifest, whether
     * they are connected, and whether the feature behind each is on. A person
     * whose pilot does not include `reach` sees none.
     * @returns {Promise<{ connectors: Object[], allowed: boolean }>}
     */
    async list(userId) {
        if (!(await access.allows(userId, 'reach'))) return { allowed: false, connectors: [] };
        const rows = await integrations.list(String(userId));
        const byProvider = new Map(rows.map(row => [row.provider, row]));
        return {
            allowed: true,
            connectors: registry.list().map(connector => {
                const row = byProvider.get(connector.credential.provider);
                return {
                    ...registry.describe(connector),
                    connected: Boolean(row?.connected),
                    account: row?.account || null,
                    featureOn: !(connector.feature && features.enforcedOff(connector.feature)),
                    providerName: row?.name || connector.credential.provider
                };
            })
        };
    }

    /** Live responsibilities of this person that grant something on the connector. */
    async _holders(userId, connectorId) {
        const rows = await db.all(
            `SELECT id, operationsJson FROM assistant_responsibilities
             WHERE ownerUserId = @userId AND status IN (${LIVE_STATUSES.map(status => `'${status}'`).join(', ')})`,
            { userId: String(userId) }
        );
        const holds = [];
        for (const row of rows) {
            let grants;
            try { grants = JSON.parse(row.operationsJson || '[]'); } catch { grants = []; }
            if (grants.some(entry => entry?.resource?.kind === 'external'
                && (entry.resource.ids || []).some(id => String(id).startsWith(`${connectorId}:`)))) holds.push(Number(row.id));
        }
        return holds;
    }

    /**
     * Take a connector back: delete the person's credential for it. Work that
     * holds a grant on it is refused at its next call (`RESOURCE_UNAVAILABLE`);
     * the grant itself stays until the person revokes the responsibility.
     * @returns {Promise<{ revoked: boolean, responsibilities: number[] }>}
     */
    async revoke({ userId, connectorId }) {
        const connector = registry.get(connectorId);
        if (!connector) throw new AssistantConnectorError('NO_SUCH_CONNECTOR', 'There is no such connector.', 404);
        const holders = await this._holders(userId, connector.id);
        const { disconnected } = await integrations.disconnect({ userId: String(userId), provider: connector.credential.provider });
        // Anything a run had asked them to approve there can no longer be done.
        await require('./assistantConnectorRequestService').withdrawStale({ userId, connectorId: connector.id });
        return { revoked: disconnected, responsibilities: holders };
    }
}

module.exports = new AssistantConnectorService();
module.exports.AssistantConnectorService = AssistantConnectorService;
module.exports.AssistantConnectorError = AssistantConnectorError;
