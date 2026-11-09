import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { featureActive } from '../lib/rooms';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { useDateLabel } from '../hooks/useDateLabel';
import { MenuButton } from '../shell/MenuButton';
import type { Responsibility, ResponsibilityOperation } from '../lib/types';

/**
 * Responsibilities (documentation/delegated_responsibilities.md): the
 * bounded jobs a person has handed to the assistant. This page drafts one
 * from plain choices, shows exactly what each grants, and carries the
 * lifecycle (activate, pause, resume, complete, revoke, archive). A draft
 * grants nothing; only Activate, pressed by the person, turns one on.
 */

type Project = { id: number; slug: string; name: string; ownerId: string };

const OPERATION_TEXT: Record<string, string> = {
    read: 'read',
    research: 'research',
    'kg.generated.add': 'add generated notes',
    'kg.generated.amend': 'amend generated notes',
    'kg.saved.amend': 'amend notes you saved',
    'kg.edge': 'connect notes',
    'kg.archive': 'archive notes',
    'file.edit': 'edit files',
    'sandbox.run': 'run code in the sandbox',
    'process.repair': 'repair',
    'process.pause': 'pause',
    'process.archive': 'archive',
    'cleanup.exact': 'clean up',
    'repo.commit': 'commit',
    'repo.push': 'push',
    'pr.create': 'open pull requests',
    'external.write': 'write to an outside service'
};

const STATUS_TEXT: Record<string, string> = {
    DRAFT: 'draft', ACTIVE: 'active', PAUSED: 'paused', NEEDS_REVIEW: 'needs review',
    COMPLETED: 'completed', REVOKED: 'revoked', EXPIRED: 'expired', ARCHIVED: 'archived'
};

/** Which lifecycle buttons a status offers (the server re-checks each one). */
const ACTIONS: Record<string, Array<{ action: string; label: string; primary?: boolean; danger?: boolean; confirm?: string }>> = {
    DRAFT: [
        { action: 'activate', label: 'Activate', primary: true },
        { action: 'revoke', label: 'Discard', danger: true, confirm: 'Discard this draft? It never ran.' }
    ],
    ACTIVE: [
        { action: 'pause', label: 'Pause' },
        { action: 'complete', label: 'Mark complete', confirm: 'Mark this complete? Its open work is cancelled and it stops for good.' },
        { action: 'revoke', label: 'Revoke', danger: true, confirm: 'Revoke this? Its open work is cancelled now and it cannot be turned back on.' }
    ],
    PAUSED: [
        { action: 'resume', label: 'Resume', primary: true },
        { action: 'revoke', label: 'Revoke', danger: true, confirm: 'Revoke this? Its open work is cancelled now and it cannot be turned back on.' }
    ],
    NEEDS_REVIEW: [
        { action: 'resume', label: 'Looks right, resume', primary: true },
        { action: 'revoke', label: 'Revoke', danger: true, confirm: 'Revoke this? Its open work is cancelled now and it cannot be turned back on.' }
    ],
    COMPLETED: [{ action: 'archive', label: 'Archive' }],
    REVOKED: [{ action: 'archive', label: 'Archive' }],
    EXPIRED: [{ action: 'archive', label: 'Archive' }]
};

function describeResource(entry: ResponsibilityOperation, projects: Map<string, Project>): string {
    const resource = entry.resource;
    switch (resource.kind) {
        case 'knowledge': return 'your knowledge';
        case 'web': return 'the web';
        case 'project': {
            const names = (resource.ids || []).map((id) => projects.get(id)?.name || `project #${id}`).join(', ');
            return `${names}${resource.paths?.length ? ` (only ${resource.paths.join(', ')})` : ''}`;
        }
        case 'repository':
            return `${(resource.ids || []).join(', ')}${resource.branches?.length ? ` on ${resource.branches.join(', ')}` : ''}`;
        case 'process': return (resource.ids || []).join(', ');
        default: return (resource.ids || []).join(', ') || resource.kind;
    }
}

/** "read, research the web · add generated notes in your knowledge" */
function describeGrants(operations: ResponsibilityOperation[], projects: Map<string, Project>): string[] {
    const byResource = new Map<string, string[]>();
    for (const entry of operations) {
        const where = describeResource(entry, projects);
        byResource.set(where, [...(byResource.get(where) || []), OPERATION_TEXT[entry.operation] || entry.operation]);
    }
    return [...byResource.entries()].map(([where, verbs]) => `${verbs.join(', ')}: ${where}`);
}

function Draft({ projects, onCreated }: { projects: Project[]; onCreated: () => Promise<unknown> }) {
    const toast = useToast();
    const me = useMe();
    const [title, setTitle] = useState('');
    const [outcome, setOutcome] = useState('');
    const [web, setWeb] = useState(true);
    const [readKnowledge, setReadKnowledge] = useState(true);
    const [writeNotes, setWriteNotes] = useState(false);
    const [projectId, setProjectId] = useState('');
    const [editFiles, setEditFiles] = useState(false);
    const [paths, setPaths] = useState('');
    const [runCode, setRunCode] = useState(false);
    const [days, setDays] = useState('30');
    const [saving, setSaving] = useState(false);
    const canProjects = featureActive(me, 'projects');
    const canSandbox = featureActive(me, 'sandbox');
    const canResearch = featureActive(me, 'expeditions');
    const canKnowledge = featureActive(me, 'knowledge');

    function operations(): ResponsibilityOperation[] {
        const list: ResponsibilityOperation[] = [];
        if (web) {
            list.push({ operation: 'read', resource: { kind: 'web' } });
            if (canResearch) list.push({ operation: 'research', resource: { kind: 'web' } });
        }
        if (readKnowledge) list.push({ operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } });
        if (writeNotes && canKnowledge) {
            list.push({ operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } });
            list.push({ operation: 'kg.generated.amend', resource: { kind: 'knowledge', ids: ['personal'] } });
        }
        if (projectId) {
            const prefixes = paths.split(',').map((part) => part.trim()).filter(Boolean);
            list.push({ operation: 'read', resource: { kind: 'project', ids: [projectId] } });
            if (editFiles) list.push({ operation: 'file.edit', resource: { kind: 'project', ids: [projectId], ...(prefixes.length ? { paths: prefixes } : {}) } });
            if (runCode && canSandbox) list.push({ operation: 'sandbox.run', resource: { kind: 'project', ids: [projectId] } });
        }
        return list;
    }

    async function save(event: React.FormEvent) {
        event.preventDefault();
        const granted = operations();
        if (!title.trim()) return toast('Give it a title.', true);
        if (!granted.length) return toast('Choose at least one thing it may do.', true);
        setSaving(true);
        try {
            await api.createResponsibility({
                title: title.trim(),
                ...(outcome.trim() ? { outcome: outcome.trim() } : {}),
                operations: granted,
                ...(projectId ? { projectId: Number(projectId) } : {}),
                ...(days ? { expiresAt: new Date(Date.now() + Number(days) * 86400_000).toISOString() } : {})
            });
            setTitle('');
            setOutcome('');
            toast('Saved as a draft. Review it below, then activate it.');
            await onCreated();
        } catch (error) { toast((error as Error).message, true); } finally { setSaving(false); }
    }

    return (
        <form className="list-card assistant-draft" onSubmit={save} aria-labelledby="assistant-draft-title" data-testid="responsibility-draft">
            <h2 id="assistant-draft-title">Draft a responsibility</h2>
            <p className="hint">A draft grants nothing. You review exactly what it allows and activate it yourself.</p>
            <label className="field">
                <span>What should be looked after?</span>
                <input type="text" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)}
                    placeholder="Keep the notebook project moving" data-testid="responsibility-title" />
            </label>
            <label className="field">
                <span>What does done or healthy look like? (optional)</span>
                <textarea value={outcome} maxLength={2000} rows={2} onChange={(e) => setOutcome(e.target.value)} />
            </label>
            <fieldset className="field">
                <legend>It may</legend>
                <label><input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} /> Read{canResearch ? ' and research' : ''} on the web</label>
                <label><input type="checkbox" checked={readKnowledge} onChange={(e) => setReadKnowledge(e.target.checked)} /> Read your knowledge</label>
                {canKnowledge && (
                    <label><input type="checkbox" checked={writeNotes} onChange={(e) => setWriteNotes(e.target.checked)} /> Add and amend generated notes (never notes you saved)</label>
                )}
            </fieldset>
            {canProjects && projects.length > 0 && (
                <fieldset className="field">
                    <legend>In a project (optional)</legend>
                    <label>
                        <span className="sr-only">Project</span>
                        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="responsibility-project">
                            <option value="">No project</option>
                            {projects.map((project) => <option key={project.id} value={String(project.id)}>{project.name}</option>)}
                        </select>
                    </label>
                    {projectId && (
                        <>
                            <div className="hint">It may read this project.</div>
                            <label><input type="checkbox" checked={editFiles} onChange={(e) => setEditFiles(e.target.checked)} /> Edit its files</label>
                            {editFiles && (
                                <label className="field">
                                    <span>Only under these folders (comma-separated; empty means the whole project)</span>
                                    <input type="text" value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="docs/, notes/" />
                                </label>
                            )}
                            {canSandbox && <label><input type="checkbox" checked={runCode} onChange={(e) => setRunCode(e.target.checked)} /> Run code in the sandbox</label>}
                        </>
                    )}
                </fieldset>
            )}
            <label className="field">
                <span>Ends</span>
                <select value={days} onChange={(e) => setDays(e.target.value)}>
                    <option value="7">in 7 days</option>
                    <option value="30">in 30 days</option>
                    <option value="90">in 90 days</option>
                    <option value="">when I end it</option>
                </select>
            </label>
            <button type="submit" className="btn primary" disabled={saving} data-testid="responsibility-save">Save draft</button>
        </form>
    );
}

export function AssistantRoom() {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const whenLabel = useDateLabel();
    const queryClient = useQueryClient();
    const enabled = featureActive(me, 'assistant');
    const [busy, setBusy] = useState<number | null>(null);
    const [showArchived, setShowArchived] = useState(false);
    const list = useQuery({ queryKey: keys.responsibilities, queryFn: () => api.responsibilities(), enabled });
    const projectsQ = useQuery({
        queryKey: keys.observatory, queryFn: () => api.observatoryProjects() as Promise<{ projects: Project[] }>,
        enabled: enabled && featureActive(me, 'projects')
    });
    const projects = projectsQ.data?.projects || [];
    const projectById = new Map(projects.map((project) => [String(project.id), project]));

    const refresh = () => Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.responsibilities }),
        queryClient.invalidateQueries({ queryKey: keys.home }),
        queryClient.invalidateQueries({ queryKey: ['inbox'] })
    ]);

    async function act(item: Responsibility, action: string, question?: string) {
        const grants = describeGrants(item.operations, projectById);
        const ask = action === 'activate'
            ? `Activate "${item.title}"? ${me.assistant.name} may then, as you: ${grants.join('; ')}.${item.expiresAt ? ` It ends ${whenLabel(item.expiresAt)}.` : ''} You can pause or revoke it at any time.`
            : question;
        if (ask && !await confirm(ask)) return;
        setBusy(item.id);
        try {
            await api.responsibilityAction(item.id, action, item.revision);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            await refresh();
            setBusy(null);
        }
    }

    const all = list.data?.responsibilities || [];
    const shown = all.filter((item) => showArchived || item.status !== 'ARCHIVED');
    return (
        <main className="pane next-pane is-in" id="pane-assistant">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Responsibilities</h1>
                </div>
                <Link to="/" className="btn subtle">← Home</Link>
            </header>
            <div className="pane-body">
                {!enabled && (
                    <div className="empty-state" data-testid="assistant-unavailable">
                        <div className="empty-title">Delegated work is not turned on here</div>
                        <div className="hint">The host of this installation can turn on the Delegated assistant feature.</div>
                    </div>
                )}
                {enabled && (
                    <>
                        <p className="hint" style={{ maxWidth: 720 }}>
                            A responsibility is a bounded job you hand to {me.assistant.name}: what to look after, exactly what it may do, and until when.
                            Each action is checked against it. Nothing here runs until you activate it, and Attention must be on.
                        </p>
                        {list.isPending && <div className="empty">Loading…</div>}
                        {list.isError && <div className="empty" role="alert">{(list.error as Error).message}</div>}
                        {list.data && shown.length === 0 && <div className="hint" data-testid="responsibilities-empty">Nothing delegated yet.</div>}
                        {shown.length > 0 && (
                            <div className="list-card">
                                {shown.map((item) => (
                                    <div key={item.id} id={`responsibility-${item.id}`} className="list-row task-row" data-testid="responsibility-row">
                                        <div className="row-body">
                                            <strong>{item.title}</strong>{' '}
                                            <span className="badge" data-testid="responsibility-status">{STATUS_TEXT[item.status] || item.status.toLowerCase()}</span>
                                            {item.outcome && <div className="hint">{item.outcome}</div>}
                                            <ul className="assistant-grants">
                                                {describeGrants(item.operations, projectById).map((line) => <li key={line}>May {line}</li>)}
                                            </ul>
                                            <div className="row-meta">
                                                {item.expiresAt ? `Ends ${whenLabel(item.expiresAt)}` : 'No end date'}
                                                {' · '}revision {item.revision}
                                            </div>
                                        </div>
                                        <div className="inbox-actions">
                                            {(ACTIONS[item.status] || []).map((option) => (
                                                <button key={option.action} type="button" disabled={busy === item.id}
                                                    className={`btn${option.primary ? ' primary' : option.danger ? ' danger' : ' subtle'}`}
                                                    onClick={() => void act(item, option.action, option.confirm)}>
                                                    {option.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        {all.some((item) => item.status === 'ARCHIVED') && (
                            <button type="button" className="btn subtle" style={{ marginTop: 10 }} onClick={() => setShowArchived((value) => !value)}>
                                {showArchived ? 'Hide archived' : 'Show archived'}
                            </button>
                        )}
                        <div style={{ marginTop: 22 }}>
                            <Draft projects={projects} onCreated={refresh} />
                        </div>
                    </>
                )}
            </div>
        </main>
    );
}
