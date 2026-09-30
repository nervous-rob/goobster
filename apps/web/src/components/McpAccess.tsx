import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';

const MCP_KEY = ['mcp-access'] as const;

/**
 * Read-only MCP tokens for this account (documentation/mcp.md).
 * The secret is shown once, in this component's state, and is not
 * written to the settings draft.
 */
export function McpAccess() {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const overview = useQuery({ queryKey: MCP_KEY, queryFn: () => api.mcp(), staleTime: 15_000 });
    const [label, setLabel] = useState('Cursor');
    const [fresh, setFresh] = useState<string | null>(null);
    const [busy, setBusy] = useState<'create' | number | null>(null);

    async function create() {
        setBusy('create');
        try {
            const created = await api.createMcpToken(label.trim());
            setFresh(created.token);
            setLabel('');
            await queryClient.invalidateQueries({ queryKey: MCP_KEY });
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(null);
        }
    }

    async function revoke(id: number, name: string) {
        const ok = await confirm(`Revoke the MCP token “${name}”? Clients using it lose access.`);
        if (!ok) return;
        setBusy(id);
        try {
            await api.revokeMcpToken(id);
            if (fresh) setFresh(null);
            toast('Token revoked.');
            await queryClient.invalidateQueries({ queryKey: MCP_KEY });
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(null);
        }
    }

    async function copy(secret: string) {
        try {
            await navigator.clipboard.writeText(secret);
            toast('Token copied.');
        } catch {
            toast('Select the token and copy it manually.', true);
        }
    }

    const data = overview.data;
    const tokens = data?.tokens || [];

    return (
        <div className="settings-field" id="mcp-access" data-field="mcp-access">
            <div className="settings-field-head">
                <label htmlFor="mcp-access-input">MCP access</label>
                <span className="badge settings-scope">Your account</span>
                <div className="hint">
                    A read-only connection for Cursor and other MCP clients. They can search your
                    docs, memories, knowledge, projects, inbox, and research.
                    {data && !data.enabled && (
                        <> The endpoint is off until <code>mcp.enabled</code> is true in config.json and Goobster restarts. Tokens you create here start working then.</>
                    )}
                    {data?.enabled && <> The server is on at <code>{data.endpoint}</code>.</>}
                </div>
            </div>
            {fresh && (
                <div className="mcp-secret-block">
                    <p className="hint">Copy this token now. Goobster stores only a hash of it.</p>
                    <pre className="mcp-secret">{fresh}</pre>
                    <button type="button" className="btn subtle" onClick={() => copy(fresh)}>Copy token</button>
                </div>
            )}
            {tokens.length > 0 && (
                <ul className="mcp-token-list">
                    {tokens.map(token => (
                        <li key={token.id}>
                            <span>
                                <strong>{token.label}</strong>
                                {' '}
                                <code>{token.tokenPrefix}…</code>
                                {token.lastUsedAt ? <span className="hint"> last used {token.lastUsedAt}</span> : null}
                            </span>
                            <button
                                type="button"
                                className="btn subtle danger"
                                disabled={busy === token.id}
                                onClick={() => revoke(token.id, token.label)}
                            >
                                Revoke
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="btn-row mcp-create">
                <input
                    id="mcp-access-input"
                    className="input"
                    value={label}
                    maxLength={80}
                    placeholder="Label, such as Cursor"
                    aria-label="MCP token label"
                    onChange={(event) => setLabel(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && label.trim() && busy !== 'create') {
                            event.preventDefault();
                            void create();
                        }
                    }}
                />
                <button type="button" className="btn" disabled={!label.trim() || busy === 'create'} onClick={() => void create()}>
                    {busy === 'create' ? 'Creating…' : 'Create token'}
                </button>
            </div>
            {overview.isError && <p className="hint">{(overview.error as Error).message}</p>}
        </div>
    );
}
