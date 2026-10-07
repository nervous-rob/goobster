import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useConfirm } from '../../hooks/useConfirm';
import { useToast } from '../../hooks/useToast';
import { useDateLabel } from '../../hooks/useDateLabel';
import type { HostUpdateStatus, UpdateOperationKind } from '../../lib/types';
import { DocLink, failureOf, HOST_KEYS } from './shared';

const MODES = [
    { id: 'off', label: 'Off', hint: 'Nothing is checked on its own.' },
    { id: 'check', label: 'Check', hint: 'Look for a newer release and say so; install nothing.' },
    { id: 'download', label: 'Download', hint: 'Check, then download and verify the release so it is ready to apply.' },
    { id: 'apply', label: 'Apply', hint: 'Check, stage and apply inside the update window (the manager must be the updater).' }
] as const;

const CHECK_LABEL: Record<string, string> = {
    available: 'A newer release is available',
    'up-to-date': 'Up to date',
    unavailable: 'The release source could not be reached',
    refused: 'The release source was refused'
};

const APPLY_LABEL: Record<string, string> = {
    applied: 'Applied',
    rolled_back: 'Rolled back to the previous release',
    recovery: 'Waiting for a decision',
    'handoff-pending': 'The manager is restarting to finish the update'
};

/** Next poll: quick while an update is in flight, slow when idle. */
function pollInterval(data: HostUpdateStatus | undefined, failures: number): number {
    if (failures > 0) return Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
    if (data?.handoff || data?.scheduled) return 2_000;
    return 15_000;
}

/**
 * The Updates panel of the Host overview: what is installed, the policy, the last check and what is staged, with Check, Stage and Apply.
 * Every change goes through the manager as an operation (preview, then apply), exactly like the command line. A paused update that
 * needs a decision (restore the backup or retry) is shown here and decided on the command line, which needs the local recovery session.
 */
export function UpdatesPanel({ enabled = true }: { enabled?: boolean }) {
    const toast = useToast();
    const confirm = useConfirm();
    const whenLabel = useDateLabel();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const query = useQuery({
        queryKey: HOST_KEYS.update,
        queryFn: () => api.hostUpdateStatus(),
        enabled,
        retry: false,
        refetchInterval: (q) => pollInterval(q.state.data, q.state.fetchFailureCount)
    });
    const data = query.data;

    async function run(kind: UpdateOperationKind, input: Record<string, unknown>, name: string, done: (outcome: Record<string, unknown> | null) => string) {
        setBusy(name);
        try {
            const preview = await api.hostPreview(kind, input);
            const applied = await api.hostApply(preview.operation.id);
            toast(done((applied.result || null) as Record<string, unknown> | null));
        } catch (error) {
            const failure = failureOf(error);
            toast(`${failure.message}${failure.code ? ` (${failure.code})` : ''}`, true);
        } finally {
            setBusy(null);
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: HOST_KEYS.update }),
                queryClient.invalidateQueries({ queryKey: HOST_KEYS.manager }),
                queryClient.invalidateQueries({ queryKey: HOST_KEYS.audit })
            ]);
        }
    }

    const check = () => run('update.check', {}, 'check', (r) => CHECK_LABEL[String(r?.outcome)] || 'Checked');
    const stage = () => run('update.stage', {}, 'stage', (r) => (r?.staged ? `Release ${String(r.version)} downloaded and verified` : 'Nothing was staged'));
    async function apply() {
        const staged = data?.staged;
        const lead = staged
            ? `Apply ${staged.version}? `
            : 'Apply the newest release? ';
        const body = 'Goobster takes a verified backup, stops accepting work, switches releases and checks that it is healthy. '
            + 'It is unavailable for a short time while that happens'
            + (staged?.schemaChanging ? ', and this release changes the database schema, so if it fails after it started you decide whether to restore the backup (writes since are lost) or retry.' : ', and a failed update puts the previous release back automatically.');
        if (!await confirm(lead + body)) return;
        await run('update.apply', { when: 'now' }, 'apply', (r) => APPLY_LABEL[String(r?.outcome)] || 'Update finished');
    }
    async function setMode(mode: string) {
        await run('update.policy', { mode }, 'policy', () => `Updates set to ${mode}`);
    }

    const policy = data?.policy;
    const recovery = data?.recovery || null;
    const last = data?.lastApply || null;
    const available = data?.lastCheck?.outcome === 'available';
    const canStage = available && !data?.staged;
    const canApply = Boolean(data?.staged && !data.staged.stale) && data?.updater === 'manager' && !recovery && !data?.handoff;

    return (
        <section className="settings-section" aria-labelledby="host-update-title" data-testid="host-updates">
            <h2 id="host-update-title">Updates</h2>
            <p className="hint">
                Check for a newer release, download and verify it, then apply it. Your settings, secrets and data are never touched by an update.
                {' '}<DocLink slug="manager-update">How updates work</DocLink>
            </p>
            {query.isPending && <div className="hint" role="status">Loading…</div>}
            {data && !data.available && (
                <div className="list-card" role="status" data-testid="update-unavailable" data-code={data.code}>
                    <div className="list-row"><span>Updates are managed for installed releases. This installation has no release recorded, so there is nothing to update from here.</span></div>
                </div>
            )}
            {data?.available && policy && (
                <div className="list-card">
                    <div className="list-row"><span>Installed</span><span data-testid="update-installed"><strong>{data.installed?.version}</strong><span className="hint"> · {data.installed?.target}</span></span></div>
                    <div className="list-row">
                        <span>Updates</span>
                        <span>
                            <select
                                aria-label="Update mode"
                                data-testid="update-mode"
                                value={policy.mode}
                                disabled={busy !== null}
                                onChange={(event) => { void setMode(event.target.value); }}
                            >
                                {MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
                            </select>
                            <span className="hint"> · {MODES.find(m => m.id === policy.mode)?.hint}</span>
                        </span>
                    </div>
                    {policy.capped && (
                        <div className="list-row" data-testid="update-capped"><span className="hint">Apply is held at Download: another updater owns this installation, so the manager does not install on its own.</span></div>
                    )}
                    <div className="list-row"><span>Source</span><span>{policy.source.kind === 'github-release' ? `GitHub releases · ${policy.source.owner}/${policy.source.repo}` : policy.source.kind} · {policy.channel}</span></div>
                    <div className="list-row">
                        <span>Last check</span>
                        <span data-testid="update-last-check">
                            {data.lastCheck
                                ? <><strong>{CHECK_LABEL[data.lastCheck.outcome] || data.lastCheck.outcome}</strong>{data.lastCheck.latest ? ` · ${data.lastCheck.latest.version}` : ''}<span className="hint"> · {whenLabel(data.lastCheck.at)}</span></>
                                : <span className="hint">Not checked yet</span>}
                        </span>
                    </div>
                    {data.staged && (
                        <div className="list-row" data-testid="update-staged">
                            <span>Ready to apply</span>
                            <span><strong>{data.staged.version}</strong>{data.staged.schemaChanging ? ' · changes the database schema' : ''}{data.staged.stale ? ' · out of date, stage it again' : ''}</span>
                        </div>
                    )}
                    {data.scheduled && (
                        <div className="list-row" data-testid="update-scheduled"><span>Scheduled</span><span>Opens {whenLabel(data.scheduled.opensAt)}</span></div>
                    )}
                    {data.handoff && (
                        <div className="list-row" role="status" data-testid="update-handoff"><span>In progress</span><span>{data.handoff.from} to {data.handoff.to} · {data.handoff.settling ? `verifying (settling, ${data.handoff.settling.secondsLeft} s left)` : data.handoff.phase}</span></div>
                    )}
                    {last && !recovery && (
                        <div className="list-row" data-testid="update-last-apply">
                            <span>Last update</span>
                            <span>
                                <strong>{APPLY_LABEL[last.outcome] || last.outcome}</strong>
                                {last.from && last.to ? ` · ${last.from.version} to ${last.to.version}` : ''}
                                {typeof last.downtimeMs === 'number' ? ` · ${(last.downtimeMs / 1000).toFixed(1)} s unavailable` : ''}
                            </span>
                        </div>
                    )}
                    <div className="list-row">
                        <span />
                        <span className="wizard-actions">
                            <button type="button" className="btn" data-testid="update-check" disabled={busy !== null || policy.mode === 'off'} onClick={() => { void check(); }}>{busy === 'check' ? 'Checking…' : 'Check now'}</button>
                            <button type="button" className="btn" data-testid="update-stage" disabled={busy !== null || !canStage} onClick={() => { void stage(); }}>{busy === 'stage' ? 'Downloading…' : 'Download and verify'}</button>
                            <button type="button" className="btn btn-primary" data-testid="update-apply" disabled={busy !== null || !canApply} onClick={() => { void apply(); }}>{busy === 'apply' ? 'Applying…' : 'Apply now'}</button>
                        </span>
                    </div>
                    {data.updater !== 'manager' && (
                        <div className="list-row" data-testid="update-not-updater"><span className="hint">The manager is not this installation&apos;s updater, so it does not apply updates. {' '}<DocLink slug="manager-update" hash="one-updater">Moving updates to the manager</DocLink></span></div>
                    )}
                </div>
            )}
            {recovery && (
                <div className="list-card" role="alert" data-testid="update-recovery" data-code={recovery.code}>
                    <div className="list-row"><span><strong>An update needs a decision</strong></span></div>
                    <div className="list-row"><span>
                        The update from {recovery.from.version} to {recovery.to.version} failed after the database was already changed ({recovery.code}).
                        Goobster is paused so nothing else is written. {recovery.warning}
                    </span></div>
                    <div className="list-row"><span className="hint">
                        This is decided on the machine that runs Goobster, with the manager&apos;s local recovery session:
                        {' '}<code>goobster-manager update recovery --decision restore --yes</code> or <code>--decision retry</code>.
                    </span></div>
                    <div className="list-row"><DocLink slug="manager-update" hash="recovery">What each decision does</DocLink></div>
                </div>
            )}
        </section>
    );
}
