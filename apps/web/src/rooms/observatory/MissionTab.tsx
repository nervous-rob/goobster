import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { whenLabel } from './format';

type Criterion = { id: string; text: string };
type Step = {
    id: number;
    kind: 'expedition' | 'job' | 'watch' | 'human';
    title: string;
    description?: string | null;
    status: string;
    dependsOn?: number[];
};
type Evidence = {
    id: number;
    criterionId?: string | null;
    kind: string;
    refId: number;
    label?: string | null;
    polarity: string;
};
type Evaluation = {
    overall: string;
    met: number;
    unmet: number;
    open: number;
    criteria: Array<{ id: string; text: string; verdict: string; support: number; against: number }>;
};
type TimelineEvent = { id: number; kind: string; createdAt: string };
type Mission = {
    id: number;
    title: string;
    objective: string;
    successCriteria: Criterion[];
    deadline?: string | null;
    status: string;
    review?: { verdict?: string; notes?: string | null } | null;
    steps: Step[];
    evidence: Evidence[];
    evaluation: Evaluation;
    timeline: TimelineEvent[];
    createdAt?: string;
    approvedAt?: string | null;
};
type HistoryRow = { id: number; title: string; status: string; completedAt?: string | null };

const STEP_KINDS: Array<Step['kind']> = ['expedition', 'job', 'watch', 'human'];

export function MissionTab({
    slug,
    ownerId
}: {
    slug: string;
    ownerId?: string | null;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const missionKey = keys.projectMission(slug, ownerId);

    const q = useQuery({
        queryKey: missionKey,
        queryFn: () => api.projectMission(slug, ownerId) as Promise<{ mission: Mission | null; history: HistoryRow[] }>
    });

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: missionKey });
        queryClient.invalidateQueries({ queryKey: keys.observatory });
    };

    const run = useMutation({
        mutationFn: async (fn: () => Promise<unknown>) => fn(),
        onSuccess: () => invalidate(),
        onError: (error) => toast((error as Error).message, true)
    });

    const mission = q.data?.mission || null;
    const history = (q.data?.history || []).filter((row) => row.status === 'COMPLETED' || row.status === 'CANCELLED');

    return (
        <div className="obs-mission">
            {q.isPending && <div className="empty">Loading mission…</div>}
            {q.isError && <div className="empty">{(q.error as Error).message}</div>}
            {q.isSuccess && !mission && (
                <DraftForm
                    slug={slug}
                    ownerId={ownerId}
                    busy={run.isPending}
                    onCreate={(body) => run.mutate(() => api.createProjectMission(slug, body, ownerId))}
                />
            )}
            {mission && (
                <MissionView
                    slug={slug}
                    ownerId={ownerId}
                    mission={mission}
                    busy={run.isPending}
                    onApprove={() => run.mutate(async () => {
                        await api.projectMissionAction(slug, 'approve', {}, ownerId);
                        return api.projectMissionAction(slug, 'start', {}, ownerId);
                    })}
                    onStart={() => run.mutate(() => api.projectMissionAction(slug, 'start', {}, ownerId))}
                    onResume={() => run.mutate(() => api.projectMissionAction(slug, 'resume', {}, ownerId))}
                    onCancel={async () => {
                        if (!await confirm(`Cancel “${mission.title}”? Open steps are skipped.`)) return;
                        run.mutate(() => api.projectMissionAction(slug, 'cancel', {}, ownerId));
                    }}
                    onStartStep={(id) => run.mutate(() => api.projectMissionStartStep(slug, id, ownerId))}
                    onCompleteStep={(id) => run.mutate(() => api.projectMissionCompleteStep(slug, id, undefined, ownerId))}
                    onSkipStep={(id) => run.mutate(() => api.projectMissionSkipStep(slug, id, undefined, ownerId))}
                    onAddStep={(body) => run.mutate(() => api.addProjectMissionStep(slug, body, ownerId))}
                    onAddEvidence={(body) => run.mutate(() => api.addProjectMissionEvidence(slug, body, ownerId))}
                    onReview={(notes, verdict) => run.mutate(() =>
                        api.projectMissionAction(slug, 'review', { notes, verdict }, ownerId))}
                    onComplete={(notes, verdict) => run.mutate(() =>
                        api.projectMissionAction(slug, 'complete', { notes, verdict }, ownerId))}
                />
            )}
            {history.length > 0 && (
                <details className="obs-mission-history">
                    <summary>Earlier missions ({history.length})</summary>
                    <ul>
                        {history.map((row) => (
                            <li key={row.id}>
                                <span className="badge">{row.status}</span> {row.title}
                                {row.completedAt ? ` · ${whenLabel(row.completedAt)}` : ''}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}

function DraftForm({
    slug: _slug,
    ownerId: _ownerId,
    busy,
    onCreate
}: {
    slug: string;
    ownerId?: string | null;
    busy: boolean;
    onCreate: (body: Record<string, unknown>) => void;
}) {
    const [title, setTitle] = useState('');
    const [objective, setObjective] = useState('');
    const [criteria, setCriteria] = useState('');
    const [deadline, setDeadline] = useState('');

    return (
        <div className="obs-mission-draft">
            <div className="section-title">Start a mission</div>
            <p className="hint">
                One outcome, how you will know it worked, and a plan you can approve in under a minute.
                Ask Goobster in the project chat if you would rather draft it conversationally.
            </p>
            <label className="obs-mission-field">
                <span>Title</span>
                <input className="input" value={title} maxLength={120} placeholder="pgvector at one million notes"
                    onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="obs-mission-field">
                <span>Objective</span>
                <textarea className="input" rows={3} maxLength={2000}
                    placeholder="Determine whether pgvector recall remains useful above one million notes."
                    value={objective} onChange={(e) => setObjective(e.target.value)} />
            </label>
            <label className="obs-mission-field">
                <span>Success criteria — one per line</span>
                <textarea className="input" rows={3} maxLength={2000}
                    placeholder={'A reproducible benchmark artifact exists\nA written recommendation to keep, shard, or replace'}
                    value={criteria} onChange={(e) => setCriteria(e.target.value)} />
            </label>
            <label className="obs-mission-field">
                <span>Deadline (optional)</span>
                <input className="input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
            <button
                type="button"
                className="btn primary"
                disabled={busy || objective.trim().length < 8 || criteria.trim().length < 4}
                onClick={() => onCreate({
                    title: title.trim() || undefined,
                    objective: objective.trim(),
                    successCriteria: criteria,
                    deadline: deadline || undefined
                })}
            >
                {busy ? 'Drafting…' : 'Draft mission'}
            </button>
        </div>
    );
}

function MissionView({
    slug: _slug,
    ownerId: _ownerId,
    mission,
    busy,
    onApprove,
    onStart,
    onResume,
    onCancel,
    onStartStep,
    onCompleteStep,
    onSkipStep,
    onAddStep,
    onAddEvidence,
    onReview,
    onComplete
}: {
    slug: string;
    ownerId?: string | null;
    mission: Mission;
    busy: boolean;
    onApprove: () => void;
    onStart: () => void;
    onResume: () => void;
    onCancel: () => void;
    onStartStep: (id: number) => void;
    onCompleteStep: (id: number) => void;
    onSkipStep: (id: number) => void;
    onAddStep: (body: Record<string, unknown>) => void;
    onAddEvidence: (body: Record<string, unknown>) => void;
    onReview: (notes: string, verdict: string) => void;
    onComplete: (notes: string, verdict: string) => void;
}) {
    const [stepKind, setStepKind] = useState<Step['kind']>('human');
    const [stepTitle, setStepTitle] = useState('');
    const [reviewNotes, setReviewNotes] = useState(mission.review?.notes || '');
    const [verdict, setVerdict] = useState(
        mission.review?.verdict && ['met', 'unmet', 'mixed'].includes(mission.review.verdict)
            ? mission.review.verdict
            : ['met', 'unmet', 'mixed'].includes(mission.evaluation.overall)
                ? mission.evaluation.overall
                : 'mixed'
    );
    const [evidenceKind, setEvidenceKind] = useState('note');
    const [evidenceId, setEvidenceId] = useState('');
    const [criterionId, setCriterionId] = useState(mission.successCriteria[0]?.id || '');
    const [polarity, setPolarity] = useState('for');
    const [evidenceLabel, setEvidenceLabel] = useState('');

    return (
        <div className="obs-mission-view">
            <div className="obs-section-head">
                <h3>{mission.title}</h3>
                <span className="badge">{mission.status}</span>
            </div>
            <p className="obs-mission-objective">{mission.objective}</p>
            {mission.deadline ? <p className="row-meta">Deadline {mission.deadline} UTC</p> : null}

            <div className="obs-mission-actions">
                {mission.status === 'DRAFT' && (
                    <button type="button" className="btn primary" disabled={busy} onClick={onApprove}>
                        Approve &amp; start
                    </button>
                )}
                {mission.status === 'APPROVED' && (
                    <button type="button" className="btn primary" disabled={busy} onClick={onStart}>Start</button>
                )}
                {mission.status === 'BLOCKED' && (
                    <button type="button" className="btn primary" disabled={busy} onClick={onResume}>Resume</button>
                )}
                {mission.status !== 'COMPLETED' && mission.status !== 'CANCELLED' && (
                    <button type="button" className="btn danger" disabled={busy} onClick={onCancel}>Cancel</button>
                )}
            </div>

            <div className="section-title">Success criteria</div>
            <ul className="obs-mission-criteria">
                {mission.evaluation.criteria.map((c) => (
                    <li key={c.id}>
                        <span className={`badge verdict-${c.verdict}`}>{c.verdict}</span>
                        {c.text}
                        <span className="row-meta"> {c.support} for / {c.against} against</span>
                    </li>
                ))}
            </ul>

            <div className="section-title">Steps</div>
            {mission.steps.length === 0
                ? <div className="empty">No steps yet — add one below or ask Goobster to plan.</div>
                : (
                    <div className="list-card">
                        {mission.steps.map((step) => (
                            <div key={step.id} className="list-row task-row">
                                <div className="row-body">
                                    <span className="badge">{step.status}</span>
                                    <strong>{step.title}</strong>
                                    <div className="row-meta">{step.kind}{step.description ? ` · ${step.description}` : ''}</div>
                                </div>
                                {mission.status === 'ACTIVE' && (step.status === 'READY' || step.status === 'PENDING') && step.kind !== 'human' && (
                                    <button type="button" className="btn" disabled={busy} onClick={() => onStartStep(step.id)}>Start</button>
                                )}
                                {mission.status === 'ACTIVE' && step.kind === 'human' && step.status !== 'DONE' && step.status !== 'SKIPPED' && (
                                    <button type="button" className="btn primary" disabled={busy} onClick={() => onCompleteStep(step.id)}>Done</button>
                                )}
                                {['DRAFT', 'APPROVED', 'ACTIVE', 'BLOCKED'].includes(mission.status)
                                    && step.status !== 'DONE' && step.status !== 'SKIPPED' && (
                                    <button type="button" className="btn" disabled={busy} onClick={() => onSkipStep(step.id)}>Skip</button>
                                )}
                            </div>
                        ))}
                    </div>
                )}

            {(mission.status === 'DRAFT' || mission.status === 'APPROVED') && (
                <div className="obs-mission-add">
                    <select className="input" value={stepKind} onChange={(e) => setStepKind(e.target.value as Step['kind'])}>
                        {STEP_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                    <input className="input" placeholder="Step title" value={stepTitle} maxLength={160}
                        onChange={(e) => setStepTitle(e.target.value)} />
                    <button type="button" className="btn" disabled={busy || !stepTitle.trim()}
                        onClick={() => {
                            onAddStep({ kind: stepKind, title: stepTitle.trim() });
                            setStepTitle('');
                        }}>Add step</button>
                </div>
            )}

            <div className="section-title">Evidence</div>
            {mission.evidence.length === 0
                ? <div className="empty">No evidence linked yet.</div>
                : (
                    <ul className="obs-mission-evidence">
                        {mission.evidence.map((item) => (
                            <li key={item.id}>
                                <span className="badge">{item.polarity}</span>
                                {item.kind} #{item.refId}
                                {item.label ? ` — ${item.label}` : ''}
                                {item.criterionId ? ` · ${item.criterionId}` : ''}
                            </li>
                        ))}
                    </ul>
                )}
            {mission.status !== 'COMPLETED' && mission.status !== 'CANCELLED' && (
                <div className="obs-mission-add">
                    <select className="input" value={evidenceKind} onChange={(e) => setEvidenceKind(e.target.value)}>
                        <option value="note">note</option>
                        <option value="claim">claim</option>
                        <option value="job">job</option>
                        <option value="artifact">artifact</option>
                    </select>
                    <input className="input" placeholder="id" value={evidenceId}
                        onChange={(e) => setEvidenceId(e.target.value)} />
                    <select className="input" value={criterionId} onChange={(e) => setCriterionId(e.target.value)}>
                        {mission.successCriteria.map((c) => <option key={c.id} value={c.id}>{c.id}</option>)}
                    </select>
                    <select className="input" value={polarity} onChange={(e) => setPolarity(e.target.value)}>
                        <option value="for">for</option>
                        <option value="against">against</option>
                        <option value="neutral">neutral</option>
                    </select>
                    <input className="input" placeholder="label" value={evidenceLabel}
                        onChange={(e) => setEvidenceLabel(e.target.value)} />
                    <button type="button" className="btn" disabled={busy || !evidenceId}
                        onClick={() => {
                            onAddEvidence({
                                kind: evidenceKind,
                                refId: Number(evidenceId),
                                criterionId,
                                polarity,
                                label: evidenceLabel || undefined
                            });
                            setEvidenceId('');
                            setEvidenceLabel('');
                        }}>Link</button>
                </div>
            )}

            {(mission.status === 'ACTIVE' || mission.status === 'BLOCKED' || mission.status === 'REVIEW') && (
                <div className="obs-mission-review">
                    <div className="section-title">Review</div>
                    <p className="hint">Compare the evidence against the original criteria. Completing writes a decision record.</p>
                    <textarea className="input" rows={3} value={reviewNotes}
                        placeholder="What the evidence shows versus what we set out to learn."
                        onChange={(e) => setReviewNotes(e.target.value)} />
                    <div className="obs-mission-add">
                        <select className="input" value={verdict} onChange={(e) => setVerdict(e.target.value)}>
                            <option value="met">met</option>
                            <option value="mixed">mixed</option>
                            <option value="unmet">unmet</option>
                        </select>
                        {mission.status !== 'REVIEW' && (
                            <button type="button" className="btn" disabled={busy}
                                onClick={() => onReview(reviewNotes, verdict)}>Submit review</button>
                        )}
                        {mission.status === 'REVIEW' && (
                            <button type="button" className="btn primary" disabled={busy}
                                onClick={() => onComplete(reviewNotes, verdict)}>Complete mission</button>
                        )}
                    </div>
                </div>
            )}

            {mission.review?.verdict && mission.status === 'COMPLETED' && (
                <p className="hint">Verdict: {mission.review.verdict}{mission.review.notes ? ` — ${mission.review.notes}` : ''}</p>
            )}

            {mission.timeline.length > 0 && (
                <details className="obs-mission-timeline">
                    <summary>Timeline ({mission.timeline.length})</summary>
                    <ol>
                        {mission.timeline.map((event) => (
                            <li key={event.id}>
                                <span className="badge">{event.kind}</span>
                                <span className="row-meta">{whenLabel(event.createdAt)}</span>
                            </li>
                        ))}
                    </ol>
                </details>
            )}
        </div>
    );
}
