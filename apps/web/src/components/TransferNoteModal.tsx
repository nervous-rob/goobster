import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { projectPath } from '../lib/rooms';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import type {
    AddToProjectResult, ProjectAudience, TransferAudience, TransferMode, UseInDiscussionResult, UserNote
} from '../lib/types';
import type { Project } from '../rooms/projects/types';

type Discussion = {
    id: number;
    title: string | null;
    ownerId: string;
    ownerName?: string | null;
    role: 'owner' | 'member';
    projectId?: number | null;
    members?: Array<{ userId: string; userName?: string | null }>;
};

export type TransferTarget = 'project' | 'discussion';

type Done =
    | { kind: 'project'; result: AddToProjectResult }
    | { kind: 'discussion'; result: UseInDiscussionResult };

function excerpt(text: string | null | undefined, max = 360): string {
    const body = String(text || '').trim();
    if (!body) return '';
    return body.length > max ? `${body.slice(0, max - 1)}…` : body;
}

/** "you and Sam", "you, Sam and 2 others", "anyone with the share link". */
export function describeAudience(audience: TransferAudience | null | undefined, meId: string): string {
    if (!audience) return '';
    const others = (audience.members || []).filter((m) => m.userId !== meId);
    const ownerIsMe = audience.ownerId === meId;
    const names: string[] = [];
    if (!ownerIsMe) names.push(audience.ownerName || `the owner (${audience.ownerId})`);
    for (const member of others) names.push(member.userName || member.userId);
    const people = ['you', ...names];
    let text: string;
    if (people.length === 1) text = 'only you';
    else if (people.length <= 4) text = `${people.slice(0, -1).join(', ')} and ${people[people.length - 1]}`;
    else text = `${people.slice(0, 3).join(', ')} and ${people.length - 3} others`;
    if (audience.shared) text += ', plus anyone holding the project share link';
    return text;
}

/**
 * Add to project / Use in discussion (ADR 0010). Every hop is a button on
 * a note the person already picked; nothing here routes through a model.
 * The picker lists projects the caller can see, owner-qualified (two
 * owners may share a slug), and discussions they belong to. Before a copy
 * is published the dialog shows exactly what will be shared and who reads
 * it; a reference is only offered for a private project the caller owns.
 */
export function TransferNoteModal({
    note,
    initialTarget = 'project',
    onClose,
    onTransferred
}: {
    note: UserNote;
    initialTarget?: TransferTarget;
    onClose: () => void;
    onTransferred?: (done: Done) => void;
}) {
    const me = useMe();
    const toast = useToast();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const projectsOn = me.features?.projects !== false;
    const [target, setTarget] = useState<TransferTarget>(projectsOn ? initialTarget : 'discussion');
    const [projectKey, setProjectKey] = useState('');
    const [mode, setMode] = useState<TransferMode>('copy');
    const [discussionId, setDiscussionId] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<Done | null>(null);

    const projectsQ = useQuery({
        queryKey: keys.observatory,
        queryFn: () => api.observatoryProjects() as Promise<{ projects: Project[] }>,
        enabled: projectsOn,
        retry: false
    });
    const discussionsQ = useQuery({
        queryKey: keys.parlorConversations,
        queryFn: () => api.parlorConversations() as Promise<{ conversations: Discussion[] }>,
        retry: false
    });
    const projects = projectsQ.data?.projects || [];
    const discussions = discussionsQ.data?.conversations || [];
    const project = useMemo(
        () => projects.find((item) => `${item.ownerId || ''}:${item.slug}` === projectKey) || null,
        [projects, projectKey]
    );
    const discussion = useMemo(
        () => discussions.find((item) => String(item.id) === discussionId) || null,
        [discussions, discussionId]
    );
    const audienceQ = useQuery({
        queryKey: keys.projectAudience(project?.slug || '', project?.ownerId),
        queryFn: () => api.projectAudience(project?.slug || '', project?.ownerId) as Promise<ProjectAudience>,
        enabled: Boolean(project),
        retry: false
    });
    const audience = audienceQ.data || null;
    const canReference = Boolean(project?.private && project?.role !== 'collaborator' && (audience ? audience.private : true));

    // A shared project cannot hold a private reference (ADR 0010 §3).
    useEffect(() => {
        if (!canReference && mode === 'reference') setMode('copy');
    }, [canReference, mode]);

    const discussionAudience: TransferAudience | null = discussion
        ? {
            kind: 'discussion',
            ownerId: discussion.ownerId,
            ownerName: discussion.ownerName || null,
            members: (discussion.members || []).map((m) => ({ userId: m.userId, userName: m.userName || null })),
            memberIds: [discussion.ownerId, ...(discussion.members || []).map((m) => m.userId)],
            shared: false,
            private: (discussion.members || []).length === 0
        }
        : null;

    async function submit() {
        setBusy(true);
        try {
            if (target === 'project') {
                if (!project) { toast('Pick a project first.', true); return; }
                const result = await api.addNoteToProject(note.id, {
                    project: project.slug,
                    owner: project.ownerId || null,
                    mode
                }) as AddToProjectResult;
                await queryClient.invalidateQueries({ queryKey: keys.projectKnowledgeNotes(project.slug, project.ownerId) });
                await queryClient.invalidateQueries({ queryKey: keys.projectKnowledge(project.slug, project.ownerId) });
                await queryClient.invalidateQueries({ queryKey: keys.noteTransfers(note.id) });
                const next: Done = { kind: 'project', result };
                setDone(next);
                onTransferred?.(next);
            } else {
                if (!discussion) { toast('Pick a discussion first.', true); return; }
                const result = await api.useNoteInDiscussion(note.id, discussion.id) as UseInDiscussionResult;
                await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
                await queryClient.invalidateQueries({ queryKey: ['parlor-messages', discussion.id] });
                await queryClient.invalidateQueries({ queryKey: keys.noteTransfers(note.id) });
                const next: Done = { kind: 'discussion', result };
                setDone(next);
                onTransferred?.(next);
            }
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(false);
        }
    }

    if (done?.kind === 'project') {
        const { result } = done;
        const to = projectPath({ owner: result.project.ownerId, slug: result.project.slug }, 'knowledge');
        return (
            <Modal onClose={onClose} className="transfer-modal">
                <h2>{result.mode === 'reference' ? 'Referenced in' : 'Published to'} {result.project.name}</h2>
                <p className="hint" data-testid="transfer-done">
                    {result.mode === 'reference'
                        ? 'The note stays in your private space; the project reads it as you, and only you can see it there. If the project is shared later, the reference stays yours.'
                        : `A copy of “${note.label}” now lives in the project’s knowledge. Readers: ${describeAudience(result.audience, me.user.id)}. Your original is untouched.`}
                </p>
                <div className="modal-actions">
                    <button type="button" className="btn" onClick={onClose}>Done</button>
                    <button
                        type="button"
                        className="btn primary"
                        data-testid="transfer-open-project"
                        onClick={() => { onClose(); void navigate({ to: to as never }); }}
                    >
                        Open project
                    </button>
                </div>
            </Modal>
        );
    }
    if (done?.kind === 'discussion') {
        const { result } = done;
        return (
            <Modal onClose={onClose} className="transfer-modal">
                <h2>Posted to {result.discussion.title || 'the discussion'}</h2>
                <p className="hint" data-testid="transfer-done">
                    The note is now a message from you in that transcript. Readers: {describeAudience(result.audience, me.user.id)}.
                    Every persona at the table reads it on their next turn.
                </p>
                <div className="modal-actions">
                    <button type="button" className="btn" onClick={onClose}>Done</button>
                    <button
                        type="button"
                        className="btn primary"
                        onClick={() => {
                            onClose();
                            void navigate({ to: '/discussions/$conversationId' as never, params: { conversationId: String(result.discussion.id) } as never });
                        }}
                    >
                        Open discussion
                    </button>
                </div>
            </Modal>
        );
    }

    const body = excerpt(note.content);
    return (
        <Modal onClose={onClose} className="transfer-modal">
            <h2>{target === 'project' ? 'Add to project…' : 'Use in discussion…'}</h2>
            <p className="hint">
                Moves a note you kept into shared work. Nothing is sent to a model; this is a plain copy or reference.
            </p>
            <div className="field">
                <label>Where</label>
                <div className="segment" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        className={`segment-btn${target === 'project' ? ' active' : ''}`}
                        aria-selected={target === 'project'}
                        disabled={!projectsOn}
                        title={projectsOn ? undefined : 'Projects are off on this host.'}
                        onClick={() => setTarget('project')}
                    >
                        A project
                    </button>
                    <button
                        type="button"
                        role="tab"
                        className={`segment-btn${target === 'discussion' ? ' active' : ''}`}
                        aria-selected={target === 'discussion'}
                        onClick={() => setTarget('discussion')}
                    >
                        A discussion
                    </button>
                </div>
            </div>

            {target === 'project' && (
                <>
                    {projectsQ.isError && <div className="hint">{(projectsQ.error as Error).message}</div>}
                    {!projectsQ.isPending && projects.length === 0 && (
                        <div className="hint">No projects yet — create one under Projects first.</div>
                    )}
                    <div className="field">
                        <label htmlFor="transfer-project">Project</label>
                        <select
                            id="transfer-project"
                            className="select"
                            data-testid="transfer-project"
                            value={projectKey}
                            onChange={(e) => setProjectKey(e.target.value)}
                        >
                            <option value="">Select a project…</option>
                            {projects.map((item) => {
                                const owner = item.ownerId || me.user.id;
                                const who = item.role === 'collaborator'
                                    ? ` · ${item.ownerName || item.ownerId}'s`
                                    : (item.private ? ' · private' : ' · shared');
                                return (
                                    <option key={`${owner}:${item.slug}`} value={`${owner}:${item.slug}`}>
                                        {item.name} ({item.slug}{who})
                                    </option>
                                );
                            })}
                        </select>
                    </div>
                    {project && (
                        <div className="field">
                            <label>How</label>
                            <div className="transfer-modes" role="radiogroup">
                                <label className={`transfer-mode${!canReference ? ' disabled' : ''}`}>
                                    <input
                                        type="radio"
                                        name="transfer-mode"
                                        value="reference"
                                        checked={mode === 'reference'}
                                        disabled={!canReference}
                                        onChange={() => setMode('reference')}
                                    />
                                    <span>
                                        <strong>Reference</strong>
                                        <span className="hint">
                                            {canReference
                                                ? 'The project reads your note as you. Only you see it there; if the project is shared later, the reference stays private.'
                                                : 'Only for a private project you own — this one has other readers, so a reference would be invisible to them.'}
                                        </span>
                                    </span>
                                </label>
                                <label className="transfer-mode">
                                    <input
                                        type="radio"
                                        name="transfer-mode"
                                        value="copy"
                                        checked={mode === 'copy'}
                                        onChange={() => setMode('copy')}
                                    />
                                    <span>
                                        <strong>Publish a copy</strong>
                                        <span className="hint">
                                            A snapshot goes into the project’s knowledge. Everyone on the project can read it; your original stays yours.
                                        </span>
                                    </span>
                                </label>
                            </div>
                        </div>
                    )}
                    {project && mode === 'copy' && (
                        <div className="transfer-audience" data-testid="transfer-audience">
                            <strong>Who will read this:</strong>{' '}
                            {audienceQ.isPending ? 'checking…' : describeAudience(audience, me.user.id)}
                        </div>
                    )}
                </>
            )}

            {target === 'discussion' && (
                <>
                    {discussionsQ.isError && <div className="hint">{(discussionsQ.error as Error).message}</div>}
                    {!discussionsQ.isPending && discussions.length === 0 && (
                        <div className="hint">No discussions yet — start one under Discussions first.</div>
                    )}
                    <div className="field">
                        <label htmlFor="transfer-discussion">Discussion</label>
                        <select
                            id="transfer-discussion"
                            className="select"
                            data-testid="transfer-discussion"
                            value={discussionId}
                            onChange={(e) => setDiscussionId(e.target.value)}
                        >
                            <option value="">Select a discussion…</option>
                            {discussions.map((item) => (
                                <option key={item.id} value={String(item.id)}>
                                    {item.title || `Discussion #${item.id}`}{item.role === 'member' ? ` · ${item.ownerName || item.ownerId}'s` : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                    {discussion && (
                        <div className="transfer-audience" data-testid="transfer-audience">
                            <strong>Who will read this:</strong> {describeAudience(discussionAudience, me.user.id)}.
                            {' '}It is posted as a message from you; the personas at the table read it on their next turn.
                        </div>
                    )}
                </>
            )}

            {(target === 'discussion' || mode === 'copy') && (
                <div className="field">
                    <label>What will be shared</label>
                    <div className="transfer-preview" data-testid="transfer-preview">
                        <strong>{note.label}</strong>
                        {body ? <div className="transfer-preview-body">{body}</div> : null}
                        {note.tags?.length ? <div className="hint">Tags: {note.tags.join(', ')}</div> : null}
                    </div>
                </div>
            )}

            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn primary"
                    data-testid="transfer-submit"
                    disabled={busy || (target === 'project' ? !project : !discussion)}
                    onClick={() => void submit()}
                >
                    {busy
                        ? 'Working…'
                        : target === 'discussion'
                            ? 'Post to discussion'
                            : mode === 'reference' ? 'Reference in project' : 'Publish copy'}
                </button>
            </div>
        </Modal>
    );
}
