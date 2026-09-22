import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { Modal } from '../../components/Modal';
import { whenLabel } from '../observatory/format';

/**
 * Automations of one project: cron and event triggers, their deliveries,
 * and the trigger editor. Visible words are Plan / Run (ADR 0009); the
 * trigger topics (`job_settled` …) and action ids are API vocabulary and
 * stay as they are.
 */
export type Trigger = {
    id: number;
    name: string;
    kind: 'cron' | 'event';
    schedule?: string | null;
    nextRun?: string | null;
    eventTopic?: string | null;
    sourceAssetId?: number | null;
    sourceTriggerId?: number | null;
    action: 'run_script' | 'render' | 'fetch_data' | 'agent_prompt';
    actionAssetId?: number | null;
    actionParams?: Record<string, unknown>;
    isEnabled: boolean;
    lastRun?: string | null;
    // Dispatch result ("started: job #12, awaiting settlement") ...
    lastOutcome?: string | null;
    // ... vs. how the most recently started stage actually settled.
    lastJobOutcome?: string | null;
};

type Delivery = {
    id: number;
    sourceJobId: number;
    sourceStatus?: string | null;
    sourceFinishedAt?: string | null;
    status: 'STARTED' | 'DELIVERED' | 'RETRYABLE' | 'FAILED' | 'SKIPPED';
    attempts: number;
    childJobId?: number | null;
    childStatus?: string | null;
    childErrorCode?: string | null;
    detail?: string | null;
    nextAttemptAt?: string | null;
    updatedAt: string;
};

type ScriptAsset = { id: number; slug: string; name: string; currentVersion?: number | null };

type TriggerDraft = {
    name: string;
    kind: 'cron' | 'event';
    schedule: string;
    eventTopic: 'job_completed' | 'job_failed' | 'job_settled';
    sourceAssetId: string;
    sourceTriggerId: string;
    action: Trigger['action'];
    actionAssetId: string;
    background: boolean;
    requiredOutputs: string;
    fps: string;
    url: string;
    filename: string;
    prompt: string;
    allowSelfChain: boolean;
    maxChainDepth: string;
    isEnabled: boolean;
};

const EMPTY_DRAFT: TriggerDraft = {
    name: '',
    kind: 'cron',
    schedule: '0 2 * * *',
    eventTopic: 'job_settled',
    sourceAssetId: '',
    sourceTriggerId: '',
    action: 'run_script',
    actionAssetId: '',
    background: true,
    requiredOutputs: '',
    fps: '',
    url: '',
    filename: '',
    prompt: '',
    allowSelfChain: false,
    maxChainDepth: '',
    isEnabled: true
};

function draftFromTrigger(trigger: Trigger): TriggerDraft {
    const params = trigger.actionParams || {};
    return {
        name: trigger.name,
        kind: trigger.kind,
        schedule: trigger.schedule || '0 2 * * *',
        eventTopic: (trigger.eventTopic as TriggerDraft['eventTopic']) || 'job_settled',
        sourceAssetId: trigger.sourceAssetId != null ? String(trigger.sourceAssetId) : '',
        sourceTriggerId: trigger.sourceTriggerId != null ? String(trigger.sourceTriggerId) : '',
        action: trigger.action,
        actionAssetId: trigger.actionAssetId != null ? String(trigger.actionAssetId) : '',
        background: params.background !== false && params.background !== 0,
        requiredOutputs: Array.isArray(params.requiredOutputs) && params.requiredOutputs.length
            ? JSON.stringify(params.requiredOutputs, null, 2)
            : '',
        fps: params.fps != null ? String(params.fps) : '',
        url: typeof params.url === 'string' ? params.url : '',
        filename: typeof params.filename === 'string' ? params.filename : '',
        prompt: typeof params.prompt === 'string' ? params.prompt : '',
        allowSelfChain: params.allowSelfChain === true || params.allowSelfChain === 1,
        maxChainDepth: params.maxChainDepth != null ? String(params.maxChainDepth) : '',
        isEnabled: trigger.isEnabled
    };
}

/** Parse the required-outputs textarea: empty clears; otherwise a JSON array. */
function parseRequiredOutputs(text: string): unknown[] | null {
    const raw = text.trim();
    if (!raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('Required outputs must be a JSON array like [{ "path": "out/{utc_date}.json", "type": "json" }].');
    }
    if (!Array.isArray(parsed)) throw new Error('Required outputs must be a JSON array.');
    return parsed;
}

function payloadFromDraft(draft: TriggerDraft): Record<string, unknown> {
    const actionParams: Record<string, unknown> = {};
    if (draft.action === 'run_script') {
        actionParams.background = draft.background;
        // null drops a previously stored contract (the API merges params).
        actionParams.requiredOutputs = parseRequiredOutputs(draft.requiredOutputs);
    }
    if (draft.action === 'render' && draft.fps.trim()) actionParams.fps = Number(draft.fps);
    if (draft.action === 'fetch_data') {
        actionParams.url = draft.url.trim();
        if (draft.filename.trim()) actionParams.filename = draft.filename.trim();
    }
    if (draft.action === 'agent_prompt') actionParams.prompt = draft.prompt;
    if (draft.allowSelfChain) actionParams.allowSelfChain = true;
    if (draft.maxChainDepth.trim()) actionParams.maxChainDepth = Number(draft.maxChainDepth);
    return {
        name: draft.name.trim(),
        kind: draft.kind,
        schedule: draft.kind === 'cron' ? draft.schedule.trim() : null,
        eventTopic: draft.kind === 'event' ? draft.eventTopic : null,
        sourceAssetId: draft.kind === 'event' && draft.sourceAssetId ? Number(draft.sourceAssetId) : null,
        sourceTriggerId: draft.kind === 'event' && draft.sourceTriggerId ? Number(draft.sourceTriggerId) : null,
        action: draft.action,
        actionAssetId: draft.action === 'run_script' && draft.actionAssetId
            ? Number(draft.actionAssetId)
            : null,
        actionParams,
        isEnabled: draft.isEnabled
    };
}

/** "from ingest" / "from trigger Nightly" for the automation row meta. */
function describeFilters(trigger: Trigger, scripts: ScriptAsset[], triggers: Trigger[]): string | null {
    if (trigger.kind !== 'event') return null;
    const parts: string[] = [];
    if (trigger.sourceAssetId != null) {
        const asset = scripts.find((s) => s.id === trigger.sourceAssetId);
        parts.push(asset ? asset.slug : `asset #${trigger.sourceAssetId}`);
    }
    if (trigger.sourceTriggerId != null) {
        const source = triggers.find((t) => t.id === trigger.sourceTriggerId);
        parts.push(source ? `trigger "${source.name}"` : `trigger #${trigger.sourceTriggerId}`);
    }
    return parts.length ? `from ${parts.join(' + ')}` : null;
}

const DELIVERY_ICONS: Record<Delivery['status'], string> = {
    STARTED: '⏳', DELIVERED: '📬', RETRYABLE: '🔁', FAILED: '❌', SKIPPED: '⏭️'
};

/**
 * Per-event delivery records of an event trigger, loaded when expanded:
 * which settled source job relayed as which child job, or why it has not
 * (busy project = RETRYABLE with a next attempt; FAILED / SKIPPED with a reason).
 */
function TriggerDeliveries({ slug, ownerId, trigger }: { slug: string; ownerId?: string | null; trigger: Trigger }) {
    const [open, setOpen] = useState(false);
    const q = useQuery({
        queryKey: [...keys.projectTriggers(slug, ownerId), 'deliveries', trigger.id],
        queryFn: () => api.projectTriggerDeliveries(slug, trigger.id, ownerId) as Promise<{ deliveries: Delivery[] }>,
        enabled: open,
        retry: false
    });
    const deliveries = q.data?.deliveries || [];
    return (
        <details
            className="obs-tail obs-deliveries"
            data-testid={`trigger-deliveries-${trigger.id}`}
            onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
            <summary>deliveries</summary>
            {!open ? null : q.isLoading
                ? <div className="hint">Loading…</div>
                : q.error
                    ? <div className="row-meta obs-error">{(q.error as Error).message}</div>
                    : deliveries.length === 0
                        ? <div className="hint">No matching run has settled yet.</div>
                        : (
                            <ul className="obs-delivery-list">
                                {deliveries.map((d) => (
                                    <li key={d.id} className={`delivery-${d.status.toLowerCase()}`}>
                                        <span className="badge">{DELIVERY_ICONS[d.status]} {d.status}</span>
                                        {' '}source run #{d.sourceJobId}{d.sourceStatus ? ` (${d.sourceStatus})` : ''}
                                        {d.childJobId ? <> → child run #{d.childJobId}{d.childStatus ? ` ${d.childStatus}` : ''}{d.childErrorCode ? ` (${d.childErrorCode})` : ''}</> : null}
                                        <div className="row-meta">
                                            {[
                                                `${d.attempts} attempt(s)`,
                                                d.nextAttemptAt ? `next ${whenLabel(d.nextAttemptAt)}` : null,
                                                d.detail || null,
                                                whenLabel(d.updatedAt)
                                            ].filter(Boolean).join(' · ')}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
        </details>
    );
}

export function AutomationsTab({ slug, ownerId, role }: { slug: string; ownerId?: string | null; role?: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; id?: number; draft: TriggerDraft } | null>(null);

    const list = useQuery({
        queryKey: keys.projectTriggers(slug, ownerId),
        queryFn: () => api.projectTriggers(slug, ownerId) as Promise<{ triggers: Trigger[] }>,
        retry: false
    });
    const scripts = useQuery({
        queryKey: [...keys.projectAssets(slug, ownerId), 'script'],
        queryFn: () => api.projectAssets(slug, 'script', ownerId) as Promise<{ assets: ScriptAsset[] }>,
        retry: false
    });

    const triggers = list.data?.triggers || [];
    const scriptAssets = scripts.data?.assets || [];

    async function refresh() {
        await queryClient.invalidateQueries({ queryKey: keys.projectTriggers(slug, ownerId) });
    }

    async function toggleEnabled(trigger: Trigger) {
        try {
            await api.updateProjectTrigger(slug, trigger.id, { isEnabled: !trigger.isEnabled }, ownerId);
            toast(trigger.isEnabled ? `Paused "${trigger.name}".` : `Armed "${trigger.name}".`);
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function remove(trigger: Trigger) {
        if (!await confirm(`Delete trigger "${trigger.name}"?`)) return;
        try {
            await api.deleteProjectTrigger(slug, trigger.id, ownerId);
            toast(`Deleted "${trigger.name}".`);
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    async function save() {
        if (!editor) return;
        try {
            const body = payloadFromDraft(editor.draft);
            if (editor.mode === 'create') {
                await api.createProjectTrigger(slug, body, ownerId);
                toast(`Created trigger "${editor.draft.name}".`);
            } else if (editor.id != null) {
                await api.updateProjectTrigger(slug, editor.id, body, ownerId);
                toast(`Updated "${editor.draft.name}".`);
            }
            setEditor(null);
            await refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    if (list.isPending) return <div className="empty">Loading automations…</div>;
    if (list.isError) return <div className="empty">{(list.error as Error).message}</div>;

    return (
        <div className="obs-automations">
            <div className="obs-apps-toolbar">
                <div className="hint" style={{ flex: 1, margin: 0 }}>
                    Cron and event triggers on this project. Deterministic actions skip the agent.
                </div>
                <button
                    type="button"
                    className="btn primary"
                    onClick={() => setEditor({ mode: 'create', draft: { ...EMPTY_DRAFT } })}
                >+ New trigger</button>
            </div>
            {triggers.length === 0
                ? (
                    <div className="empty-state" style={{ marginTop: '4vh' }}>
                        <div className="empty-title">No automations yet</div>
                        <div className="hint">Run a stored script on a schedule, or chain runs with job_settled.</div>
                    </div>
                )
                : (
                    <div className="list-card">
                        {triggers.map((trigger) => (
                            <div key={trigger.id} className="list-row task-row">
                                <div className="row-body">
                                    <span className="badge">{trigger.isEnabled ? '🟢' : '⏸️'} {trigger.kind}</span>
                                    <strong>{trigger.name}</strong>
                                    <div className="row-meta">
                                        {[
                                            trigger.kind === 'cron'
                                                ? `cron ${trigger.schedule}`
                                                : trigger.eventTopic,
                                            describeFilters(trigger, scriptAssets, triggers),
                                            trigger.action,
                                            Array.isArray(trigger.actionParams?.requiredOutputs)
                                                && trigger.actionParams.requiredOutputs.length
                                                ? `${trigger.actionParams.requiredOutputs.length} required output(s)`
                                                : null,
                                            trigger.lastRun ? `last ${whenLabel(trigger.lastRun)}` : 'never ran'
                                        ].filter(Boolean).join(' · ')}
                                    </div>
                                    {trigger.lastOutcome || trigger.lastJobOutcome ? (
                                        <div className="row-meta obs-outcomes">
                                            {trigger.lastOutcome ? <span>dispatch: {trigger.lastOutcome}</span> : null}
                                            {trigger.lastJobOutcome ? <span>stage: {trigger.lastJobOutcome}</span> : null}
                                        </div>
                                    ) : null}
                                    {trigger.kind === 'event' ? (
                                        <TriggerDeliveries slug={slug} ownerId={ownerId} trigger={trigger} />
                                    ) : null}
                                </div>
                                <button type="button" className="btn" onClick={() => void toggleEnabled(trigger)}>
                                    {trigger.isEnabled ? 'Pause' : 'Enable'}
                                </button>
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={() => setEditor({
                                        mode: 'edit',
                                        id: trigger.id,
                                        draft: draftFromTrigger(trigger)
                                    })}
                                >Edit</button>
                                <button type="button" className="btn danger" onClick={() => void remove(trigger)}>
                                    Delete
                                </button>
                            </div>
                        ))}
                    </div>
                )}

            {editor && (
                <Modal onClose={() => setEditor(null)} wide>
                    <h2>{editor.mode === 'create' ? 'New trigger' : `Edit "${editor.draft.name}"`}</h2>
                    <div className="obs-trigger-form">
                        <label className="field">
                            <span className="hint">Name</span>
                            <input
                                className="input"
                                value={editor.draft.name}
                                onChange={(e) => setEditor({
                                    ...editor, draft: { ...editor.draft, name: e.target.value }
                                })}
                            />
                        </label>
                        <label className="field">
                            <span className="hint">When</span>
                            <select
                                className="select"
                                value={editor.draft.kind}
                                onChange={(e) => setEditor({
                                    ...editor,
                                    draft: { ...editor.draft, kind: e.target.value as TriggerDraft['kind'] }
                                })}
                            >
                                <option value="cron">Cron (UTC)</option>
                                <option value="event">Event</option>
                            </select>
                        </label>
                        {editor.draft.kind === 'cron'
                            ? (
                                <label className="field">
                                    <span className="hint">Schedule (5-field cron, UTC)</span>
                                    <input
                                        className="input"
                                        value={editor.draft.schedule}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, schedule: e.target.value }
                                        })}
                                        placeholder="0 2 * * *"
                                    />
                                </label>
                            )
                            : (
                                <label className="field">
                                    <span className="hint">Event</span>
                                    <select
                                        className="select"
                                        value={editor.draft.eventTopic}
                                        onChange={(e) => setEditor({
                                            ...editor,
                                            draft: {
                                                ...editor.draft,
                                                eventTopic: e.target.value as TriggerDraft['eventTopic']
                                            }
                                        })}
                                    >
                                        <option value="job_settled">job_settled (any terminal state)</option>
                                        <option value="job_completed">job_completed</option>
                                        <option value="job_failed">job_failed</option>
                                    </select>
                                </label>
                            )}
                        {editor.draft.kind === 'event' && (
                            <>
                                <label className="field">
                                    <span className="hint">Only runs from script (upstream stage, optional)</span>
                                    <select
                                        className="select"
                                        value={editor.draft.sourceAssetId}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, sourceAssetId: e.target.value }
                                        })}
                                    >
                                        <option value="">Any run in the project</option>
                                        {scriptAssets.map((asset) => (
                                            <option key={asset.id} value={asset.id}>
                                                {asset.name} ({asset.slug})
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="field">
                                    <span className="hint">Only runs started by trigger (optional)</span>
                                    <select
                                        className="select"
                                        value={editor.draft.sourceTriggerId}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, sourceTriggerId: e.target.value }
                                        })}
                                    >
                                        <option value="">Any trigger or manual run</option>
                                        {triggers
                                            .filter((t) => editor.mode !== 'edit' || t.id !== editor.id)
                                            .map((t) => (
                                                <option key={t.id} value={t.id}>{t.name}</option>
                                            ))}
                                    </select>
                                </label>
                            </>
                        )}
                        <label className="field">
                            <span className="hint">Action</span>
                            <select
                                className="select"
                                value={editor.draft.action}
                                onChange={(e) => setEditor({
                                    ...editor,
                                    draft: { ...editor.draft, action: e.target.value as Trigger['action'] }
                                })}
                            >
                                <option value="run_script">Run script</option>
                                <option value="render">Render frames</option>
                                <option value="fetch_data">Fetch data (allowlisted host)</option>
                                {role !== 'collaborator' && <option value="agent_prompt">Agent prompt</option>}
                            </select>
                        </label>
                        {editor.draft.action === 'run_script' && (
                            <>
                                <label className="field">
                                    <span className="hint">Script asset</span>
                                    <select
                                        className="select"
                                        value={editor.draft.actionAssetId}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, actionAssetId: e.target.value }
                                        })}
                                    >
                                        <option value="">Select a script…</option>
                                        {scriptAssets.map((asset) => (
                                            <option key={asset.id} value={asset.id}>
                                                {asset.name} ({asset.slug}
                                                {asset.currentVersion ? ` · v${asset.currentVersion}` : ''})
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="field checkbox">
                                    <input
                                        type="checkbox"
                                        checked={editor.draft.background}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, background: e.target.checked }
                                        })}
                                    />
                                    <span>Background run (records provenance, can chain)</span>
                                </label>
                                <label className="field">
                                    <span className="hint">
                                        Required outputs (optional JSON; exit 0 without them settles FAILED)
                                    </span>
                                    <textarea
                                        className="input"
                                        rows={3}
                                        value={editor.draft.requiredOutputs}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, requiredOutputs: e.target.value }
                                        })}
                                        placeholder={'[{ "path": "pipeline/manifest_{utc_date}.json", "type": "json", "minBytes": 2 }]'}
                                    />
                                </label>
                            </>
                        )}
                        {editor.draft.action === 'render' && (
                            <label className="field">
                                <span className="hint">FPS (optional)</span>
                                <input
                                    className="input"
                                    value={editor.draft.fps}
                                    onChange={(e) => setEditor({
                                        ...editor, draft: { ...editor.draft, fps: e.target.value }
                                    })}
                                    placeholder="24"
                                />
                            </label>
                        )}
                        {editor.draft.action === 'fetch_data' && (
                            <>
                                <label className="field">
                                    <span className="hint">HTTPS URL (allowlisted host)</span>
                                    <input
                                        className="input"
                                        value={editor.draft.url}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, url: e.target.value }
                                        })}
                                    />
                                </label>
                                <label className="field">
                                    <span className="hint">Filename (optional)</span>
                                    <input
                                        className="input"
                                        value={editor.draft.filename}
                                        onChange={(e) => setEditor({
                                            ...editor, draft: { ...editor.draft, filename: e.target.value }
                                        })}
                                    />
                                </label>
                            </>
                        )}
                        {editor.draft.action === 'agent_prompt' && (
                            <label className="field">
                                <span className="hint">Prompt</span>
                                <textarea
                                    className="input"
                                    rows={4}
                                    value={editor.draft.prompt}
                                    onChange={(e) => setEditor({
                                        ...editor, draft: { ...editor.draft, prompt: e.target.value }
                                    })}
                                />
                            </label>
                        )}
                        <label className="field checkbox">
                            <input
                                type="checkbox"
                                checked={editor.draft.isEnabled}
                                onChange={(e) => setEditor({
                                    ...editor, draft: { ...editor.draft, isEnabled: e.target.checked }
                                })}
                            />
                            <span>Enabled</span>
                        </label>
                        {editor.draft.kind === 'event' && (
                            <label className="field checkbox">
                                <input
                                    type="checkbox"
                                    checked={editor.draft.allowSelfChain}
                                    onChange={(e) => setEditor({
                                        ...editor,
                                        draft: { ...editor.draft, allowSelfChain: e.target.checked }
                                    })}
                                />
                                <span>Allow self-chain (fire on a run this trigger started)</span>
                            </label>
                        )}
                    </div>
                    <div className="modal-actions">
                        <button type="button" className="btn" onClick={() => setEditor(null)}>Cancel</button>
                        <button type="button" className="btn primary" onClick={() => void save()}>Save</button>
                    </div>
                </Modal>
            )}
        </div>
    );
}
