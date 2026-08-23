import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { GraphCanvas } from '../components/GraphCanvas';
import { ExpeditionsTab } from '../components/Expeditions';
import { NotesTab } from '../components/NotesTab';
import { NoteEditor } from '../components/NoteEditor';
import { TYPE_COLORS } from '../renderers/graph.js';
import { filterConstellation, withTagLinks } from '../lib/graphFilter';
import { MenuButton } from '../shell/MenuButton';
import type { NoteEvidence, UserNote } from '../lib/types';

type MemoryTab = 'map' | 'notes' | 'expeditions' | 'overview' | 'facts' | 'memories' | 'graph';

type ReportPayload = {
    facts: unknown[];
    memories: { count: number; oldest?: string; newest?: string };
    conversations: { messages: number; count: number };
    followups: Array<{ note: string; dueAt?: string }>;
    applets?: number;
    usageRows: number;
    activityMessages: number;
    economy: { balance: number | null; transactions: number };
    nickname?: string | null;
};

type Fact = { id: number; content: string; source?: string; subjectType?: string; updatedAt?: string };
type Memory = { id: number; content: string; authorName?: string; createdAt?: string };
type GraphNode = {
    id?: string | number;
    type?: string;
    label?: string;
    content?: string;
    salience?: number;
    confidence?: number;
    source?: string;
    tags?: string[];
    cluster?: string | null;
    parentTag?: string | null;
    memberCount?: number;
    childTags?: string[];
    collapsedHub?: boolean;
    memberships?: string[];
    satellite?: boolean;
    ref?: { kind?: string; id?: number };
};
type GraphPayload = {
    nodes: GraphNode[];
    edges: Array<{ sourceId?: string | number; targetId?: string | number }>;
    thoughts?: Array<{ thought: string; createdAt?: string }>;
    scratchpad?: Array<{ content: string }>;
};
type ConstellationPayload = {
    nodes: GraphNode[];
    edges: Array<{ sourceId?: string | number; targetId?: string | number }>;
    counts?: { facts?: number; memories?: number; nodes?: number; cap?: number; truncated?: boolean };
};
type RetentionPayload = { retentionDays?: number; purged?: number };
type ReflectionRun = {
    id: number;
    trigger: string;
    status: 'running' | 'completed' | 'failed';
    passes: string[];
    summary: Record<string, Record<string, number | string>> | null;
    error?: string | null;
    startedAt?: string;
    finishedAt?: string | null;
};
type ReflectionPayload = { run: ReflectionRun | null };

const RETENTION_OPTIONS = [
    { value: 0, label: 'Keep forever' },
    { value: 7, label: 'After 7 days' },
    { value: 30, label: 'After 30 days' },
    { value: 90, label: 'After 90 days' },
    { value: 180, label: 'After 180 days' },
    { value: 365, label: 'After a year' }
];

const TYPE_COLOR_MAP = TYPE_COLORS as Record<string, string>;

function whenLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
    return (
        <div className="stat-card">
            <div className="stat-label">{label}</div>
            <div className="stat-value">{value}</div>
            {sub ? <div className="stat-sub">{sub}</div> : null}
        </div>
    );
}

/**
 * "Why does Goobster believe this?" - the evidence trail behind a real note
 * (Note -> Claim -> Source), shown when the selected Map node has research
 * provenance. Quietly absent for synthetic/guild nodes or notes without one.
 */
function NoteEvidenceView({ nodeId }: { nodeId: number }) {
    const me = useMe();
    const evidence = useQuery({
        queryKey: keys.spitballNoteEvidence(nodeId),
        queryFn: () => api.spitballNoteEvidence(nodeId) as Promise<NoteEvidence>,
        enabled: Boolean(me.features?.spitball),
        retry: false,
        staleTime: 60_000
    });
    const data = evidence.data;
    if (!data || (data.claims.length === 0 && data.expeditions.length === 0)) return null;
    return (
        <div className="gd-evidence">
            <div className="gd-evidence-title">Why Goobster believes this</div>
            {data.claims.slice(0, 4).map((claim) => (
                <div key={claim.id} className="gd-evidence-claim">
                    “{claim.text}”
                    <div className="gd-evidence-source">
                        — {claim.source.url
                            ? <a href={claim.source.url} target="_blank" rel="noreferrer noopener">{claim.source.title || claim.source.url}</a>
                            : (claim.source.title || claim.source.provider)}
                        {` · ${claim.kind.replace(/_/g, ' ')} · ${claim.confidence.toFixed(2)}`}
                    </div>
                </div>
            ))}
            {data.expeditions.length > 0 && (
                <div className="gd-evidence-source">
                    From expedition{data.expeditions.length === 1 ? '' : 's'}: {data.expeditions.map((e) => `“${e.seed}”`).join(', ')}
                </div>
            )}
        </div>
    );
}

function noteFromGraphNode(node: GraphNode): UserNote | null {
    const kgNodeId = node.ref?.kind === 'kg_node' ? node.ref.id : null;
    if (!kgNodeId) return null;
    return {
        id: kgNodeId,
        type: node.type || 'concept',
        label: node.label || '',
        content: node.content || '',
        salience: node.salience,
        confidence: node.confidence,
        source: node.source,
        tags: node.tags || []
    };
}

function NodeDetail({
    node,
    onEdit,
    onDelete
}: {
    node: GraphNode | null;
    onEdit?: (note: UserNote) => void;
    onDelete?: (note: UserNote) => void;
}) {
    if (!node) return null;
    const kgNodeId = node.ref?.kind === 'kg_node' ? node.ref.id : null;
    const editable = noteFromGraphNode(node);
    return (
        <div className="graph-detail">
            <div className="gd-type">
                {node.type}
                {node.source ? ` · ${node.source}` : ''}
                {typeof node.salience === 'number' ? ` · salience ${node.salience.toFixed(2)}` : ''}
            </div>
            <div className="gd-label">{node.label}</div>
            {node.content ? <div className="gd-content">{node.content}</div> : null}
            {node.type === 'tag' && node.parentTag ? (
                <div className="gd-content">Under {node.parentTag}</div>
            ) : null}
            {node.type === 'tag' && node.childTags?.length ? (
                <div className="gd-content">Includes {node.childTags.slice(0, 6).join(', ')}</div>
            ) : null}
            {node.type !== 'tag' && node.cluster ? (
                <div className="gd-content">
                    Grouped with {node.cluster === '__other__' ? 'other' : node.cluster}
                    {node.memberships?.filter((name) => name && name !== node.cluster).length
                        ? ` · also ${node.memberships.filter((name) => name !== node.cluster).slice(0, 4).join(', ')}`
                        : ''}
                </div>
            ) : null}
            {(node.tags || []).length > 0 && (
                <div className="gd-tags">
                    {node.tags?.map((tag) => <span key={tag} className="gchip">{tag}</span>)}
                </div>
            )}
            {kgNodeId ? <NoteEvidenceView nodeId={kgNodeId} /> : null}
            {editable && (onEdit || onDelete) && (
                <div className="gd-actions">
                    {onEdit ? (
                        <button type="button" className="btn small" onClick={() => onEdit(editable)}>Edit</button>
                    ) : null}
                    {onDelete ? (
                        <button type="button" className="btn small danger" onClick={() => onDelete(editable)}>Delete</button>
                    ) : null}
                </div>
            )}
        </div>
    );
}

function GraphFilterBar({
    q, type, tag, source,
    types, tags, sources,
    showing, total, cap, truncated,
    hits,
    linkByTag,
    tagHubs,
    collapsed,
    onQ, onType, onTag, onSource, onPick, onLinkByTag
}: {
    q: string;
    type: string;
    tag: string;
    source: string;
    types: string[];
    tags: string[];
    sources: string[];
    showing: number;
    total: number;
    cap?: number;
    truncated?: boolean;
    hits: GraphNode[];
    linkByTag: boolean;
    tagHubs?: number;
    collapsed?: boolean;
    onQ: (value: string) => void;
    onType: (value: string) => void;
    onTag: (value: string) => void;
    onSource: (value: string) => void;
    onPick: (node: GraphNode) => void;
    onLinkByTag: (value: boolean) => void;
}) {
    return (
        <div className="graph-filter">
            <div className="notes-toolbar graph-filter-row">
                <input
                    className="input"
                    type="search"
                    placeholder="Search the map…"
                    value={q}
                    onChange={(event) => onQ(event.target.value)}
                />
                <select className="select" aria-label="Filter by type" value={type} onChange={(event) => onType(event.target.value)}>
                    <option value="">All types</option>
                    {types.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <select className="select" aria-label="Filter by tag" value={tag} onChange={(event) => onTag(event.target.value)}>
                    <option value="">All tags</option>
                    {tags.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <select className="select" aria-label="Filter by source" value={source} onChange={(event) => onSource(event.target.value)}>
                    <option value="">All sources</option>
                    {sources.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <button
                    type="button"
                    className={`notes-chip${linkByTag ? ' on' : ''}`}
                    aria-pressed={linkByTag}
                    title="Group notes into a few tag clusters (child tags fold into their parent). Turn off for a flat note-only map."
                    onClick={() => onLinkByTag(!linkByTag)}
                >
                    Group by tag
                </button>
            </div>
            <div className="hint">
                Showing {showing} of {total} notes
                {tagHubs ? ` · ${tagHubs} ${collapsed ? (tagHubs === 1 ? 'group' : 'groups') : (tagHubs === 1 ? 'tag' : 'tags')}` : ''}
                {cap ? ` · cap ${cap}` : ''}
                {truncated ? ' · storage cap reached' : ''}
            </div>
            {q.trim() && hits.length > 0 && (
                <div className="graph-hits">
                    {hits.slice(0, 8).map((node) => (
                        <button
                            key={String(node.id)}
                            type="button"
                            className="tag-chip"
                            onClick={() => onPick(node)}
                        >
                            {node.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Sum a numeric field across every pass summary in a run. */
function reflectionTotal(run: ReflectionRun, field: string): number {
    let total = 0;
    for (const pass of Object.values(run.summary || {})) {
        const value = pass?.[field];
        if (typeof value === 'number') total += value;
    }
    return total;
}

function describeReflection(run: ReflectionRun): string {
    const parts: string[] = [];
    const distilled = reflectionTotal(run, 'memoriesDistilled');
    const notes = reflectionTotal(run, 'nodesUpserted');
    const links = reflectionTotal(run, 'linksCreated');
    const merged = reflectionTotal(run, 'nodesMerged');
    const pruned = reflectionTotal(run, 'nodesPruned') + reflectionTotal(run, 'edgesPruned');
    if (distilled > 0) parts.push(`${distilled} memories distilled`);
    if (notes > 0) parts.push(`${notes} note${notes === 1 ? '' : 's'} updated`);
    if (links > 0) parts.push(`${links} connection${links === 1 ? '' : 's'} woven`);
    if (merged > 0) parts.push(`${merged} merged`);
    if (pruned > 0) parts.push(`${pruned} pruned`);
    return parts.length > 0 ? parts.join(' · ') : 'nothing new — the graph is already tidy';
}

/**
 * The Reflect button: kicks off a knowledge-enrichment run for this scope
 * (distill memories, weave semantic relationships, tidy), then polls the run
 * until it settles and refreshes the graph views.
 */
function ReflectControl({ scope, target }: { scope: string; target: 'personal' | 'guild' }) {
    const toast = useToast();
    const queryClient = useQueryClient();
    // Watch the specific run started by this button press (a plain boolean
    // would fire against the previous, already-completed run still cached
    // in the query at click time).
    const [watchedRunId, setWatchedRunId] = useState<number | null>(null);
    const queryKey = keys.memory(scope, `reflection-${target}`);
    const reflection = useQuery({
        queryKey,
        queryFn: () => api.reflection(scope, target) as Promise<ReflectionPayload>,
        enabled: Boolean(scope),
        refetchInterval: (query) => (
            query.state.data?.run?.status === 'running' || watchedRunId !== null ? 2000 : false
        )
    });
    const run = reflection.data?.run || null;
    const running = run?.status === 'running' || (watchedRunId !== null && run?.id !== watchedRunId);

    useEffect(() => {
        if (watchedRunId === null || !run || run.id !== watchedRunId || run.status === 'running') return;
        setWatchedRunId(null);
        if (run.status === 'completed') {
            toast(`Reflection complete — ${describeReflection(run)}.`);
        } else {
            toast(run.error || 'Reflection failed.', true);
        }
        for (const tab of ['map', 'graph', 'facts', 'memories']) {
            queryClient.invalidateQueries({ queryKey: keys.memory(scope, tab) });
        }
        queryClient.invalidateQueries({ queryKey: keys.spitballNotesRoot(scope) });
    }, [watchedRunId, run, scope, toast, queryClient]);

    return (
        <span className="key reflect-control">
            <button
                type="button"
                className="btn small"
                disabled={running || !scope}
                title="Distill fresh memories and weave semantic relationships in this graph"
                onClick={async () => {
                    try {
                        const started = await api.startReflection(scope, target) as ReflectionPayload;
                        if (started.run) setWatchedRunId(started.run.id);
                        queryClient.invalidateQueries({ queryKey });
                    } catch (error) {
                        toast((error as Error).message, true);
                    }
                }}
            >
                {running ? 'Reflecting…' : '✦ Reflect'}
            </button>
            {!running && run?.status === 'completed' && run.finishedAt
                ? <span className="hint">last reflected {whenLabel(run.finishedAt)}</span>
                : null}
        </span>
    );
}

function RetentionCard({ scope, onChanged }: { scope: string; onChanged: () => void }) {
    const toast = useToast();
    const confirm = useConfirm();
    const retention = useQuery({
        queryKey: keys.memory(scope, 'retention'),
        queryFn: () => api.retention(scope) as Promise<RetentionPayload>,
        retry: false
    });
    if (retention.isError || !retention.data) return null;
    const days = retention.data.retentionDays ?? 0;
    const options = [...RETENTION_OPTIONS];
    if (days && !options.some((o) => o.value === days)) {
        options.push({ value: days, label: `After ${days} days` });
        options.sort((a, b) => (a.value || Infinity) - (b.value || Infinity));
    }
    return (
        <>
            <div className="section-title">Memory retention</div>
            <div className="list-card retention-card">
                <div className="list-row">
                    <div className="row-body">
                        <strong>Auto-delete memories</strong>
                        <div className="row-meta">
                            Raw memories from your DMs and web chats older than this window are
                            deleted automatically (immediately, then nightly). Distilled facts are separate — manage them in the Facts tab.
                        </div>
                    </div>
                    <select
                        className="select retention-select"
                        aria-label="Memory auto-delete window"
                        defaultValue={String(days)}
                        onChange={async (event) => {
                            const chosen = Number(event.target.value);
                            if (chosen > 0 && !await confirm(
                                `Auto-delete memories older than ${chosen} days? Anything already past that window is deleted right now.`
                            )) {
                                event.target.value = String(days);
                                return;
                            }
                            try {
                                const result = await api.setRetention(scope, chosen) as RetentionPayload;
                                toast(result.retentionDays
                                    ? `Memories now expire after ${result.retentionDays} days${result.purged ? ` — ${result.purged} deleted now` : ''}.`
                                    : 'Memories are kept forever again.');
                                onChanged();
                            } catch (error) {
                                toast((error as Error).message, true);
                                event.target.value = String(days);
                            }
                        }}
                    >
                        {options.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                </div>
            </div>
        </>
    );
}

export function SpitballRoom() {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const scopes = me.scopes || [];
    const [scopeId, setScopeId] = useState(scopes[0]?.id || '');
    const [tab, setTab] = useState<MemoryTab>('map');
    const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
    const [selectId, setSelectId] = useState<string | number | null>(null);
    const [editorNote, setEditorNote] = useState<UserNote | null>(null);
    const [mapQ, setMapQ] = useState('');
    const [mapType, setMapType] = useState('');
    const [mapTag, setMapTag] = useState('');
    const [mapSource, setMapSource] = useState('');
    const [graphQ, setGraphQ] = useState('');
    const [graphType, setGraphType] = useState('');
    const [graphTag, setGraphTag] = useState('');
    const [graphSource, setGraphSource] = useState('');
    const [linkByTag, setLinkByTag] = useState(() => {
        try { return window.localStorage.getItem('goobster.map.linkByTag') !== '0'; }
        catch { return true; }
    });

    function changeLinkByTag(next: boolean) {
        setLinkByTag(next);
        try { window.localStorage.setItem('goobster.map.linkByTag', next ? '1' : '0'); }
        catch { /* private mode */ }
    }
    const scope = scopes.find((s) => s.id === scopeId) || scopes[0] || null;
    const graphAvailable = Boolean(scope?.graphAvailable);

    const onSelectNode = useCallback((node: unknown) => {
        setSelectedNode(node as GraphNode | null);
    }, []);

    const report = useQuery({
        queryKey: keys.memory(scopeId, 'overview'),
        queryFn: () => api.report(scopeId) as Promise<ReportPayload>,
        enabled: tab === 'overview' && Boolean(scopeId)
    });
    const facts = useQuery({
        queryKey: keys.memory(scopeId, 'facts'),
        queryFn: () => api.facts(scopeId) as Promise<{ facts: Fact[] }>,
        enabled: tab === 'facts' && Boolean(scopeId)
    });
    const memories = useQuery({
        queryKey: keys.memory(scopeId, 'memories'),
        queryFn: () => api.memories(scopeId) as Promise<{ memories: Memory[] }>,
        enabled: tab === 'memories' && Boolean(scopeId)
    });
    const constellation = useQuery({
        queryKey: keys.memory(scopeId, 'map'),
        queryFn: () => api.constellation(scopeId) as Promise<ConstellationPayload>,
        enabled: tab === 'map' && Boolean(scopeId)
    });
    const graph = useQuery({
        queryKey: keys.memory(scopeId, 'graph'),
        queryFn: () => api.graph(scopeId) as Promise<GraphPayload>,
        enabled: tab === 'graph' && graphAvailable && Boolean(scopeId)
    });

    function changeTab(next: MemoryTab) {
        if (next === 'graph' && !graphAvailable) return;
        setSelectedNode(null);
        setSelectId(null);
        setTab(next);
    }

    function changeScope(id: string) {
        setScopeId(id);
        setSelectedNode(null);
        setSelectId(null);
        setEditorNote(null);
        const next = scopes.find((s) => s.id === id);
        if (tab === 'graph' && !next?.graphAvailable) setTab('map');
    }

    function invalidateGraphNotes() {
        queryClient.invalidateQueries({ queryKey: keys.memory(scopeId, 'map') });
        queryClient.invalidateQueries({ queryKey: keys.memory(scopeId, 'graph') });
        queryClient.invalidateQueries({ queryKey: keys.memory(scopeId, 'facts') });
        queryClient.invalidateQueries({ queryKey: keys.spitballNotesRoot(scopeId) });
    }

    const mapFiltered = withTagLinks(filterConstellation(constellation.data, {
        q: mapQ, type: mapType, tag: mapTag, source: mapSource
    }), linkByTag);
    const graphFiltered = withTagLinks(filterConstellation(graph.data, {
        q: graphQ, type: graphType, tag: graphTag, source: graphSource
    }), linkByTag);
    const mapHits = (mapFiltered.nodes || []).filter((node) => node.id !== 'you' && node.label);
    const mapTypes = [...new Set((constellation.data?.nodes || []).map((n) => n.type).filter(Boolean))] as string[];
    const mapTags = [...new Set((constellation.data?.nodes || []).flatMap((n) => n.tags || []))];
    const mapSources = [...new Set((constellation.data?.nodes || []).map((n) => n.source).filter(Boolean))] as string[];
    const graphTypes = [...new Set((graph.data?.nodes || []).map((n) => n.type).filter(Boolean))] as string[];
    const graphTags = [...new Set((graph.data?.nodes || []).flatMap((n) => n.tags || []))];
    const graphSources = [...new Set((graph.data?.nodes || []).map((n) => n.source).filter(Boolean))] as string[];

    const graphTab = tab === 'map' || tab === 'graph';

    return (
        <main className="pane next-pane is-in" id="pane-library">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Spitball</h1>
                </div>
                <select className="select" value={scopeId} onChange={(e) => changeScope(e.target.value)} aria-label="Scope">
                    {scopes.map((item) => (
                        <option key={item.id} value={item.id}>
                            {item.kind === 'dm' ? `🔒 ${item.name}` : item.name}
                        </option>
                    ))}
                </select>
            </header>
            <div className={`pane-body${graphTab ? ' pane-body-graph' : ''}`}>
                <div className="segment" role="tablist">
                    {([
                        ['map', 'Map'],
                        ['notes', 'Notes'],
                        ...(me.features?.spitball ? [['expeditions', 'Expeditions'] as const] : []),
                        ['overview', 'About you'],
                        ['facts', 'Facts'],
                        ['memories', 'Memories'],
                        ...(graphAvailable ? [['graph', 'Server graph'] as const] : [])
                    ] as Array<[MemoryTab, string]>).map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            className={`segment-btn${tab === id ? ' active' : ''}`}
                            onClick={() => changeTab(id)}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {tab === 'map' && (
                    <div className="mtab mtab-graph">
                        {constellation.isPending && <div className="empty">Loading…</div>}
                        {constellation.isError && <div className="empty">{(constellation.error as Error).message}</div>}
                        {constellation.data && (
                            <>
                                <div className="hint usage-legend">
                                    <span className="key"><span className="dot" style={{ background: '#54c2ff' }} />you</span>
                                    <span className="key"><span className="dot" style={{ background: '#59d18c' }} />facts</span>
                                    <span className="key"><span className="dot" style={{ background: '#ff7ac8' }} />memories</span>
                                    {linkByTag ? (
                                        <span className="key"><span className="dot" style={{ background: TYPE_COLOR_MAP.tag || '#a78bfa' }} />tags</span>
                                    ) : null}
                                    <span className="key">
                                        {(constellation.data.counts?.nodes || constellation.data.counts?.facts || 0)} notes
                                        {(constellation.data.counts?.memories || 0) > 0
                                            ? ` · ${constellation.data.counts?.memories} memories`
                                            : ''}
                                    </span>
                                    <ReflectControl scope={scopeId} target="personal" />
                                </div>
                                <GraphFilterBar
                                    q={mapQ}
                                    type={mapType}
                                    tag={mapTag}
                                    source={mapSource}
                                    types={mapTypes}
                                    tags={mapTags}
                                    sources={mapSources}
                                    showing={Math.max(0, mapFiltered.nodes.filter((n) => n.id !== 'you' && n.type !== 'tag').length)}
                                    total={constellation.data.counts?.nodes || Math.max(0, (constellation.data.nodes?.length || 1) - 1)}
                                    cap={constellation.data.counts?.cap}
                                    truncated={constellation.data.counts?.truncated}
                                    tagHubs={mapFiltered.nodes.filter((n) => n.type === 'tag').length}
                                    collapsed={mapFiltered.collapsed}
                                    hits={mapHits}
                                    linkByTag={linkByTag}
                                    onQ={setMapQ}
                                    onType={setMapType}
                                    onTag={setMapTag}
                                    onSource={setMapSource}
                                    onLinkByTag={changeLinkByTag}
                                    onPick={(node) => {
                                        setSelectedNode(node);
                                        setSelectId(node.id ?? null);
                                    }}
                                />
                                <div className="graph-wrap">
                                    <GraphCanvas data={mapFiltered} onSelect={onSelectNode} selectId={selectId} />
                                    {(constellation.data.nodes?.length || 0) <= 1 && (
                                        <div className="empty">Not enough to map yet — talk in the Study.</div>
                                    )}
                                    <NodeDetail
                                        node={selectedNode}
                                        onEdit={setEditorNote}
                                        onDelete={async (note) => {
                                            if (!await confirm(`Delete “${note.label}”? This removes it from the map too.`)) return;
                                            try {
                                                await api.spitballDeleteNote(scopeId, note.id);
                                                toast('Note deleted.');
                                                setSelectedNode(null);
                                                invalidateGraphNotes();
                                            } catch (error) {
                                                toast((error as Error).message, true);
                                            }
                                        }}
                                    />
                                </div>
                            </>
                        )}
                    </div>
                )}

                {tab === 'notes' && <NotesTab scope={scopeId} />}

                {tab === 'expeditions' && me.features?.spitball && <ExpeditionsTab />}

                {tab === 'overview' && (
                    <div className="mtab">
                        {report.isPending && <div className="empty">Loading…</div>}
                        {report.isError && <div className="empty">{(report.error as Error).message}</div>}
                        {report.data && (
                            <>
                                <div className="stat-grid privacy-cards">
                                    <Stat label="Facts about you" value={report.data.facts.length} />
                                    <Stat
                                        label="Memories"
                                        value={report.data.memories.count}
                                        sub={report.data.memories.count > 0
                                            ? `${whenLabel(report.data.memories.oldest)} → ${whenLabel(report.data.memories.newest)}`
                                            : 'nothing stored'}
                                    />
                                    <Stat
                                        label="Chat messages"
                                        value={report.data.conversations.messages}
                                        sub={`${report.data.conversations.count} conversation${report.data.conversations.count === 1 ? '' : 's'} (bot-wide)`}
                                    />
                                    <Stat label="Pending follow-ups" value={report.data.followups.length} />
                                    <Stat label="Pinned applets" value={report.data.applets || 0} />
                                    <Stat label="AI calls" value={report.data.usageRows} />
                                    <Stat label="Messages counted" value={report.data.activityMessages} sub="activity counters, no content" />
                                    {report.data.economy.balance !== null && (
                                        <Stat label="Wallet" value={report.data.economy.balance} sub={`${report.data.economy.transactions} ledger entries`} />
                                    )}
                                    {report.data.nickname ? <Stat label="Nickname" value={report.data.nickname} /> : null}
                                </div>
                                <div className="privacy-stage">
                                    <p className="hint">
                                        This is the same data <code>/what-do-you-know-about-me</code> reports in Discord.
                                        Delete individual facts and memories on their tabs, or erase everything here.
                                    </p>
                                    <button
                                        type="button"
                                        className="btn danger"
                                        onClick={() => window.dispatchEvent(new CustomEvent('goobster-forget'))}
                                    >
                                        Forget me — watch it disappear
                                    </button>
                                </div>
                                {report.data.followups.length > 0 && (
                                    <>
                                        <div className="section-title">Pending follow-ups</div>
                                        <div className="list-card">
                                            {report.data.followups.map((followup) => (
                                                <div key={`${followup.note}-${followup.dueAt || ''}`} className="list-row">
                                                    <div className="row-body">
                                                        {followup.note}
                                                        <div className="row-meta">due {followup.dueAt} UTC</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                )}
                                {scope?.kind === 'dm' && (
                                    <RetentionCard
                                        scope={scopeId}
                                        onChanged={() => queryClient.invalidateQueries({ queryKey: keys.memory(scopeId, 'overview') })}
                                    />
                                )}
                            </>
                        )}
                    </div>
                )}

                {tab === 'facts' && (
                    <div className="mtab">
                        {facts.isPending && <div className="empty">Loading…</div>}
                        {facts.isError && <div className="empty">{(facts.error as Error).message}</div>}
                        {facts.data && facts.data.facts.length === 0 && <div className="empty">No distilled facts here yet.</div>}
                        {facts.data && facts.data.facts.length > 0 && (
                            <>
                                <div className="hint" style={{ marginBottom: 10 }}>
                                    Distilled facts Goobster keeps about {scope?.kind === 'dm' ? 'your DMs' : 'you in this server'} — separate from raw memories.
                                </div>
                                <div className="list-card">
                                    {facts.data.facts.map((fact) => (
                                        <div key={fact.id} className="list-row">
                                            <div className="row-body">
                                                <span className="badge">{fact.subjectType === 'GUILD' ? 'shared' : 'you'}</span>
                                                {fact.content}
                                                <div className="row-meta">{fact.source} · {whenLabel(fact.updatedAt)}</div>
                                            </div>
                                            <button
                                                type="button"
                                                className="row-delete"
                                                title="Forget this fact"
                                                onClick={async () => {
                                                    if (!await confirm('Forget this fact? Goobster will no longer know it.')) return;
                                                    try {
                                                        await api.deleteFact(scopeId, fact.id);
                                                        toast('Fact forgotten.');
                                                        queryClient.invalidateQueries({ queryKey: keys.memory(scopeId, 'facts') });
                                                    } catch (error) {
                                                        toast((error as Error).message, true);
                                                    }
                                                }}
                                            >✕</button>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {tab === 'memories' && (
                    <div className="mtab">
                        {memories.isPending && <div className="empty">Loading…</div>}
                        {memories.isError && <div className="empty">{(memories.error as Error).message}</div>}
                        {memories.data && memories.data.memories.length === 0 && <div className="empty">No stored memories here.</div>}
                        {memories.data && memories.data.memories.length > 0 && (
                            <>
                                <div className="hint" style={{ marginBottom: 10 }}>
                                    {scope?.kind === 'dm'
                                        ? 'Everything remembered from your DMs and web chat (both sides of the conversation).'
                                        : 'Memories you authored in this server. Other members’ memories are theirs to manage.'}
                                </div>
                                <div className="list-card">
                                    {memories.data.memories.map((memory) => (
                                        <div key={memory.id} className="list-row">
                                            <div className="row-body">
                                                {memory.content}
                                                <div className="row-meta">{memory.authorName || 'unknown'} · {whenLabel(memory.createdAt)}</div>
                                            </div>
                                            <button
                                                type="button"
                                                className="row-delete"
                                                title="Delete this memory"
                                                onClick={async () => {
                                                    if (!await confirm('Delete this memory? It cannot be recalled afterwards.')) return;
                                                    try {
                                                        await api.deleteMemory(scopeId, memory.id);
                                                        toast('Memory deleted.');
                                                        queryClient.invalidateQueries({ queryKey: keys.memory(scopeId, 'memories') });
                                                    } catch (error) {
                                                        toast((error as Error).message, true);
                                                    }
                                                }}
                                            >✕</button>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}
                    </div>
                )}

                {tab === 'graph' && graphAvailable && (
                    <div className="mtab mtab-graph">
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
                                    q={graphQ}
                                    type={graphType}
                                    tag={graphTag}
                                    source={graphSource}
                                    types={graphTypes}
                                    tags={graphTags}
                                    sources={graphSources}
                                    showing={graphFiltered.nodes.filter((n) => n.type !== 'tag').length}
                                    total={graph.data.nodes?.length || 0}
                                    tagHubs={graphFiltered.nodes.filter((n) => n.type === 'tag').length}
                                    collapsed={graphFiltered.collapsed}
                                    hits={(graphFiltered.nodes || []).filter((node) => node.label)}
                                    onQ={setGraphQ}
                                    onType={setGraphType}
                                    onTag={setGraphTag}
                                    onSource={setGraphSource}
                                    linkByTag={linkByTag}
                                    onLinkByTag={changeLinkByTag}
                                    onPick={(node) => {
                                        setSelectedNode(node);
                                        setSelectId(node.id ?? null);
                                    }}
                                />
                                <div className="graph-wrap">
                                    <GraphCanvas data={graphFiltered} onSelect={onSelectNode} selectId={selectId} />
                                    {(graph.data.nodes?.length || 0) === 0 && (
                                        <div className="empty">This server graph is empty.</div>
                                    )}
                                    <NodeDetail node={selectedNode} />
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
                )}
            </div>
            {editorNote && (
                <NoteEditor
                    scope={scopeId}
                    note={editorNote}
                    onClose={() => setEditorNote(null)}
                    onSaved={() => {
                        setEditorNote(null);
                        setSelectedNode(null);
                        invalidateGraphNotes();
                    }}
                />
            )}
        </main>
    );
}
