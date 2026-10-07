import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTransport } from '../transport';
import { describeError } from '../ui';
import { planAndApply } from './common';

export const RELEASE_COMMAND = 'node apps/manager/cli.js release';
export const FORCE_RELEASE_COMMAND = 'node apps/manager/cli.js release --force --acknowledge-mutation';

/**
 * The maintenance barrier, when it is up. A restore or a reset leaves it up on
 * purpose, and the instance paused: releasing the barrier lets the workers
 * write again but never resumes the instance. The two are separate controls
 * (documentation/backup_and_restore.md, "Coming back").
 */
export function BarrierPanel({ canRelease }: { canRelease: boolean }) {
    const transport = useTransport();
    const client = useQueryClient();
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const query = useQuery({ queryKey: ['setup', 'maintenance'], queryFn: () => transport.maintenance(), retry: false, refetchInterval: 5000, staleTime: 0 });
    const view = query.data;
    if (!view || !view.active) return null;
    const mutateBegun = view.mutateBegun === true;
    const stale = view.stale === true;
    const operationId = typeof view.operationId === 'string' ? view.operationId : null;
    const fence = typeof view.fence === 'number' ? view.fence : null;

    async function release() {
        if (!operationId || fence === null) return;
        setBusy(true);
        setProblem(null);
        try {
            await planAndApply(transport, 'maintenance.release', { operationId, fence, ...(mutateBegun ? { acknowledgeMutation: true } : {}) });
        } catch (error) {
            setProblem(describeError(error).message);
        } finally {
            setBusy(false);
            void client.invalidateQueries({ queryKey: ['setup', 'maintenance'] });
            void client.invalidateQueries({ queryKey: ['setup', 'backup-status'] });
        }
    }

    return (
        <div className="wizard-callout" role="status" data-testid="barrier-panel" data-phase={String(view.phase || '')} data-stale={stale ? 'true' : 'false'}>
            <p>
                <strong>Maintenance is held.</strong> The application is not writing{view.phase ? ` (phase: ${String(view.phase)})` : ''}.
                {stale ? ' It was left by an earlier manager process and is never resumed automatically.' : ''}
                {mutateBegun ? ' Part of the data was already replaced: this cannot be undone by releasing.' : ''}
            </p>
            <p className="hint" data-testid="barrier-resume-note">
                Releasing maintenance lets the application write again. It does <em>not</em> resume the instance: a restore or a reset leaves it paused until you resume it
                (Host room, Instance page, Resume).
            </p>
            {canRelease && !stale && (
                <>
                    {mutateBegun && (
                        <label className="wizard-choice">
                            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} data-testid="barrier-acknowledge" />
                            {' '}I understand the data was already replaced and releasing does not undo that.
                        </label>
                    )}
                    <p>
                        <button type="button" className="btn" onClick={() => void release()} disabled={busy || (mutateBegun && !acknowledged)} data-testid="barrier-release">
                            {busy ? 'Releasing…' : 'Release maintenance'}
                        </button>
                    </p>
                </>
            )}
            {(!canRelease || stale) && (
                <>
                    <p>Release it from the manager page, or on the machine:</p>
                    <pre><code>{stale ? FORCE_RELEASE_COMMAND : RELEASE_COMMAND}</code></pre>
                </>
            )}
            {problem && <p role="alert" className="settings-danger">{problem}</p>}
        </div>
    );
}
