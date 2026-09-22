import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { GraphCanvas } from '../../components/GraphCanvas';
import { describeAudience } from '../../components/TransferNoteModal';
import type { Expedition, TransferAudience } from '../../lib/types';

type GraphNode = {
    id?: string | number;
    type?: string;
    label?: string;
    content?: string;
    source?: string;
    tags?: string[];
};

type KnowledgePayload = {
    project?: { id: number; slug: string; name: string };
    nodes?: GraphNode[];
    edges?: Array<{ sourceId?: string | number; targetId?: string | number }>;
    tags?: Array<{ id: number; name: string; noteCount?: number }>;
    counts?: { nodes?: number; edges?: number };
};

type NoteRow = {
    id: number;
    type: string;
    label: string;
    content: string;
    source?: string;
    tags?: string[];
    updatedAt?: string;
    /** Set on a published copy (ADR 0010): who put it here and from which note. */
    publishedBy?: string;
    publishedFrom?: string | null;
    publishedAt?: string;
    canRemove?: boolean;
    /** Set on the caller's own private reference, resolved at read time. */
    reference?: { transferId: number; userId: string; referencedAt: string };
};

type NotesPayload = {
    notes: NoteRow[];
    references: NoteRow[];
    audience: TransferAudience;
    role: 'owner' | 'collaborator';
};

export function KnowledgeTab({
    slug,
    ownerId,
    projectId
}: {
    slug: string;
    ownerId?: string | null;
    projectId?: number | null;
}) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<GraphNode | null>(null);
    const [seed, setSeed] = useState('');

    const graphQ = useQuery({
        queryKey: keys.projectKnowledge(slug, ownerId),
        queryFn: () => api.projectKnowledge(slug, ownerId) as Promise<KnowledgePayload>
    });
    const notesQ = useQuery({
        queryKey: keys.projectKnowledgeNotes(slug, ownerId),
        queryFn: () => api.projectKnowledgeNotes(slug, ownerId) as Promise<NotesPayload>
    });
    const expeditionsQ = useQuery({
        queryKey: [...keys.spitball, 'project', projectId || slug],
        queryFn: () => api.spitballExpeditions(projectId) as Promise<{ expeditions: Expedition[] }>,
        enabled: Boolean(me.features?.spitball && projectId)
    });

    const launch = useMutation({
        mutationFn: () => api.spitballCreateExpedition({
            seed: seed.trim(),
            depth: 'focused',
            projectId
        }) as Promise<Expedition>,
        onSuccess: () => {
            toast('Expedition started into this project.');
            setSeed('');
            queryClient.invalidateQueries({ queryKey: keys.spitball });
            queryClient.invalidateQueries({ queryKey: keys.projectKnowledge(slug, ownerId) });
        },
        onError: (error) => toast((error as Error).message, true)
    });

    const removeCopy = useMutation({
        mutationFn: (note: NoteRow) => api.deleteProjectKnowledgeNote(slug, note.id, ownerId),
        onSuccess: (_result, note) => {
            toast(`Removed “${note.label}” from this project. The publisher's original note is untouched.`);
            queryClient.invalidateQueries({ queryKey: keys.projectKnowledgeNotes(slug, ownerId) });
            queryClient.invalidateQueries({ queryKey: keys.projectKnowledge(slug, ownerId) });
        },
        onError: (error) => toast((error as Error).message, true)
    });
    const dropReference = useMutation({
        mutationFn: (note: NoteRow) => api.removeNoteReference(note.reference?.transferId as number),
        onSuccess: (_result, note) => {
            toast(`“${note.label}” is no longer referenced here. Your note itself is untouched.`);
            queryClient.invalidateQueries({ queryKey: keys.projectKnowledgeNotes(slug, ownerId) });
            queryClient.invalidateQueries({ queryKey: keys.noteTransfers(note.id) });
        },
        onError: (error) => toast((error as Error).message, true)
    });

    const graph = graphQ.data;
    const notes = notesQ.data?.notes || [];
    const references = notesQ.data?.references || [];
    const audience = notesQ.data?.audience || null;
    const tags = graph?.tags || [];
    const expeditions = expeditionsQ.data?.expeditions || [];

    return (
        <div className="obs-knowledge">
            {me.features?.spitball && projectId ? (
                <div className="obs-knowledge-launch">
                    <div className="section-title">Research into this project</div>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <input
                            className="input"
                            placeholder="Topic for a focused expedition"
                            value={seed}
                            maxLength={200}
                            onChange={(e) => setSeed(e.target.value)}
                        />
                        <button
                            type="button"
                            className="btn primary"
                            disabled={launch.isPending || seed.trim().length === 0}
                            onClick={() => launch.mutate()}
                        >
                            {launch.isPending ? 'Starting…' : 'Start expedition'}
                        </button>
                    </div>
                    {expeditions.length > 0 && (
                        <div className="row-meta">
                            {expeditions.length} expedition{expeditions.length === 1 ? '' : 's'} targeting this project
                            {expeditions[0] ? ` · latest “${expeditions[0].seed}”` : ''}
                        </div>
                    )}
                </div>
            ) : null}

            <div className="section-title">Map</div>
            {graphQ.isPending && <div className="empty">Loading project knowledge…</div>}
            {graphQ.isError && <div className="empty">{(graphQ.error as Error).message}</div>}
            {graph && (
                <div className="graph-wrap">
                    <GraphCanvas
                        data={graph}
                        onSelect={(node) => setSelected(node as GraphNode | null)}
                    />
                    {(graph.nodes?.length || 0) === 0 && (
                        <div className="empty">No project knowledge yet — note it in chat or launch an expedition.</div>
                    )}
                    {selected && (
                        <div className="graph-detail">
                            <div className="gd-type">{selected.type}{selected.source ? ` · ${selected.source}` : ''}</div>
                            <div className="gd-label">{selected.label}</div>
                            {selected.content ? <div className="gd-content">{selected.content}</div> : null}
                            {(selected.tags || []).length > 0 && (
                                <div className="gd-tags">
                                    {selected.tags?.map((tag) => <span key={tag} className="gchip">{tag}</span>)}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {tags.length > 0 && (
                <div className="gd-tags" style={{ marginTop: 12 }}>
                    {tags.map((tag) => (
                        <span key={tag.id} className="gchip">{tag.name}{tag.noteCount ? ` · ${tag.noteCount}` : ''}</span>
                    ))}
                </div>
            )}

            <div className="section-title">Notes</div>
            {audience && (
                <div className="hint" data-testid="project-knowledge-audience">
                    Readers of this project’s knowledge: {describeAudience(audience, me.user.id)}.
                    {' '}Add your own notes here from Knowledge → Notes → Add to project…
                </div>
            )}
            {notesQ.isPending && <div className="empty">Loading notes…</div>}
            {notesQ.isError && <div className="empty">{(notesQ.error as Error).message}</div>}
            {notes.length === 0 && notesQ.data && (
                <div className="empty">No notes in this project’s graph yet.</div>
            )}
            {notes.length > 0 && (
                <div className="list-card" data-testid="project-knowledge-notes">
                    {notes.map((note) => (
                        <div key={note.id} className="list-row" data-testid={`project-note-${note.id}`}>
                            <div className="row-body">
                                <strong>{note.label}</strong>
                                {note.publishedBy ? (
                                    <span className="badge" title={note.publishedFrom ? `Published from “${note.publishedFrom}”` : 'A published copy'}>
                                        copy · {note.publishedBy === me.user.id ? 'published by you' : `published by ${note.publishedBy}`}
                                    </span>
                                ) : null}
                                {note.content ? <div className="row-meta">{note.content}</div> : null}
                                <div className="row-meta">
                                    {note.type}
                                    {(note.tags || []).length ? ` · ${(note.tags || []).join(', ')}` : ''}
                                </div>
                            </div>
                            {note.canRemove ? (
                                <button
                                    type="button"
                                    className="row-delete"
                                    title="Remove this copy from the project (the original note is untouched)"
                                    aria-label={`Remove ${note.label} from this project`}
                                    disabled={removeCopy.isPending}
                                    onClick={async () => {
                                        if (!await confirm(`Remove the copy of “${note.label}” from this project? Whoever published it keeps their original note.`)) return;
                                        removeCopy.mutate(note);
                                    }}
                                >
                                    ✕
                                </button>
                            ) : null}
                        </div>
                    ))}
                </div>
            )}

            {references.length > 0 && (
                <>
                    <div className="section-title">Referenced from your private notes</div>
                    <div className="hint">
                        Only you can see these here (ADR 0010): the project reads them as you, and they stay
                        in your own space. Publish a copy from Knowledge → Notes if others should read them.
                    </div>
                    <div className="list-card" data-testid="project-knowledge-references">
                        {references.map((note) => (
                            <div key={note.id} className="list-row" data-testid={`project-reference-${note.id}`}>
                                <div className="row-body">
                                    <strong>{note.label}</strong>
                                    <span className="badge">reference · only you</span>
                                    {note.content ? <div className="row-meta">{note.content}</div> : null}
                                    <div className="row-meta">
                                        {note.type}
                                        {(note.tags || []).length ? ` · ${(note.tags || []).join(', ')}` : ''}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    className="row-delete"
                                    title="Stop referencing this note here (the note itself stays)"
                                    aria-label={`Stop referencing ${note.label} here`}
                                    disabled={dropReference.isPending}
                                    onClick={() => dropReference.mutate(note)}
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
