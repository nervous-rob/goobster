import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import { GraphCanvas } from '../../components/GraphCanvas';
import type { Expedition } from '../../lib/types';

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
    const queryClient = useQueryClient();
    const [selected, setSelected] = useState<GraphNode | null>(null);
    const [seed, setSeed] = useState('');

    const graphQ = useQuery({
        queryKey: keys.projectKnowledge(slug, ownerId),
        queryFn: () => api.projectKnowledge(slug, ownerId) as Promise<KnowledgePayload>
    });
    const notesQ = useQuery({
        queryKey: keys.projectKnowledgeNotes(slug, ownerId),
        queryFn: () => api.projectKnowledgeNotes(slug, ownerId) as Promise<{ notes: NoteRow[] }>
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

    const graph = graphQ.data;
    const notes = notesQ.data?.notes || [];
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
            {notesQ.isPending && <div className="empty">Loading notes…</div>}
            {notesQ.isError && <div className="empty">{(notesQ.error as Error).message}</div>}
            {notes.length === 0 && notesQ.data && (
                <div className="empty">No notes in this project’s graph yet.</div>
            )}
            {notes.length > 0 && (
                <div className="list-card">
                    {notes.map((note) => (
                        <div key={note.id} className="list-row">
                            <div className="row-body">
                                <strong>{note.label}</strong>
                                {note.content ? <div className="row-meta">{note.content}</div> : null}
                                <div className="row-meta">
                                    {note.type}
                                    {(note.tags || []).length ? ` · ${(note.tags || []).join(', ')}` : ''}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
