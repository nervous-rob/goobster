import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useMe } from '../hooks/useSession';
import { useConfirm } from '../hooks/useConfirm';

export function AccountExport() {
    const userId = useMe().user.id;
    const client = useQueryClient();
    const confirm = useConfirm();
    const key = ['account-exports', userId];
    const query = useQuery({ queryKey: key, queryFn: api.accountExports, refetchInterval: 5000 });
    const action = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(),
        onSuccess: () => { void client.invalidateQueries({ queryKey: key }); } });
    const active = query.data?.exports.some(row => row.status === 'QUEUED' || row.status === 'RUNNING');
    return <section className="account-export" aria-labelledby="account-export-title">
        <h3 id="account-export-title">Export your account</h3>
        <p className="hint">Create a private archive with notes, chats, research, settings and owned project files. Notes and chats are readable as Markdown; JSON preserves records and relationships. Shared content keeps its author attribution.</p>
        <p className="hint">You can leave this page while it is prepared. Your Inbox will link back here when it is ready. Downloads expire after 24 hours. The archive is unencrypted; store it somewhere private.</p>
        <button className="btn primary" disabled={action.isPending || active || query.isPending || query.isError}
            onClick={() => action.mutate(api.createAccountExport)}>{active ? 'Preparing account export…' : 'Create account export'}</button>
        {(action.isError || query.isError) && <p role="alert">{action.error?.message || query.error?.message} {query.isError && <button className="btn small" onClick={() => void query.refetch()}>Retry</button>}</p>}
        {query.isPending && <p role="status">Loading exports…</p>}
        {query.data?.exports.map(row => <article key={row.id} className="list-card" aria-label={`Account export ${row.createdAt}`}>
            <div className="list-row"><strong>{row.status === 'QUEUED' ? 'Waiting to start' : row.status === 'RUNNING' ? 'Preparing archive' : row.status === 'READY' ? 'Ready to download' : row.status === 'FAILED' ? 'Export failed' : 'Expired'}</strong><span className="hint">{row.createdAt} UTC</span></div>
            {row.error && row.status === 'FAILED' && <p role="alert">{row.error}</p>}
            {row.downloadUrl && <>
                <p className="hint">{((row.sizeBytes || 0) / 1024 / 1024).toFixed(1)} MB · {row.fileCount} files · expires {row.expiresAt} UTC</p>
                {Boolean(row.warningCount) && <p role="status">{row.warningCount} file(s) were unavailable or excluded. Read manifest.json for details.</p>}
                <a className="btn" href={row.downloadUrl} download>Download account archive</a>
            </>}
            <button className="btn small" disabled={action.isPending} onClick={async () => {
                if (await confirm('Delete this export? A running export will be cancelled. Your original data stays.')) action.mutate(() => api.deleteAccountExport(row.id));
            }}>Delete export</button>
        </article>)}
    </section>;
}
