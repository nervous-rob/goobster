import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../lib/api';
import { useMe } from '../hooks/useSession';
import { useOpenSettings } from '../hooks/useOpenSettings';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';

export function FollowedSources({ projectId, topicNodeId }: { projectId?: number; topicNodeId?: number }) {
    const me = useMe();
    const uid = useId();
    const toast = useToast();
    const confirm = useConfirm();
    const openSettings = useOpenSettings();
    const client = useQueryClient();
    const target = { projectId, topicNodeId };
    const key = ['followed-sources', me.user.id, projectId, topicNodeId];
    const query = useQuery({ queryKey: key, queryFn: () => api.followedSources(target), refetchInterval: 30000 });
    const [url, setUrl] = useState('');
    const [label, setLabel] = useState('');
    const [kind, setKind] = useState<'feed' | 'page'>('feed');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const action = useMutation({
        mutationFn: (fn: () => Promise<unknown>) => fn(),
        onSuccess: () => { setError(''); void client.invalidateQueries({ queryKey: key }); },
        onError: (e: Error) => setError(e.message)
    });
    return <section className="followed-sources" aria-labelledby={`${uid}-heading`}>
        <h3 id={`${uid}-heading`}>Followed sources</h3>
        <p className="hint">Your follows and saved changes are private, including in shared projects. Checks run during research Attention sweeps, up to four sources per sweep and at least an hour apart. The first check saves a baseline.</p>
        {query.isPending && <p role="status">Loading sources…</p>}
        {query.isError && <p role="alert">{query.error.message} <button className="btn small" onClick={() => void query.refetch()}>Retry</button></p>}
        {query.data && !query.data.attentionEnabled && <p className="hint">Checks are paused because research Attention is off. <button className="btn small" onClick={() => openSettings('initiative', 'initiative-level')}>Attention settings</button></p>}
        <form className="follow-source-form" onSubmit={e => {
            e.preventDefault();
            action.mutate(async () => { await api.followSource({ ...target, url, label, kind }); setUrl(''); setLabel(''); setMessage('Source followed. Its first check establishes a baseline.'); });
        }}>
            <label htmlFor={`${uid}-url`}>Source URL</label>
            <input id={`${uid}-url`} className="input" type="url" required placeholder="https://example.org/feed.xml" value={url} maxLength={2000} onChange={e => setUrl(e.target.value)} />
            <label htmlFor={`${uid}-label`}>Label (optional)</label>
            <input id={`${uid}-label`} className="input" value={label} maxLength={120} onChange={e => setLabel(e.target.value)} />
            <label htmlFor={`${uid}-kind`}>Source type</label>
            <select id={`${uid}-kind`} className="select" value={kind} onChange={e => setKind(e.target.value as 'feed' | 'page')}><option value="feed">RSS / Atom feed</option><option value="page">Web page</option></select>
            <button type="submit" className="btn primary" disabled={action.isPending}>Follow source</button>
        </form>
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
        {query.data?.sources.length === 0 && <p className="hint">No sources followed for this topic yet.</p>}
        {query.data?.sources.map(source => <article key={source.id} className="followed-source" aria-label={source.label}>
            <h4><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></h4>
            <p className="hint">{source.kind === 'feed' ? 'Feed' : 'Web page'} · {source.enabled ? source.initialized ? 'Following' : 'Waiting for baseline' : 'Paused'}{source.lastCheckedAt && ` · checked ${source.lastCheckedAt} UTC`}</p>
            {source.lastError && <p role="alert">{source.lastError}</p>}
            <div className="follow-source-actions">
                <button className="btn small" disabled={action.isPending || !source.enabled || !query.data.attentionEnabled} onClick={() => action.mutate(async () => {
                    const result = await api.sourceCheck(source.id);
                    setMessage(result.status === 'baseline' ? 'Baseline saved. Future changes will appear here.' : result.status === 'waiting' ? 'Check deferred by a request interval. Try again shortly, or leave it for an automatic check.' : result.message || 'Source checked. Attention will evaluate new changes on its next sweep.');
                })}>Check now</button>
                <button className="btn small" disabled={action.isPending} onClick={() => action.mutate(() => api.sourceEnabled(source.id, !source.enabled))}>{source.enabled ? 'Pause source' : 'Resume source'}</button>
                <button className="btn small danger" disabled={action.isPending} onClick={async () => {
                    if (await confirm('Unfollow this source and delete its saved changes? Existing notices and research drafts follow their own retention.')) action.mutate(() => api.sourceRemove(source.id));
                }}>Unfollow</button>
            </div>
            <p className="hint">{source.metrics.kept} kept · {source.metrics.acted} acted on · {source.metrics.dismissed} dismissed · {source.metrics.snoozed} snoozed · {source.disabledCount} pauses</p>
            {source.entries.length > 0 && <details><summary>Recent changes ({source.entries.length})</summary>
                {source.entries.map(entry => <div className="source-entry" key={entry.id}>
                    <a href={entry.url} target="_blank" rel="noreferrer"><strong>{entry.title}</strong></a>
                    <p className="hint">Retrieved {entry.retrievedAt} UTC{entry.publishedAt && ` · published ${entry.publishedAt}`}{entry.author && ` · ${entry.author}`}</p>
                    <p className="source-excerpt">{entry.extractedText || 'Older text has expired; its source identity is retained.'}</p>
                    <div className="follow-source-actions">
                        <button className="btn small" disabled={action.isPending} aria-pressed={Boolean(entry.kept)} onClick={() => action.mutate(() => api.sourceKeep(source.id, entry.id, !entry.kept))}>{entry.kept ? 'Unkeep change' : 'Keep change'}</button>
                        {me.features?.spitball && !entry.expeditionId && <button className="btn small" disabled={action.isPending} onClick={() => action.mutate(async () => {
                            await api.sourceResearch(source.id, entry.id); void client.invalidateQueries({ queryKey: ['spitball'] }); toast('Private research draft prepared. Review it in Knowledge → Research, then choose Start research.');
                        })}>Prepare private research</button>}
                        {entry.expeditionId && <Link className="btn small" to={'/knowledge/research' as never}>Review research draft</Link>}
                    </div>
                </div>)}
            </details>}
        </article>)}
    </section>;
}
