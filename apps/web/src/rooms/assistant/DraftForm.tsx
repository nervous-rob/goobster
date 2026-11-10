import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { featureActive } from '../../lib/rooms';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import type { Interruption, ResponsibilityOperation } from '../../lib/types';
import { INTERRUPTION_CHOICE, type Project } from './grants';

/** Drafts a responsibility from plain choices. A draft grants nothing. */
export function DraftForm({ projects, onCreated }: { projects: Project[]; onCreated: () => Promise<unknown> }) {
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
    const [autoStart, setAutoStart] = useState(false);
    const [deepResearch, setDeepResearch] = useState(false);
    const [interruption, setInterruption] = useState<Interruption>('home');
    const [saving, setSaving] = useState(false);
    // Reaching you outside the portal is a pilot capability: the choice is
    // offered only to an account that has it (the server checks again).
    const access = useQuery({ queryKey: keys.assistantAccess, queryFn: () => api.assistantAccess(), retry: false });
    const canDeliver = access.data?.capabilities?.delivery === true;
    const canProjects = featureActive(me, 'projects');
    const canSandbox = featureActive(me, 'sandbox');
    const canResearch = featureActive(me, 'expeditions');
    const canKnowledge = featureActive(me, 'knowledge');

    function operations(): ResponsibilityOperation[] {
        const list: ResponsibilityOperation[] = [];
        if (web) list.push({ operation: 'read', resource: { kind: 'web' } });
        if (readKnowledge) list.push({ operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } });
        if (writeNotes && canKnowledge) {
            list.push({ operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } });
            list.push({ operation: 'kg.generated.amend', resource: { kind: 'knowledge', ids: ['personal'] } });
        }
        // A research expedition searches and writes generated notes: it is
        // offered only together with both of those choices.
        if (deepResearch && web && writeNotes && canResearch && canKnowledge && !list.some((entry) => entry.operation === 'research')) {
            list.push({ operation: 'research', resource: { kind: 'web' } });
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
                ...(days ? { expiresAt: new Date(Date.now() + Number(days) * 86400_000).toISOString() } : {}),
                ...(autoStart || (canDeliver && interruption !== 'home') ? {
                    rules: {
                        ...(autoStart ? { autoStart: true } : {}),
                        ...(canDeliver && interruption !== 'home' ? { interruption } : {})
                    }
                } : {})
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
                <label><input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} /> Search and read the web</label>
                <label><input type="checkbox" checked={readKnowledge} onChange={(e) => setReadKnowledge(e.target.checked)} /> Read your knowledge</label>
                {canKnowledge && (
                    <label><input type="checkbox" checked={writeNotes} onChange={(e) => setWriteNotes(e.target.checked)} /> Add and amend generated notes (never notes you saved)</label>
                )}
                {canResearch && canKnowledge && web && writeNotes && (
                    <label><input type="checkbox" checked={deepResearch} onChange={(e) => setDeepResearch(e.target.checked)} /> Run a research expedition when a few searches are not enough (one per piece of work)</label>
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
            <label>
                <input type="checkbox" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} data-testid="responsibility-autostart" />{' '}
                Start proposed work automatically (otherwise each piece waits for you to press Start). It stays within the daily budgets.
            </label>
            {canDeliver && (
                <label className="field">
                    <span>How should its updates reach you?</span>
                    <select value={interruption} onChange={(e) => setInterruption(e.target.value as Interruption)} data-testid="responsibility-interruption">
                        {(Object.keys(INTERRUPTION_CHOICE) as Interruption[]).map((mode) => (
                            <option key={mode} value={mode}>{INTERRUPTION_CHOICE[mode]}</option>
                        ))}
                    </select>
                    <span className="hint">
                        Everything is always on Home and in your Inbox. A digest or a contact also sends a browser notification or a Discord message,
                        within your Attention limits (quiet hours, contacts per day, time between contacts).
                    </span>
                </label>
            )}
            <button type="submit" className="btn primary" disabled={saving} data-testid="responsibility-save">Save draft</button>
        </form>
    );
}
