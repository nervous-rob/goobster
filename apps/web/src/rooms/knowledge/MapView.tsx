import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { GraphCanvas } from '../../components/GraphCanvas';
import { MapSlicers, type SlicerSelection } from '../../components/MapSlicers';
import { NoteEditor } from '../../components/NoteEditor';
import { DeleteNoteDialog } from '../../components/DeleteNoteDialog';
import { TYPE_COLORS } from '../../renderers/graph.js';
import { facetCounts, filterConstellation, withTagLinks } from '../../lib/graphFilter';
import type { CurationView, UserNote } from '../../lib/types';
import {
    GraphFilterBar,
    NodeDetail,
    ReflectControl,
    whenLabel,
    type ConstellationPayload,
    type GraphNode,
    type GraphPayload
} from './graphParts';
import { useKnowledgeScope } from './scope';

const TYPE_COLOR_MAP = TYPE_COLORS as Record<string, string>;
const EMPTY_SLICERS: SlicerSelection = { types: [], tags: [], sources: [] };

type MapMode = 'personal' | 'server';

function useLinkByTag(): [boolean, (next: boolean) => void] {
    const [linkByTag, setLinkByTag] = useState(() => {
        try { return window.localStorage.getItem('goobster.map.linkByTag') !== '0'; }
        catch { return true; }
    });
    const change = useCallback((next: boolean) => {
        setLinkByTag(next);
        try { window.localStorage.setItem('goobster.map.linkByTag', next ? '1' : '0'); }
        catch { /* private mode */ }
    }, []);
    return [linkByTag, change];
}

/**
 * Knowledge → Map: your notes as a graph. Typed connections are edges,
 * shared tags are hubs (Group by tag) - two different relationships, kept
 * distinct. The projection toggle mirrors Notes: the same server-side
 * predicate decides which rows exist here. For a server scope the graph
 * that server keeps for itself is an explicitly labelled advanced mode,
 * never mixed into your personal map.
 */
export function MapView() {
    const { scopeId, scope } = useKnowledgeScope();
    const graphAvailable = Boolean(scope?.graphAvailable) && scope?.kind === 'guild';
    const [mode, setMode] = useState<MapMode>('personal');
    const [view, setView] = useState<CurationView>('knowledge');
    const [linkByTag, changeLinkByTag] = useLinkByTag();

    // Leaving a server scope (or losing its graph) drops back to the personal map.
    useEffect(() => {
        if (!graphAvailable && mode === 'server') setMode('personal');
    }, [graphAvailable, mode]);

    return (
        <div className="pane-body pane-body-graph" data-tour="knowledge-map">
            {graphAvailable && (
                <div className="notes-chips map-mode" role="group" aria-label="Which graph to show">
                    <button
                        type="button"
                        className={`notes-chip${mode === 'personal' ? ' on' : ''}`}
                        aria-pressed={mode === 'personal'}
                        onClick={() => setMode('personal')}
                    >
                        Your notes in {scope?.name}
                    </button>
                    <button
                        type="button"
                        className={`notes-chip${mode === 'server' ? ' on' : ''}`}
                        aria-pressed={mode === 'server'}
                        title="Advanced: the shared graph this server keeps for itself - not your personal notes"
                        onClick={() => setMode('server')}
                    >
                        {scope?.name}’s shared graph <span className="notes-chip-count">advanced</span>
                    </button>
                </div>
            )}
            {mode === 'server' && graphAvailable
                ? <ServerGraph scopeId={scopeId} scopeName={scope?.name || 'this server'} linkByTag={linkByTag} onLinkByTag={changeLinkByTag} />
                : <PersonalMap scopeId={scopeId} view={view} onView={setView} linkByTag={linkByTag} onLinkByTag={changeLinkByTag} />}
        </div>
    );
}

function PersonalMap({
    scopeId, view, onView, linkByTag, onLinkByTag
}: {
    scopeId: string;
    view: CurationView;
    onView: (view: CurationView) => void;
    linkByTag: boolean;
    onLinkByTag: (next: boolean) => void;
}) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
    const [deleting, setDeleting] = useState<UserNote | null>(null);
    const [selectId, setSelectId] = useState<string | number | null>(null);
    const [editorNote, setEditorNote] = useState<UserNote | null>(null);
    const [q, setQ] = useState('');
    const [slicers, setSlicers] = useState<SlicerSelection>(EMPTY_SLICERS);

    const constellation = useQuery({
        queryKey: keys.constellation(scopeId, view),
        queryFn: () => api.constellation(scopeId, view) as Promise<ConstellationPayload>,
        enabled: Boolean(scopeId)
    });

    const onSelectNode = useCallback((node: unknown) => {
        setSelectedNode(node as GraphNode | null);
    }, []);

    function invalidate() {
        queryClient.invalidateQueries({ queryKey: keys.constellationRoot(scopeId) });
        queryClient.invalidateQueries({ queryKey: keys.memory(scopeId, 'graph') });
        queryClient.invalidateQueries({ queryKey: keys.memory(scopeId, 'facts') });
        queryClient.invalidateQueries({ queryKey: keys.memory(scopeId, 'overview') });
        queryClient.invalidateQueries({ queryKey: keys.spitballNotesRoot(scopeId) });
    }

    function changeView(next: CurationView) {
        if (next === view) return;
        setSelectedNode(null);
        setSelectId(null);
        onView(next);
    }

    const filter = { q, types: slicers.types, tags: slicers.tags, sources: slicers.sources };
    const filtered = withTagLinks(filterConstellation(constellation.data, filter), linkByTag);
    const hits = (filtered.nodes || []).filter((node) => node.id !== 'you' && node.type !== 'tag' && node.label);
    const facets = facetCounts(constellation.data, filter);
    const counts = constellation.data?.counts;
    const curation = counts?.curation;
    const knowledgeTotal = curation ? curation.saved + curation.unclassified : null;
    const everything = curation ? curation.saved + curation.memory + curation.unclassified : null;

    return (
        <div className="mtab mtab-graph">
            <div className="notes-chips map-projection" role="group" aria-label="Which notes to map" data-tour="knowledge-map-projection">
                <button
                    type="button"
                    className={`notes-chip${view === 'knowledge' ? ' on' : ''}`}
                    aria-pressed={view === 'knowledge'}
                    title="What you kept, plus notes nothing has sorted yet"
                    onClick={() => changeView('knowledge')}
                >
                    Your notes
                    {knowledgeTotal !== null && <span className="notes-chip-count">{knowledgeTotal}</span>}
                </button>
                <button
                    type="button"
                    className={`notes-chip${view === 'all' ? ' on' : ''}`}
                    aria-pressed={view === 'all'}
                    title="Every row kept in this scope, including what Goobster distilled from conversation"
                    onClick={() => changeView('all')}
                >
                    All retained knowledge
                    {everything !== null && <span className="notes-chip-count">{everything}</span>}
                </button>
                {view === 'knowledge' && (counts?.hidden || 0) > 0 && (
                    <span className="hint">{counts?.hidden} distilled {counts?.hidden === 1 ? 'note' : 'notes'} not mapped here</span>
                )}
            </div>
            {constellation.isPending && <div className="empty">Loading…</div>}
            {constellation.isError && <div className="empty">{(constellation.error as Error).message}</div>}
            {constellation.data && (
                <>
                    <div className="hint usage-legend">
                        <span className="key"><span className="dot" style={{ background: '#54c2ff' }} />you</span>
                        <span className="key"><span className="dot" style={{ background: '#59d18c' }} />notes</span>
                        {linkByTag ? (
                            <span className="key"><span className="dot" style={{ background: TYPE_COLOR_MAP.tag || '#a78bfa' }} />tags</span>
                        ) : null}
                        <span className="key" data-tour="knowledge-map-count">
                            {counts?.nodes || 0} notes
                            {curation ? ` · ${curation.saved} kept · ${curation.memory} memory · ${curation.unclassified} unsorted` : ''}
                            {(counts?.memories || 0) > 0 ? ` · ${counts?.memories} raw memories` : ''}
                        </span>
                        <ReflectControl scope={scopeId} target="personal" />
                    </div>
                    <GraphFilterBar
                        q={q}
                        showing={Math.max(0, filtered.nodes.filter((n) => n.id !== 'you' && n.type !== 'tag').length)}
                        total={counts?.nodes || Math.max(0, (constellation.data.nodes?.length || 1) - 1)}
                        cap={counts?.cap}
                        truncated={counts?.truncated}
                        tagHubs={filtered.nodes.filter((n) => n.type === 'tag').length}
                        collapsed={filtered.collapsed}
                        hits={hits}
                        linkByTag={linkByTag}
                        onQ={setQ}
                        onLinkByTag={onLinkByTag}
                        onPick={(node) => {
                            setSelectedNode(node);
                            setSelectId(node.id ?? null);
                        }}
                    />
                    <div className="graph-stage">
                        <div className="graph-wrap">
                            <GraphCanvas data={filtered} onSelect={onSelectNode} selectId={selectId} />
                            {(constellation.data.nodes?.length || 0) <= 1 && (
                                <div className="empty">Not enough to map yet — write a note, or talk in Chat.</div>
                            )}
                            <NodeDetail
                                node={selectedNode}
                                onEdit={setEditorNote}
                                onKeep={async (note) => {
                                    try {
                                        await api.spitballSetNoteCuration(scopeId, note.id, 'saved');
                                        toast(`“${note.label}” kept with your knowledge.`);
                                        setSelectedNode({ ...selectedNode, curation: 'saved' });
                                        invalidate();
                                    } catch (error) {
                                        toast((error as Error).message, true);
                                    }
                                }}
                                onDelete={(note) => setDeleting(note)}
                            />
                        </div>
                        <MapSlicers facets={facets} selected={slicers} onChange={setSlicers} />
                    </div>
                </>
            )}
            {editorNote && (
                <NoteEditor
                    scope={scopeId}
                    note={editorNote}
                    onClose={() => setEditorNote(null)}
                    onSaved={() => {
                        setEditorNote(null);
                        setSelectedNode(null);
                        invalidate();
                    }}
                />
            )}
            {deleting && (
                <DeleteNoteDialog
                    scope={scopeId}
                    note={deleting}
                    onClose={() => setDeleting(null)}
                    onDeleted={() => {
                        setDeleting(null);
                        setSelectedNode(null);
                        invalidate();
                    }}
                />
            )}
        </div>
    );
}

/**
 * Advanced: the graph a server keeps for itself (its own notes, private
 * thoughts and scratch pad). Read-only here, labelled with the server's
 * name so it is never mistaken for a personal page.
 */
function ServerGraph({
    scopeId, scopeName, linkByTag, onLinkByTag
}: {
    scopeId: string;
    scopeName: string;
    linkByTag: boolean;
    onLinkByTag: (next: boolean) => void;
}) {
    const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
    const [selectId, setSelectId] = useState<string | number | null>(null);
    const [q, setQ] = useState('');
    const [slicers, setSlicers] = useState<SlicerSelection>(EMPTY_SLICERS);
    const graph = useQuery({
        queryKey: keys.memory(scopeId, 'graph'),
        queryFn: () => api.graph(scopeId) as Promise<GraphPayload>,
        enabled: Boolean(scopeId)
    });
    const onSelectNode = useCallback((node: unknown) => {
        setSelectedNode(node as GraphNode | null);
    }, []);
    const filter = { q, types: slicers.types, tags: slicers.tags, sources: slicers.sources };
    const filtered = withTagLinks(filterConstellation(graph.data, filter), linkByTag);
    const facets = facetCounts(graph.data, filter);

    return (
        <div className="mtab mtab-graph" data-tour="knowledge-server-graph">
            <div className="hint" style={{ marginBottom: 0 }}>
                <strong>{scopeName}’s shared graph.</strong> What this server has collected for everyone in it - separate from your notes and from what Goobster knows about you.
            </div>
            {graph.isPending && <div className="empty">Loading…</div>}
            {graph.isError && <div className="empty">{(graph.error as Error).message}</div>}
            {graph.data && (
                <>
                    <div className="hint usage-legend">
                        {Object.entries(TYPE_COLOR_MAP).map(([type, color]) => (
                            <span key={type} className="key">
                                <span className="dot" style={{ background: color }} />{type}
                            </span>
                        ))}
                        <ReflectControl scope={scopeId} target="guild" />
                    </div>
                    <GraphFilterBar
                        q={q}
                        showing={filtered.nodes.filter((n) => n.type !== 'tag').length}
                        total={graph.data.nodes?.length || 0}
                        tagHubs={filtered.nodes.filter((n) => n.type === 'tag').length}
                        collapsed={filtered.collapsed}
                        hits={(filtered.nodes || []).filter((node) => node.label && node.type !== 'tag')}
                        onQ={setQ}
                        linkByTag={linkByTag}
                        onLinkByTag={onLinkByTag}
                        onPick={(node) => {
                            setSelectedNode(node);
                            setSelectId(node.id ?? null);
                        }}
                    />
                    <div className="graph-stage">
                        <div className="graph-wrap">
                            <GraphCanvas data={filtered} onSelect={onSelectNode} selectId={selectId} />
                            {(graph.data.nodes?.length || 0) === 0 && (
                                <div className="empty">This server graph is empty.</div>
                            )}
                            <NodeDetail node={selectedNode} />
                        </div>
                        <MapSlicers facets={facets} selected={slicers} onChange={setSlicers} />
                    </div>
                    {(graph.data.thoughts || graph.data.scratchpad) && (
                        <div className="inner-life">
                            <div className="inner-card">
                                <div className="inner-title">Recent private thoughts</div>
                                {graph.data.thoughts?.length
                                    ? (
                                        <ul>
                                            {graph.data.thoughts.map((thought) => (
                                                <li key={`${thought.thought}-${thought.createdAt || ''}`}>
                                                    {thought.thought} <span className="when">{whenLabel(thought.createdAt)}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )
                                    : <div className="hint">Nothing yet.</div>}
                            </div>
                            <div className="inner-card">
                                <div className="inner-title">Scratch pad</div>
                                {graph.data.scratchpad?.length
                                    ? (
                                        <ul>
                                            {graph.data.scratchpad.map((note, index) => (
                                                <li key={`${note.content}-${index}`}>{note.content}</li>
                                            ))}
                                        </ul>
                                    )
                                    : <div className="hint">Empty.</div>}
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
