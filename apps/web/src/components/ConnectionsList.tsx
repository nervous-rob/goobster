import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';

export type Integration = {
    provider: string; name: string; description?: string; connected?: boolean;
    account?: string; tokenHint?: string; docsUrl?: string;
};

const ICONS: Record<string, string> = { github: '🐙', notion: '📓' };

/**
 * Connect / disconnect developer accounts. Shared by Settings → Connections
 * and anywhere else that needs the same list, so there is one save path.
 * Tokens are write-only: the API only ever returns status and an account label.
 */
export function ConnectionsList({ anchorPrefix = '' }: { anchorPrefix?: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [token, setToken] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const list = useQuery({
        queryKey: ['integrations'],
        queryFn: () => api.integrations() as Promise<{ integrations: Integration[] }>
    });

    async function refresh() {
        await Promise.all([
            list.refetch(),
            queryClient.invalidateQueries({ queryKey: keys.settings })
        ]);
    }

    return (
        <>
            {list.isPending && <div className="empty">Loading…</div>}
            {list.isError && <div className="hint">{(list.error as Error).message}</div>}
            <div className="integrations-list">
                {(list.data?.integrations || []).map((item) => (
                    <div key={item.provider} className="integration-card" id={`${anchorPrefix}${item.provider}`}>
                        <div className="integration-head">
                            <div className="integration-title">{ICONS[item.provider] || '🔌'} {item.name}</div>
                            <span className={`integration-status${item.connected ? ' connected' : ''}`}>
                                {item.connected ? `Connected · ${item.account || 'account'}` : 'Not connected'}
                            </span>
                        </div>
                        <div className="hint">{item.description}</div>
                        {item.connected ? (
                            <div className="integration-actions">
                                <button
                                    type="button"
                                    className="btn danger"
                                    disabled={busy === item.provider}
                                    onClick={async () => {
                                        if (!await confirm(`Disconnect ${item.name}? The stored token is deleted.`)) return;
                                        setBusy(item.provider);
                                        try {
                                            await api.disconnectIntegration(item.provider);
                                            toast(`${item.name} disconnected.`);
                                            await refresh();
                                        } catch (error) { toast((error as Error).message, true); }
                                        finally { setBusy(null); }
                                    }}
                                >Disconnect</button>
                            </div>
                        ) : (
                            <>
                                <div className="hint integration-token-hint">{item.tokenHint}</div>
                                <div className="integration-actions">
                                    <input
                                        id={`${anchorPrefix}${item.provider}-input`}
                                        className="input integration-token"
                                        type="password"
                                        autoComplete="off"
                                        placeholder={`${item.name} token`}
                                        aria-label={`${item.name} token`}
                                        value={token[item.provider] || ''}
                                        onChange={(e) => setToken((prev) => ({ ...prev, [item.provider]: e.target.value }))}
                                    />
                                    <button
                                        type="button"
                                        className="btn primary"
                                        disabled={busy === item.provider || !(token[item.provider] || '').trim()}
                                        onClick={async () => {
                                            const value = (token[item.provider] || '').trim();
                                            if (!value) return;
                                            setBusy(item.provider);
                                            try {
                                                const result = await api.connectIntegration(item.provider, value) as { account?: string };
                                                toast(`${item.name} connected as ${result.account || 'account'}.`);
                                                setToken((prev) => ({ ...prev, [item.provider]: '' }));
                                                await refresh();
                                            } catch (error) { toast((error as Error).message, true); }
                                            finally { setBusy(null); }
                                        }}
                                    >Connect</button>
                                </div>
                                {item.docsUrl && (
                                    <a className="integration-docs" href={item.docsUrl} target="_blank" rel="noreferrer">Where do I get a token? ↗</a>
                                )}
                            </>
                        )}
                    </div>
                ))}
            </div>
        </>
    );
}
