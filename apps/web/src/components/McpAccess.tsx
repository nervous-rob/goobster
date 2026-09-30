import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { McpScope, McpToken } from '../lib/types';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';

const MCP_KEY = ['mcp-access'] as const;
const EXPIRY_CHOICES = [30, 90, 365];

function expiryLabel(days: number): string {
    if (days === 0) return 'Never expires';
    if (days === 365) return 'Expires in 1 year';
    return `Expires in ${days} days`;
}

function expiryNote(token: McpToken): string {
    if (!token.expiresAt) return 'never expires';
    const day = token.expiresAt.slice(0, 10);
    return token.expired ? `expired ${day}` : `expires ${day}`;
}

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
    const [scope, setScope] = useState<McpScope>('read');
    const [expiry, setExpiry] = useState<number | null>(null);
    const [fresh, setFresh] = useState<string | null>(null);
    const [busy, setBusy] = useState<'create' | number | null>(null);

    const data = overview.data;
    const tokens = data?.tokens || [];
    const scopes = data?.scopes || [];
    const defaultDays = data?.defaultExpiryDays ?? 90;
    const chosenDays = expiry ?? defaultDays;
    const expiryOptions = [...new Set([...EXPIRY_CHOICES, defaultDays].filter(days => days > 0))]
        .sort((a, b) => a - b);
    const scopeInfo = scopes.find(entry => entry.id === scope);

    async function create() {
        setBusy('create');
        try {
            const created = await api.createMcpToken({
                label: label.trim(),
                scope,
                expiresInDays: chosenDays
            });
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

    return (
        <div className="settings-field" id="mcp-access" data-field="mcp-access">
            <div className="settings-field-head">
                <label htmlFor="mcp-access-input">MCP access</label>
                <span className="badge settings-scope">Your account</span>
                <div className="hint">
                    A read-only connection for Cursor and other MCP clients. An everything token can search
                    your docs, memories, knowledge, projects, inbox, and research. A documentation-only token
                    reads the manual and nothing private. Tokens expire unless you choose otherwise.
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
                        <li key={token.id} data-expired={token.expired ? 'true' : undefined}>
                            <span>
                                <strong>{token.label}</strong>
                                {' '}
                                <code>{token.tokenPrefix}…</code>
                                {' '}
                                <span className="badge">{token.scope === 'docs' ? 'docs only' : 'everything'}</span>
                                <span className={token.expired ? 'hint mcp-expired' : 'hint'}> {expiryNote(token)}</span>
                                {token.lastUsedAt ? <span className="hint"> · last used {token.lastUsedAt}</span> : null}
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
                <select
                    className="select"
                    aria-label="MCP token scope"
                    value={scope}
                    onChange={(event) => setScope(event.target.value as McpScope)}
                >
                    {(scopes.length ? scopes : [{ id: 'read' as const, label: 'Everything (read-only)', description: '' }]).map(entry => (
                        <option key={entry.id} value={entry.id}>{entry.label}</option>
                    ))}
                </select>
                <select
                    className="select"
                    aria-label="MCP token lifetime"
                    value={chosenDays}
                    onChange={(event) => setExpiry(Number(event.target.value))}
                >
                    {expiryOptions.map(days => (
                        <option key={days} value={days}>{expiryLabel(days)}</option>
                    ))}
                    <option value={0}>{expiryLabel(0)}</option>
                </select>
                <button type="button" className="btn" disabled={!label.trim() || busy === 'create'} onClick={() => void create()}>
                    {busy === 'create' ? 'Creating…' : 'Create token'}
                </button>
            </div>
            {scopeInfo?.description && <p className="hint">{scopeInfo.description}</p>}
            {overview.isError && <p className="hint">{(overview.error as Error).message}</p>}
        </div>
    );
}
