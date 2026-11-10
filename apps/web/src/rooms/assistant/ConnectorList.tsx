import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import type { AssistantConnector } from '../../lib/types';

/**
 * Outside connectors (documentation/delegated_connectors.md): the services
 * a responsibility can be granted a named resource on. Each shows its
 * manifest, what it reads and writes, what it may only ask the person to
 * approve, the owner's recorded decision and whether the person has
 * connected it, and can be revoked: that deletes the
 * person's credential, so work holding a grant on it is refused at its
 * next call. Nothing is shown when no connector is installed, or the pilot
 * does not include them for this person.
 */
export function ConnectorList({ enabled }: { enabled: boolean }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const query = useQuery({ queryKey: keys.assistantConnectors, queryFn: () => api.assistantConnectors(), enabled, retry: false });
    const connectors = query.data?.allowed ? query.data.connectors : [];
    if (!connectors.length) return null;

    async function revoke(connector: AssistantConnector) {
        if (!await confirm(
            `Revoke ${connector.name}? Your ${connector.providerName} credential is deleted now, and any responsibility that may use ${connector.name} `
            + 'is refused at its next call. You can connect it again in Settings.'
        )) return;
        try {
            const result = await api.revokeConnector(connector.id);
            toast(result.revoked ? `${connector.name} revoked.` : `${connector.name} was not connected.`);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            await queryClient.invalidateQueries({ queryKey: keys.assistantConnectors });
        }
    }

    return (
        <section className="list-card assistant-connectors" aria-labelledby="assistant-connectors-title" data-testid="connectors" style={{ marginTop: 22 }}>
            <h2 id="assistant-connectors-title">Outside connectors</h2>
            <p className="hint">
                A connector reaches one outside service as you, with your own credential. A responsibility can be granted a named
                resource on it, never the whole service. Reading never changes anything outside; writing cannot be undone from here.
                Some actions are never granted: work can only ask, and each one happens when you approve it under Needs you.
            </p>
            {connectors.map((connector) => (
                <div key={connector.id} className="list-row" data-testid="connector-row">
                    <div className="row-body">
                        <strong>{connector.name}</strong>{' '}
                        <span className="badge" data-testid="connector-status">{connector.connected ? 'connected' : 'not connected'}</span>
                        <div className="hint">{connector.description}</div>
                        <ul className="assistant-grants">
                            <li>Resources are named as {connector.resource}.</li>
                            {connector.reads.map((entry) => <li key={`r-${entry.operation}`}>Can read: {entry.operation}, {entry.describe}</li>)}
                            {connector.writes.map((entry) => (
                                <li key={`w-${entry.operation}`}>
                                    Can write: {entry.operation}, {entry.describe}{' '}
                                    {entry.reconcilable ? '(checked with the service after a crash)' : '(stops for your review after a crash)'}
                                </li>
                            ))}
                            {(connector.asks || []).map((entry) => (
                                <li key={`a-${entry.operation}`} data-testid="connector-ask">
                                    Only with your approval, each time: {entry.operation}, {entry.describe}
                                </li>
                            ))}
                        </ul>
                        <div className="row-meta" data-testid="connector-decision">
                            {connector.decision
                                ? `Added on your decision: ${connector.decision.reference} (${connector.decision.recordedAt})`
                                : 'Not a shipped connector: a test double with no recorded decision'}
                            {connector.connected && connector.account ? ` · connected as ${connector.account}` : ''}
                        </div>
                        {!connector.connected && (
                            <div className="hint">Connect {connector.providerName} under Settings, Integrations, to use it.</div>
                        )}
                        {!connector.featureOn && <div className="hint" role="note">This connector is off on this installation.</div>}
                    </div>
                    <div className="inbox-actions">
                        <button type="button" className="btn danger" disabled={!connector.connected} onClick={() => void revoke(connector)}
                            data-testid="connector-revoke">
                            Revoke
                        </button>
                    </div>
                </div>
            ))}
        </section>
    );
}
