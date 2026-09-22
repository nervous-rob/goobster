import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';

/**
 * Personal memory: what Goobster knows about you in one scope - the
 * transparency report (About you), the distilled facts, and the raw
 * memories - with one-by-one deletion. This is the same data
 * `/what-do-you-know-about-me` reports in Discord.
 *
 * It renders inside Settings → Memory & privacy for your private space and,
 * explicitly labelled, for a server you pick in the advanced inspector.
 * It never lists saved notes: those are Knowledge, kept on purpose, and
 * have their own room. Deleting here never touches them either - see
 * documentation/knowledge_and_memory.md for the deletion rules.
 */
export type MemoryTab = 'overview' | 'facts' | 'memories';

export type ReportPayload = {
    facts: unknown[];
    memories: { count: number; oldest?: string; newest?: string };
    conversations: { messages: number; count: number };
    followups: Array<{ note: string; dueAt?: string }>;
    knowledgeGraph?: { nodes: number; edges: number; saved?: number; distilled?: number; unclassified?: number };
    applets?: number;
    usageRows: number;
    activityMessages: number;
    economy: { balance: number | null; transactions: number };
    nickname?: string | null;
};

export type Fact = { id: number | string; content: string; source?: string; subjectType?: string; updatedAt?: string };
export type Memory = { id: number; content: string; authorName?: string; createdAt?: string };

export const MEMORY_TABS: Array<[MemoryTab, string]> = [
    ['overview', 'About you'],
    ['facts', 'Facts'],
    ['memories', 'Memories']
];

export function whenLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
    return (
        <div className="stat-card">
            <div className="stat-label">{label}</div>
            <div className="stat-value">{value}</div>
            {sub ? <div className="stat-sub">{sub}</div> : null}
        </div>
    );
}

export type PersonalMemoryPanelProps = {
    /** `dm:<userId>` or a guild id. */
    scope: string;
    scopeKind: 'dm' | 'guild';
    /** How to name the scope in copy ("your private space", a server name). */
    scopeName: string;
    /** Offered on About you when set (the private scope only). */
    onForget?: () => void;
    /** Anchor id prefix so Settings deep links and tests can find the tabs. */
    idPrefix?: string;
    initialTab?: MemoryTab;
};

export function PersonalMemoryPanel({
    scope, scopeKind, scopeName, onForget, idPrefix = 'personal-memory', initialTab = 'overview'
}: PersonalMemoryPanelProps) {
    const [tab, setTab] = useState<MemoryTab>(initialTab);
    return (
        <div className={`personal-memory personal-memory-${scopeKind}`} id={idPrefix} data-scope={scope}>
            <div className="segment personal-memory-tabs" role="tablist" aria-label={`Personal memory in ${scopeName}`}>
                {MEMORY_TABS.map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        id={`${idPrefix}-tab-${id}`}
                        aria-selected={tab === id}
                        className={`segment-btn${tab === id ? ' active' : ''}`}
                        data-tour={`${idPrefix}-${id}`}
                        onClick={() => setTab(id)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            {tab === 'overview' && <AboutYou scope={scope} scopeKind={scopeKind} scopeName={scopeName} onForget={onForget} />}
            {tab === 'facts' && <FactsList scope={scope} scopeKind={scopeKind} scopeName={scopeName} />}
            {tab === 'memories' && <MemoriesList scope={scope} scopeKind={scopeKind} scopeName={scopeName} />}
        </div>
    );
}

export function AboutYou({ scope, scopeKind, scopeName, onForget }: {
    scope: string; scopeKind: 'dm' | 'guild'; scopeName: string; onForget?: () => void;
}) {
    const report = useQuery({
        queryKey: keys.memory(scope, 'overview'),
        queryFn: () => api.report(scope) as Promise<ReportPayload>,
        enabled: Boolean(scope)
    });
    if (report.isPending) return <div className="empty">Loading…</div>;
    if (report.isError) return <div className="empty">{(report.error as Error).message}</div>;
    const data = report.data;
    if (!data) return null;
    const kg = data.knowledgeGraph;
    return (
        <div className="mtab personal-memory-overview">
            <div className="stat-grid privacy-cards">
                <Stat label="Facts about you" value={data.facts.length} sub={scopeKind === 'dm' ? 'in your private space' : `in ${scopeName}`} />
                <Stat
                    label="Memories"
                    value={data.memories.count}
                    sub={data.memories.count > 0
                        ? `${whenLabel(data.memories.oldest)} → ${whenLabel(data.memories.newest)}`
                        : 'nothing stored'}
                />
                {kg && (
                    <Stat
                        label="Distilled notes"
                        value={kg.distilled || 0}
                        sub={`${kg.saved || 0} kept by you · ${kg.unclassified || 0} unsorted`}
                    />
                )}
                <Stat
                    label="Chat messages"
                    value={data.conversations.messages}
                    sub={`${data.conversations.count} conversation${data.conversations.count === 1 ? '' : 's'} (bot-wide)`}
                />
                <Stat label="Pending follow-ups" value={data.followups.length} />
                <Stat label="Pinned applets" value={data.applets || 0} />
                <Stat label="AI calls" value={data.usageRows} />
                <Stat label="Messages counted" value={data.activityMessages} sub="activity counters, no content" />
                {data.economy.balance !== null && (
                    <Stat label="Wallet" value={data.economy.balance} sub={`${data.economy.transactions} ledger entries`} />
                )}
                {data.nickname ? <Stat label="Nickname" value={data.nickname} /> : null}
            </div>
            <div className="privacy-stage">
                <p className="hint">
                    This is the same data <code>/what-do-you-know-about-me</code> reports in Discord.
                    Facts and memories are what Goobster inferred; delete them one by one on their tabs.
                    Notes you kept on purpose are Knowledge, not memory —{' '}
                    <Link to="/knowledge/notes">open Knowledge → Notes</Link>
                    {kg && (kg.distilled || 0) > 0 ? <> (the {kg.distilled} distilled notes are under <em>All retained knowledge</em> there)</> : null}.
                </p>
                {onForget && (
                    <button type="button" className="btn danger" onClick={onForget}>
                        Forget me — watch it disappear
                    </button>
                )}
            </div>
            {data.followups.length > 0 && (
                <>
                    <div className="section-title">Pending follow-ups</div>
                    <div className="list-card">
                        {data.followups.map((followup) => (
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
        </div>
    );
}

export function FactsList({ scope, scopeKind, scopeName }: { scope: string; scopeKind: 'dm' | 'guild'; scopeName: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const facts = useQuery({
        queryKey: keys.memory(scope, 'facts'),
        queryFn: () => api.facts(scope) as Promise<{ facts: Fact[] }>,
        enabled: Boolean(scope)
    });
    function invalidate() {
        queryClient.invalidateQueries({ queryKey: keys.memory(scope, 'facts') });
        queryClient.invalidateQueries({ queryKey: keys.memory(scope, 'overview') });
        queryClient.invalidateQueries({ queryKey: keys.constellationRoot(scope) });
        queryClient.invalidateQueries({ queryKey: keys.spitballNotesRoot(scope) });
    }
    return (
        <div className="mtab personal-memory-facts">
            {facts.isPending && <div className="empty">Loading…</div>}
            {facts.isError && <div className="empty">{(facts.error as Error).message}</div>}
            {facts.data && facts.data.facts.length === 0 && <div className="empty">No distilled facts here yet.</div>}
            {facts.data && facts.data.facts.length > 0 && (
                <>
                    <div className="hint" style={{ marginBottom: 10 }}>
                        Distilled facts Goobster keeps about {scopeKind === 'dm' ? 'you from your DMs and web chats' : `you in ${scopeName}`} — separate from raw memories and from the notes you kept.
                        Forgetting one also removes its copy on the Map; the memories it came from stay.
                    </div>
                    <div className="list-card">
                        {facts.data.facts.map((fact) => (
                            <div key={String(fact.id)} className="list-row">
                                <div className="row-body">
                                    <span className="badge">{fact.subjectType === 'GUILD' ? 'shared' : 'you'}</span>
                                    {fact.content}
                                    <div className="row-meta">{fact.source} · {whenLabel(fact.updatedAt)}</div>
                                </div>
                                <button
                                    type="button"
                                    className="row-delete"
                                    title="Forget this fact"
                                    aria-label={`Forget fact: ${fact.content}`}
                                    onClick={async () => {
                                        if (!await confirm('Forget this fact? Goobster will no longer know it, and its copy leaves the Map. The memories it was distilled from stay.')) return;
                                        try {
                                            await api.deleteFact(scope, fact.id);
                                            toast('Fact forgotten.');
                                            invalidate();
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
    );
}

export function MemoriesList({ scope, scopeKind, scopeName }: { scope: string; scopeKind: 'dm' | 'guild'; scopeName: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const memories = useQuery({
        queryKey: keys.memory(scope, 'memories'),
        queryFn: () => api.memories(scope) as Promise<{ memories: Memory[] }>,
        enabled: Boolean(scope)
    });
    function invalidate() {
        queryClient.invalidateQueries({ queryKey: keys.memory(scope, 'memories') });
        queryClient.invalidateQueries({ queryKey: keys.memory(scope, 'overview') });
        queryClient.invalidateQueries({ queryKey: keys.constellationRoot(scope) });
    }
    return (
        <div className="mtab personal-memory-memories">
            {memories.isPending && <div className="empty">Loading…</div>}
            {memories.isError && <div className="empty">{(memories.error as Error).message}</div>}
            {memories.data && memories.data.memories.length === 0 && <div className="empty">No stored memories here.</div>}
            {memories.data && memories.data.memories.length > 0 && (
                <>
                    <div className="hint" style={{ marginBottom: 10 }}>
                        {scopeKind === 'dm'
                            ? 'Everything remembered from your DMs and web chat (both sides of the conversation).'
                            : `Memories you authored in ${scopeName}. Other members’ memories are theirs to manage.`}
                        {' '}Deleting one removes the raw memory and its recall vector; notes distilled from it stay.
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
                                    aria-label={`Delete memory: ${memory.content.slice(0, 60)}`}
                                    onClick={async () => {
                                        if (!await confirm('Delete this memory? It cannot be recalled afterwards. Notes distilled from it stay.')) return;
                                        try {
                                            await api.deleteMemory(scope, memory.id);
                                            toast('Memory deleted.');
                                            invalidate();
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
    );
}
