import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';

export function TokenUsage() {
    const query = useQuery({ queryKey: keys.me, queryFn: api.me, refetchInterval: 5_000 });
    const limits = query.data?.limits;
    return <section className="settings-section" aria-labelledby="token-usage-title">
        <h2 id="token-usage-title">Token budget</h2>
        {query.isError && <p className="hint">Could not load your token budget.</p>}
        {limits && <>
            <p><strong>{limits.usedTokens.toLocaleString()}</strong> tokens used or reserved
                {limits.dailyTokens === null ? ' · No cap set' : ` of ${limits.dailyTokens.toLocaleString()} per ${limits.windowHours} hours`}.</p>
            {limits.waitingRequests > 0 && <p role="status">{limits.waitingRequests} background request(s) waiting for the token budget.</p>}
            <p className="hint">Window resets {new Date(limits.resetsAt).toLocaleString()}. In-flight requests reserve an estimate, then use the provider’s actual count.</p>
        </>}
    </section>;
}

export function LimitsPanel() {
    const query = useQuery({ queryKey: ['admin-limits'], queryFn: api.adminLimits, refetchInterval: 5_000 });
    const queryClient = useQueryClient();
    const toast = useToast();
    const [cap, setCap] = useState('');
    const [hours, setHours] = useState('24');
    const [retention, setRetention] = useState('90');
    const [busy, setBusy] = useState(false);
    const [dirty, setDirty] = useState(false);
    useEffect(() => {
        if (!query.data || dirty) return;
        setCap(query.data.dailyTokens === null ? '' : String(query.data.dailyTokens));
        setHours(String(query.data.windowHours));
        setRetention(String(query.data.retentionDays));
    }, [query.data, dirty]);
    async function save(event: FormEvent) {
        event.preventDefault(); setBusy(true);
        try {
            await api.adminSetLimits({ dailyTokens: cap.trim() === '' ? null : Number(cap), windowHours: Number(hours), retentionDays: Number(retention) });
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['admin-limits'] }),
                queryClient.invalidateQueries({ queryKey: ['admin-audit'] }),
                queryClient.invalidateQueries({ queryKey: keys.me })
            ]);
            setDirty(false); toast('Token limits saved.');
        } catch (error) { toast((error as Error).message, true); }
        finally { setBusy(false); }
    }
    return <section className="settings-section" aria-labelledby="host-limits-title">
        <h2 id="host-limits-title">Limits</h2>
        <p className="hint">One token cap for each account. Leave it blank for unlimited single-user use. Set a cap before opening a second account. Changes apply to new reservations; running replies finish.</p>
        {query.isPending && <p className="hint">Loading…</p>}
        {query.isError && <p className="settings-danger">{query.error.message}</p>}
        {query.data && <>
            <form onSubmit={save} onChange={() => setDirty(true)} style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end' }}>
                <label>Tokens per account<br /><input type="number" min="1" step="1" value={cap} placeholder="Unlimited" onChange={e => setCap(e.target.value)} /></label>
                <label>Window hours<br /><input type="number" min="1" max="24" step="1" required value={hours} onChange={e => setHours(e.target.value)} /></label>
                <label>Keep usage records (days)<br /><input type="number" min="1" max="3650" step="1" required value={retention} onChange={e => setRetention(e.target.value)} /></label>
                <button className="btn primary" type="submit" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save limits'}</button>
            </form>
            <div className="list-card" style={{ marginTop: 12 }}>{query.data.accounts.map(account =>
                <div className="list-row" key={account.principalId}>
                    <span>{account.displayName}</span><span>{account.usedTokens.toLocaleString()} tokens used or reserved{account.waitingRequests > 0 ? ` · ${account.waitingRequests} waiting for budget` : ''}</span>
                </div>)}</div>
            <p className="hint">Usage windows follow UTC. Token limits cover model chat and text generation. Images, speech, search, and embeddings are tracked separately.</p>
        </>}
    </section>;
}
