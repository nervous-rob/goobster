import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import type { ProjectViewId } from '../../lib/rooms';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { ArtifactGallery } from '../observatory/ArtifactGallery';
import { whenLabel } from '../observatory/format';
import { EXECUTION_OFF } from './Command';
import { RunsList } from './RunsList';
import type { Detail } from './types';

const LATEST_RUNS = 3;

/**
 * The Overview: the goal, where the work stands (the open plan and its
 * next action), the latest runs and the outputs - each a step away from
 * its own view. Owner-only actions (share, delete) and the execution-gated
 * ones (render) sit here too.
 */
export function OverviewView({
    detail, ownerId, onChanged, onDeleted, onOpen
}: {
    detail: Detail;
    ownerId: string;
    onChanged: () => void;
    onDeleted: () => void;
    onOpen: (view: ProjectViewId) => void;
}) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const executionOn = Boolean(me.features?.observatory);
    const p = detail.project;
    const completed = detail.jobs.filter((j) => j.status === 'COMPLETED').length;
    const failed = detail.jobs.filter((j) => j.status === 'FAILED' || j.status === 'TIMED_OUT').length;
    const quotaPct = Math.min(100, Math.round(((p.sizeMb || 0) / Math.max(p.quotaMb || 1, 1)) * 100));
    const statusBits = [
        p.runningJobs ? `${p.runningJobs} running` : null,
        `${p.totalJobs || 0} run${p.totalJobs === 1 ? '' : 's'}`,
        completed ? `${completed} completed` : null,
        failed ? `${failed} failed` : null,
        `${p.sizeMb} / ${p.quotaMb} MB`,
        p.updatedAt ? `updated ${whenLabel(p.updatedAt)}` : null
    ].filter(Boolean);

    return (
        <>
            <div className="obs-project-head">
                <div className="obs-project-status">
                    {p.description
                        ? <p className="obs-goal" data-tour="project-goal">{p.description}</p>
                        : <p className="hint obs-goal is-empty" data-tour="project-goal">No goal written down yet. The Plan is where the outcome and its success criteria live.</p>}
                    <p className="obs-status-line">
                        {p.role === 'collaborator' ? `owner ${p.ownerName || p.ownerId} · ` : ''}
                        {statusBits.join(' · ')}
                    </p>
                    <div className="obs-quota" role="img" aria-label={`Disk quota ${quotaPct}% used`}>
                        <i style={{ width: `${quotaPct}%` }} />
                    </div>
                </div>
                <div className="obs-actions">
                    <button
                        type="button"
                        className={`btn${executionOn ? '' : ' is-muted'}`}
                        aria-disabled={!executionOn}
                        title={executionOn ? 'Render the workspace frames into a video' : EXECUTION_OFF}
                        onClick={async () => {
                            if (!executionOn) { toast(EXECUTION_OFF, true); return; }
                            try {
                                const result = await api.observatoryRender(p.slug, null, ownerId) as { frames: number; fps: number };
                                toast(`Rendered ${result.frames} frame(s) at ${result.fps} fps.`);
                                onChanged();
                            } catch (error) {
                                toast((error as Error).message, true);
                            }
                        }}
                    >Render video</button>
                    <a className="btn" target="_blank" rel="noopener" href={api.observatoryDashboardUrl(p.slug, ownerId)}>Snapshot</a>
                    {p.role !== 'collaborator' && (
                    <button
                        type="button"
                        className="btn"
                        onClick={async () => {
                            try {
                                const status = await api.observatoryShareStatus(p.slug, ownerId) as { shared?: boolean; url?: string };
                                if (!status.shared) {
                                    const created = await api.observatoryCreateShare(p.slug, ownerId) as { url: string };
                                    const url = new URL(created.url, window.location.origin).href;
                                    try { await navigator.clipboard.writeText(url); } catch { /* denied */ }
                                    toast(`Share link copied: ${url}`);
                                } else if (await confirm('Revoke the share link? The URL stops working immediately.')) {
                                    await api.observatoryRevokeShare(p.slug, ownerId);
                                    toast('Share link revoked.');
                                } else if (status.url) {
                                    const url = new URL(status.url, window.location.origin).href;
                                    try { await navigator.clipboard.writeText(url); } catch { /* denied */ }
                                    toast(`Still shared — link copied: ${url}`);
                                }
                                onChanged();
                            } catch (error) {
                                toast((error as Error).message, true);
                            }
                        }}
                    >{p.shared ? 'Shared' : 'Share'}</button>
                    )}
                    {p.role !== 'collaborator' && (
                    <button
                        type="button"
                        className="btn danger"
                        onClick={async () => {
                            if (!await confirm(`Delete "${p.name}" and its whole workspace? Files and run history are gone for good.`)) return;
                            try {
                                await api.observatoryDeleteProject(p.slug, ownerId);
                                toast('Project deleted.');
                                onDeleted();
                            } catch (error) {
                                toast((error as Error).message, true);
                            }
                        }}
                    >Delete</button>
                    )}
                </div>
            </div>

            <div className="obs-overview">
                <OverviewPlan slug={p.slug} ownerId={ownerId} onOpen={() => onOpen('plan')} />
                <section className="obs-overview-jobs" data-tour="project-latest-runs">
                    <div className="obs-section-head">
                        <h3>Latest runs</h3>
                        <span className="hint">{detail.jobs.length || 'none yet'}</span>
                        {detail.jobs.length > 0 && (
                            <button type="button" className="btn small" onClick={() => onOpen('runs')}>All runs →</button>
                        )}
                    </div>
                    <RunsList slug={p.slug} ownerId={ownerId} jobs={detail.jobs} limit={LATEST_RUNS} onChanged={onChanged} />
                </section>
                <ArtifactGallery
                    files={detail.files}
                    totalFiles={detail.totalFiles}
                    onBrowse={() => onOpen('files')}
                />
            </div>
        </>
    );
}

function OverviewPlan({ slug, ownerId, onOpen }: { slug: string; ownerId: string; onOpen: () => void }) {
    const q = useQuery({
        queryKey: keys.projectMission(slug, ownerId),
        queryFn: () => api.projectMission(slug, ownerId) as Promise<{
            mission: {
                title: string;
                status: string;
                steps?: Array<{ id: number; title: string; status: string; kind?: string }>;
                evaluation?: { overall?: string };
            } | null;
        }>
    });
    const mission = q.data?.mission;
    if (!mission) {
        return (
            <section className="obs-overview-mission" data-tour="project-plan-summary">
                <div className="obs-section-head">
                    <h3>Plan</h3>
                    <button type="button" className="btn" onClick={onOpen}>Start one</button>
                </div>
                <p className="hint">No open plan — name an outcome and how you will know it worked.</p>
            </section>
        );
    }
    const steps = mission.steps || [];
    const next = steps.find((s) => ['READY', 'RUNNING', 'BLOCKED', 'PENDING'].includes(s.status));
    const nextAction = mission.status === 'DRAFT' ? 'Review the steps and approve the plan.'
        : mission.status === 'REVIEW' ? 'Weigh the evidence and complete the plan.'
            : mission.status === 'BLOCKED' ? 'A step is blocked - unblock or skip it.'
                : next ? `Next: ${next.title}` : null;
    return (
        <section className="obs-overview-mission" data-tour="project-plan-summary">
            <div className="obs-section-head">
                <h3>Plan</h3>
                <span className="badge">{mission.status}</span>
            </div>
            <p className="obs-mission-objective">{mission.title}</p>
            {nextAction ? <p className="hint">{nextAction}</p> : null}
            <button type="button" className="btn" onClick={onOpen}>Open plan</button>
        </section>
    );
}
