import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Modal } from './Modal';
import type { Expedition, ExpeditionDetail, Lead, Lens, ResearchClaim, ResearchSource } from '../lib/types';

const STATUS_ICONS: Record<string, string> = {
    DRAFT: '📝', QUEUED: '⏳', RUNNING: '🧭', PAUSED: '⏸️',
    COMPLETED: '✅', FAILED: '⚠️', CANCELLED: '🚫'
};

const STOP_REASON_LABELS: Record<string, string> = {
    MAX_CYCLES: 'reached its cycle budget',
    MAX_NOTES: 'reached its note budget',
    MAX_SOURCES: 'reached its source budget',
    NOVELTY_SATURATED: 'novelty saturated',
    COVERAGE_SATURATED: 'coverage saturated',
    NO_NEW_SOURCES: 'found no new sources',
    NO_LEADS: 'no promising leads left',
    USER_PAUSED: 'paused',
    USER_CANCELLED: 'cancelled',
    FAILED: 'failed'
};

const ACTIVE_STATUSES = new Set(['QUEUED', 'RUNNING']);

function whenLabel(iso?: string | null): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function stopLabel(expedition: Expedition): string | null {
    if (!expedition.stopReason) return null;
    return STOP_REASON_LABELS[expedition.stopReason] || expedition.stopReason.toLowerCase();
}

type LensesPayload = { lenses: Lens[]; defaultLensId: string; depths: Record<string, { maxCycles: number; maxSources: number; maxNotes: number }>; defaultDepth: string };

/** The start-expedition form (spec §37.6): topic, lens, intent, depth. */
function StartExpeditionModal({ onClose, onCreated }: { onClose: () => void; onCreated: (expedition: Expedition) => void }) {
    const toast = useToast();
    const lensesQuery = useQuery({
        queryKey: keys.spitballLenses,
        queryFn: () => api.spitballLenses() as Promise<LensesPayload>
    });
    const [seed, setSeed] = useState('');
    const [lensId, setLensId] = useState<string | null>(null);
    const [intent, setIntent] = useState('');
    const [lensText, setLensText] = useState('');
    const [depth, setDepth] = useState<string | null>(null);
    const [advanced, setAdvanced] = useState(false);

    const lenses = lensesQuery.data?.lenses || [];
    const effectiveLens = lensId ?? lensesQuery.data?.defaultLensId ?? 'general';
    const effectiveDepth = depth ?? lensesQuery.data?.defaultDepth ?? 'standard';
    const budgets = lensesQuery.data?.depths?.[effectiveDepth];

    const create = useMutation({
        mutationFn: () => api.spitballCreateExpedition({
            seed: seed.trim(),
            lensId: effectiveLens,
            intent: intent.trim() || null,
            lensText: lensText.trim() || null,
            depth: effectiveDepth
        }) as Promise<Expedition>,
        onSuccess: (expedition) => { toast('Expedition started.'); onCreated(expedition); },
        onError: (error) => toast((error as Error).message, true)
    });

    return (
        <Modal onClose={onClose}>
            <h2>New expedition</h2>
            <p className="hint">
                Goobster researches a topic on its own: gathering sources, extracting evidence,
                and growing connected notes in your Spitball.
            </p>
            <input
                className="input"
                placeholder="Topic — what should Goobster research?"
                value={seed}
                maxLength={200}
                onChange={(e) => setSeed(e.target.value)}
            />
            <select className="select" aria-label="Lens" value={effectiveLens} onChange={(e) => setLensId(e.target.value)}>
                {lenses.map((lens) => (
                    <option key={lens.id} value={lens.id}>{lens.name}</option>
                ))}
            </select>
            <textarea
                className="input"
                placeholder="Intent (optional) — what do you want from this research?"
                value={intent}
                rows={2}
                maxLength={1000}
                onChange={(e) => setIntent(e.target.value)}
            />
            <div className="segment" role="tablist" aria-label="Depth">
                {['focused', 'standard', 'deep'].map((option) => (
                    <button
                        key={option}
                        type="button"
                        className={`segment-btn${effectiveDepth === option ? ' active' : ''}`}
                        onClick={() => setDepth(option)}
                    >
                        {option[0].toUpperCase() + option.slice(1)}
                    </button>
                ))}
            </div>
            {budgets && (
                <div className="hint">
                    Up to {budgets.maxCycles} cycle{budgets.maxCycles === 1 ? '' : 's'} · {budgets.maxSources} sources · {budgets.maxNotes} notes
                </div>
            )}
            {advanced ? (
                <textarea
                    className="input"
                    placeholder="Extra lens context (optional) — e.g. “emphasize information-theory interpretations”"
                    value={lensText}
                    rows={2}
                    maxLength={500}
                    onChange={(e) => setLensText(e.target.value)}
                />
            ) : (
                <button type="button" className="btn subtle" onClick={() => setAdvanced(true)}>Advanced…</button>
            )}
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn primary"
                    disabled={create.isPending || seed.trim().length === 0}
                    onClick={() => create.mutate()}
                >
                    Start expedition
                </button>
            </div>
        </Modal>
    );
}

function LeadRow({ lead }: { lead: Lead }) {
    return (
        <div className="list-row">
            <div className="row-body">
                {lead.kind ? <span className="badge">{lead.kind.replace(/_/g, ' ')}</span> : null}
                {lead.topic}
                {lead.reason ? <div className="row-meta">{lead.reason}</div> : null}
                <div className="row-meta">
                    {typeof lead.expectedValue === 'number' ? `value ${lead.expectedValue.toFixed(2)}` : ''}
                    {typeof lead.novelty === 'number' ? ` · novelty ${lead.novelty.toFixed(2)}` : ''}
                    {lead.cycleNumber ? ` · cycle ${lead.cycleNumber}` : ''}
                </div>
            </div>
        </div>
    );
}

function SourceRow({ source, claims }: { source: ResearchSource; claims: ResearchClaim[] }) {
    const [open, setOpen] = useState(false);
    const title = source.title || source.canonicalUrl || source.url || `Source #${source.id}`;
    return (
        <div className="list-row">
            <div className="row-body">
                <span className="badge">{source.accepted ? '✓ accepted' : 'rejected'}</span>
                {source.url
                    ? <a href={source.url} target="_blank" rel="noreferrer noopener">{title}</a>
                    : title}
                <div className="row-meta">
                    {source.provider}{source.sourceType ? ` · ${source.sourceType}` : ''}
                    {source.publisher ? ` · ${source.publisher}` : ''}
                    {!source.accepted && source.rejectionReason ? ` · ${source.rejectionReason}` : ''}
                    {claims.length > 0 && (
                        <>
                            {' · '}
                            <button type="button" className="btn subtle small" onClick={() => setOpen(!open)}>
                                {open ? 'hide claims' : `${claims.length} claim${claims.length === 1 ? '' : 's'} ▸`}
                            </button>
                        </>
                    )}
                </div>
                {open && claims.length > 0 && (
                    <ul className="evidence-claims">
                        {claims.map((claim) => (
                            <li key={claim.id}>
                                <span className="badge">{claim.kind.replace(/_/g, ' ')}</span>
                                {claim.text}
                                <span className="row-meta">
                                    {' '}confidence {claim.confidence.toFixed(2)}
                                    {claim.sourceLocation ? ` · ${claim.sourceLocation}` : ''}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

function ExpeditionDetailView({ id, onBack }: { id: number; onBack: () => void }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const detail = useQuery({
        queryKey: keys.spitballExpedition(id),
        queryFn: () => api.spitballExpedition(id) as Promise<ExpeditionDetail>,
        refetchInterval: (query) => {
            const status = query.state.data?.expedition?.status;
            return status && ACTIVE_STATUSES.has(status) ? 4000 : false;
        }
    });
    const claimsQuery = useQuery({
        queryKey: keys.spitballClaims(id),
        queryFn: () => api.spitballClaims(id) as Promise<{ claims: ResearchClaim[] }>,
        enabled: Boolean(detail.data && (detail.data.sources || []).some((s) => s.accepted))
    });
    const claimsBySource = new Map<number, ResearchClaim[]>();
    for (const claim of claimsQuery.data?.claims || []) {
        if (claim.sourceId === null) continue;
        const list = claimsBySource.get(claim.sourceId) || [];
        list.push(claim);
        claimsBySource.set(claim.sourceId, list);
    }

    const refresh = () => {
        queryClient.invalidateQueries({ queryKey: keys.spitballExpedition(id) });
        queryClient.invalidateQueries({ queryKey: keys.spitball });
    };

    async function act(action: 'pause' | 'continue' | 'cancel') {
        try {
            if (action === 'pause') await api.spitballPauseExpedition(id);
            if (action === 'continue') await api.spitballContinueExpedition(id);
            if (action === 'cancel') {
                if (!await confirm('Cancel this expedition? It cannot be restarted afterwards.')) return;
                await api.spitballCancelExpedition(id);
            }
            refresh();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    if (detail.isPending) return <div className="empty">Loading…</div>;
    if (detail.isError) return <div className="empty">{(detail.error as Error).message}</div>;
    const { expedition, cycles, sources, leads } = detail.data;
    const active = ACTIVE_STATUSES.has(expedition.status);
    const stop = stopLabel(expedition);

    return (
        <div className="mtab">
            <div className="hint usage-legend">
                <button type="button" className="btn small" onClick={onBack}>← Expeditions</button>
                <span className="key">{STATUS_ICONS[expedition.status]} {expedition.status.toLowerCase()}</span>
                {active && <button type="button" className="btn small" onClick={() => act('pause')}>Pause</button>}
                {expedition.status === 'PAUSED' && <button type="button" className="btn small" onClick={() => act('continue')}>Continue</button>}
                {!['COMPLETED', 'FAILED', 'CANCELLED'].includes(expedition.status) && (
                    <button type="button" className="btn small danger" onClick={() => act('cancel')}>Cancel</button>
                )}
                <button type="button" className="btn small" onClick={refresh}>Refresh</button>
            </div>

            <div className="list-card">
                <div className="list-row">
                    <div className="row-body">
                        <strong>{expedition.seed}</strong>
                        <div className="row-meta">
                            {expedition.lens?.name || expedition.lensId || 'General'} lens · {expedition.depth}
                            {expedition.intent ? ` · “${expedition.intent}”` : ''}
                        </div>
                        <div className="row-meta">
                            cycle {expedition.currentCycle}/{expedition.maxCycles}
                            {' · '}{expedition.sourcesAccepted} sources · {expedition.notesCreated} notes · {expedition.edgesCreated} connections
                            {stop ? ` · ${stop}` : ''}
                        </div>
                        {expedition.lastError ? <div className="row-meta">⚠️ {expedition.lastError}</div> : null}
                        {expedition.summary ? <div className="row-meta">{expedition.summary}</div> : null}
                    </div>
                </div>
            </div>

            <div className="section-title">Cycles</div>
            {cycles.length === 0 && <div className="empty">No cycles yet.</div>}
            {cycles.length > 0 && (
                <div className="list-card">
                    {cycles.map((cycle) => (
                        <div key={cycle.id} className="list-row">
                            <div className="row-body">
                                <span className="badge">{STATUS_ICONS[cycle.status]} cycle {cycle.cycleNumber}</span>
                                {cycle.coverage?.summary || (cycle.status === 'RUNNING' ? 'Researching…' : '')}
                                <div className="row-meta">
                                    {cycle.sourcesAccepted}/{cycle.sourceCount} sources · {cycle.claimsExtracted} claims
                                    {' · '}{cycle.notesCreated} notes ({cycle.notesMerged} merged) · {cycle.edgesCreated} connections
                                    {cycle.conflictsFound > 0 ? ` · ⚡ ${cycle.conflictsFound} conflicts` : ''}
                                    {typeof cycle.noveltyScore === 'number' ? ` · novelty ${cycle.noveltyScore.toFixed(2)}` : ''}
                                    {cycle.finishedAt ? ` · ${whenLabel(cycle.finishedAt)}` : ''}
                                </div>
                                {cycle.lastError ? <div className="row-meta">⚠️ {cycle.lastError}</div> : null}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <div className="section-title">Leads</div>
            {leads.length === 0 && <div className="empty">No leads yet — they appear as cycles finish.</div>}
            {leads.length > 0 && (
                <div className="list-card">
                    {leads.map((lead, index) => <LeadRow key={`${lead.topic}-${index}`} lead={lead} />)}
                </div>
            )}

            <div className="section-title">Sources</div>
            {sources.length === 0 && <div className="empty">No sources gathered yet.</div>}
            {sources.length > 0 && (
                <div className="list-card">
                    {sources.map((source) => (
                        <SourceRow key={source.id} source={source} claims={claimsBySource.get(source.id) || []} />
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * The Expeditions pane inside Spitball: list, start form, and detail view
 * for autonomous research runs (spec §37.4/§37.5).
 */
export function ExpeditionsTab() {
    const [openId, setOpenId] = useState<number | null>(null);
    const [creating, setCreating] = useState(false);
    const queryClient = useQueryClient();
    const list = useQuery({
        queryKey: keys.spitball,
        queryFn: () => api.spitballExpeditions() as Promise<{ expeditions: Expedition[] }>,
        refetchInterval: (query) => (
            (query.state.data?.expeditions || []).some((e) => ACTIVE_STATUSES.has(e.status)) ? 5000 : false
        )
    });

    if (openId !== null) {
        return <ExpeditionDetailView id={openId} onBack={() => setOpenId(null)} />;
    }

    const expeditions = list.data?.expeditions || [];
    return (
        <div className="mtab">
            <div className="hint usage-legend">
                <span className="key">Deliberate research: Goobster grows a region of your Spitball on its own.</span>
                <button type="button" className="btn small primary" onClick={() => setCreating(true)}>+ New expedition</button>
            </div>
            {list.isPending && <div className="empty">Loading…</div>}
            {list.isError && <div className="empty">{(list.error as Error).message}</div>}
            {list.data && expeditions.length === 0 && (
                <div className="empty">
                    No expeditions yet. Give Goobster a topic and a lens, and it will research it into
                    connected, sourced notes.
                </div>
            )}
            {expeditions.length > 0 && (
                <div className="list-card">
                    {expeditions.map((expedition) => (
                        <div key={expedition.id} className="list-row list-row-click" onClick={() => setOpenId(expedition.id)}>
                            <div className="row-body">
                                <span className="badge">{STATUS_ICONS[expedition.status]} {expedition.status.toLowerCase()}</span>
                                <strong>{expedition.seed}</strong>
                                <div className="row-meta">
                                    {expedition.lens?.name || 'General'} · {expedition.depth}
                                    {' · '}cycle {expedition.currentCycle}/{expedition.maxCycles}
                                    {' · '}{expedition.notesCreated} notes · {expedition.edgesCreated} connections
                                    {stopLabel(expedition) ? ` · ${stopLabel(expedition)}` : ''}
                                    {' · '}{whenLabel(expedition.finishedAt || expedition.createdAt)}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {creating && (
                <StartExpeditionModal
                    onClose={() => setCreating(false)}
                    onCreated={(expedition) => {
                        setCreating(false);
                        queryClient.invalidateQueries({ queryKey: keys.spitball });
                        setOpenId(expedition.id);
                    }}
                />
            )}
        </div>
    );
}
