import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import type { Curation, CurationCounts, NoteEvidence, UserNote } from '../../lib/types';

/** A node as the Map and the Server graph payloads shape it. */
export type GraphNode = {
    id?: string | number;
    type?: string;
    label?: string;
    content?: string;
    salience?: number;
    confidence?: number;
    source?: string;
    curation?: Curation;
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

export type GraphEdge = { sourceId?: string | number; targetId?: string | number };

export type GraphPayload = {
    nodes: GraphNode[];
    edges: GraphEdge[];
    thoughts?: Array<{ thought: string; createdAt?: string }>;
    scratchpad?: Array<{ content: string }>;
};

export type ConstellationPayload = {
    view?: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    counts?: {
        facts?: number;
        memories?: number;
        nodes?: number;
        cap?: number;
        truncated?: boolean;
        curation?: CurationCounts;
        hidden?: number;
    };
};

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

export function whenLabel(iso?: string | null): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Plain-language labels for the curation states (ADR 0008). */
export const CURATION_LABEL: Record<Curation, string> = {
    saved: 'kept',
    memory: 'memory',
    unclassified: 'unsorted'
};

export const CURATION_TITLE: Record<Curation, string> = {
    saved: 'You chose to keep this as knowledge.',
    memory: 'Goobster distilled this from conversation - it is what he knows about you, managed from Personal memory.',
    unclassified: 'Written before notes were sorted, or by a tool that did not say. Keep it to file it with your knowledge.'
};

export function CurationBadge({ curation }: { curation?: Curation | null }) {
    const value: Curation = curation || 'unclassified';
    return (
        <span className={`badge curation-badge curation-${value}`} title={CURATION_TITLE[value]}>
            {CURATION_LABEL[value]}
        </span>
    );
}

/**
 * "Why does Goobster believe this?" - the evidence trail behind a real note
 * (Note -> Claim -> Source), shown when the selected Map node has research
 * provenance. Quietly absent for synthetic/guild nodes or notes without one.
 */
export function NoteEvidenceView({ nodeId }: { nodeId: number }) {
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

export function noteFromGraphNode(node: GraphNode): UserNote | null {
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
        curation: node.curation,
        tags: node.tags || []
    };
}

export function NodeDetail({
    node,
    onEdit,
    onDelete,
    onKeep
}: {
    node: GraphNode | null;
    onEdit?: (note: UserNote) => void;
    onDelete?: (note: UserNote) => void;
    onKeep?: (note: UserNote) => void;
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
                {editable ? <> · <CurationBadge curation={node.curation} /></> : null}
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
            {editable && (onEdit || onDelete || onKeep) && (
                <div className="gd-actions">
                    {onKeep && editable.curation !== 'saved' ? (
                        <button type="button" className="btn small" onClick={() => onKeep(editable)} title="File this with your saved knowledge">Keep</button>
                    ) : null}
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

export function GraphFilterBar({
    q,
    showing, total, cap, truncated,
    hits,
    linkByTag,
    tagHubs,
    collapsed,
    onQ, onPick, onLinkByTag
}: {
    q: string;
    showing: number;
    total: number;
    cap?: number;
    truncated?: boolean;
    hits: GraphNode[];
    linkByTag: boolean;
    tagHubs?: number;
    collapsed?: boolean;
    onQ: (value: string) => void;
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
                <button
                    type="button"
                    className={`notes-chip${linkByTag ? ' on' : ''}`}
                    aria-pressed={linkByTag}
                    title="Park notes in one tag group each. Turn off for a flat note-only map."
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
export function ReflectControl({ scope, target }: { scope: string; target: 'personal' | 'guild' }) {
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
        for (const tab of ['graph', 'facts', 'memories', 'overview']) {
            queryClient.invalidateQueries({ queryKey: keys.memory(scope, tab) });
        }
        queryClient.invalidateQueries({ queryKey: keys.constellationRoot(scope) });
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
