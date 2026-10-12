import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { api, type MoveChatResult } from '../lib/api';
import { keys } from '../lib/query';
import { projectPath } from '../lib/rooms';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { describeAudience } from './TransferNoteModal';
import type { ProjectAudience } from '../lib/types';
import type { Project } from '../rooms/projects/types';

/**
 * Move a private chat into a project (ADR 0010: explicit, no model call).
 * The transcript becomes a new conversation in the project - every
 * collaborator reads it - and the chat's working files land in the
 * project's scratch/ folder. The dialog names the readers before anything
 * moves; the private chat is deleted afterwards unless kept.
 */
export function MoveChatModal({
    conversationId,
    title,
    onClose,
    onMoved
}: {
    conversationId: number;
    title: string;
    onClose: () => void;
    /** The move finished; `keptOriginal` false means the private chat is gone. */
    onMoved?: (result: MoveChatResult) => void;
}) {
    const me = useMe();
    const toast = useToast();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [projectKey, setProjectKey] = useState('');
    const [keepOriginal, setKeepOriginal] = useState(false);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<MoveChatResult | null>(null);
    // Retain the receipt key per destination so a lost response retries safely.
    const requests = useRef(new Map<string, string>());

    const projectsQ = useQuery({
        queryKey: keys.observatory,
        queryFn: () => api.observatoryProjects() as Promise<{ projects: Project[] }>,
        retry: false
    });
    const projects = projectsQ.data?.projects || [];
    const project = useMemo(
        () => projects.find((item) => `${item.ownerId || me.user.id}:${item.slug}` === projectKey) || null,
        [projects, projectKey, me.user.id]
    );
    const audienceQ = useQuery({
        queryKey: keys.projectAudience(project?.slug || '', project?.ownerId),
        queryFn: () => api.projectAudience(project?.slug || '', project?.ownerId) as Promise<ProjectAudience>,
        enabled: Boolean(project),
        retry: false
    });
    const audienceReady = audienceQ.isSuccess && !audienceQ.isFetching && Boolean(audienceQ.data);

    async function submit() {
        if (!project || !audienceReady) return;
        setBusy(true);
        try {
            const key = `${projectKey}:${keepOriginal ? 'keep' : 'move'}`;
            let requestId = requests.current.get(key);
            if (!requestId) {
                requestId = globalThis.crypto?.randomUUID?.() || `move_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                requests.current.set(key, requestId);
            }
            const result = await api.moveChatToProject(project.slug, project.ownerId || null, {
                conversationId, keepOriginal, requestId
            });
            await queryClient.invalidateQueries({ queryKey: keys.conversations });
            await queryClient.invalidateQueries({ queryKey: keys.parlorConversations });
            await queryClient.invalidateQueries({ queryKey: ['project-conversations', result.project.slug] });
            setDone(result);
            onMoved?.(result);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(false);
        }
    }

    if (done) {
        const to = projectPath({ owner: done.project.ownerId, slug: done.project.slug }, 'conversation');
        return (
            <Modal onClose={onClose} className="transfer-modal">
                <h2>Moved to {done.project.name}</h2>
                <p className="hint" data-testid="move-chat-done">
                    “{done.conversation.title || title}” is now a conversation in the project. Readers: {describeAudience(done.audience, me.user.id)}.
                    {done.files.folder ? ` Its working files are in ${done.files.folder}.` : ''}
                    {done.keptOriginal ? ' Your private chat is still here.' : ' The private chat was removed.'}
                </p>
                <div className="modal-actions">
                    <button type="button" className="btn" onClick={onClose}>Done</button>
                    <button
                        type="button"
                        className="btn primary"
                        data-testid="move-chat-open"
                        onClick={() => {
                            onClose();
                            void navigate({ to: to as never, search: { conversation: done.conversation.id } as never });
                        }}
                    >
                        Open in project
                    </button>
                </div>
            </Modal>
        );
    }

    return (
        <Modal onClose={onClose} className="transfer-modal">
            <h2>Move to project…</h2>
            <p className="hint">
                The whole chat becomes a conversation in the project, and the files Goobster made while you
                worked go into the project’s scratch folder. Nothing is sent to a model.
            </p>
            {projectsQ.isError && <div className="hint">{(projectsQ.error as Error).message}</div>}
            {!projectsQ.isPending && projects.length === 0 && (
                <div className="hint">No projects yet — create one under Projects first.</div>
            )}
            <div className="field">
                <label htmlFor="move-chat-project">Project</label>
                <select
                    id="move-chat-project"
                    className="select"
                    data-testid="move-chat-project"
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
                <div className="transfer-audience" data-testid="move-chat-audience">
                    <strong>Who will read this chat:</strong>{' '}
                    {audienceQ.isError ? (
                        <span role="alert">
                            Could not check the audience.{' '}
                            <button type="button" className="btn" onClick={() => void audienceQ.refetch()}>Retry</button>
                        </span>
                    ) : !audienceReady ? 'checking…' : describeAudience(audienceQ.data, me.user.id)}
                </div>
            )}
            <div className="field">
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={keepOriginal}
                        data-testid="move-chat-keep"
                        onChange={(e) => setKeepOriginal(e.target.checked)}
                    />
                    {' '}Keep my private copy of this chat
                </label>
            </div>
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn primary"
                    data-testid="move-chat-submit"
                    disabled={busy || !project || !audienceReady}
                    onClick={() => void submit()}
                >
                    {busy ? 'Moving…' : 'Move chat'}
                </button>
            </div>
        </Modal>
    );
}
