import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Modal } from './Modal';
import type { ContinuationProposal, Expedition, ExpeditionDetail, Lead, Lens, ResearchClaim, ResearchSource } from '../lib/types';

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

const PIPELINE_STAGES = [
    { id: 'plan', label: 'Plan' },
    { id: 'search', label: 'Search' },
    { id: 'sources', label: 'Sources' },
    { id: 'review', label: 'Review' },
    { id: 'claims', label: 'Claims' },
    { id: 'notes', label: 'Notes' },
    { id: 'leads', label: 'Leads' }
] as const;

const DEPTH_COPY: Record<string, string> = {
    focused: 'One tight pass',
    standard: 'A few cycles',
    deep: 'Keep digging'
};

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
type DepthBudgets = { maxCycles: number; maxSources: number; maxNotes: number };

/** Which pipeline stage the current cycle is in, from durable counters. */
function inferResearchStage(args: {
    status: Expedition['status'];
    cycles: ExpeditionDetail['cycles'];
    sources: ResearchSource[];
    claims: ResearchClaim[];
}): { index: number; label: string } {
    if (args.status === 'QUEUED') return { index: -1, label: 'Queued — waiting for a runner' };
    const running = args.cycles.find((cycle) => cycle.status === 'RUNNING');
    if (!running) return { index: 0, label: 'Planning the next cycle' };
    const cycleSources = args.sources.filter((source) => source.cycleId == null || source.cycleId === running.id);
    const cycleClaims = args.claims.filter((claim) => claim.cycleId == null || claim.cycleId === running.id);
    const accepted = cycleSources.filter((source) => source.accepted);
    if (cycleSources.length === 0) return { index: 1, label: 'Searching for sources' };
    if (accepted.length === 0) return { index: 3, label: 'Reviewing sources for relevance' };
    if (cycleClaims.length === 0) return { index: 4, label: 'Reading sources and extracting claims' };
    return { index: 5, label: 'Writing notes and connections' };
}

function ResearchOrbit() {
    return (
        <div className="research-orbit" aria-hidden="true">
            <div className="research-orbit-ring outer">
                <span className="research-orbit-dot" />
            </div>
            <div className="research-orbit-ring inner">
                <span className="research-orbit-dot" />
            </div>
            <div className="research-orbit-core">🧭</div>
        </div>
    );
}

function ResearchingBanner({
    expedition,
    cycles,
    sources,
    claims
}: {
    expedition: Expedition;
    cycles: ExpeditionDetail['cycles'];
    sources: ResearchSource[];
    claims: ResearchClaim[];
}) {
    const stage = inferResearchStage({ status: expedition.status, cycles, sources, claims });
    const completedCycles = cycles.filter((cycle) => cycle.status === 'COMPLETED').length;
    const stageFraction = stage.index < 0 ? 0 : (stage.index + 1) / PIPELINE_STAGES.length;
    const progress = Math.min(1, (completedCycles + (expedition.status === 'RUNNING' ? stageFraction : 0)) / Math.max(1, expedition.maxCycles));
    const accepted = sources.filter((source) => source.accepted).length;

    return (
        <div className="research-banner" aria-live="polite">
            <ResearchOrbit />
            <div className="research-banner-body">
                <div className="research-banner-head">
                    <strong>{expedition.status === 'QUEUED' ? 'Queued' : `Researching cycle ${Math.max(1, expedition.currentCycle) || completedCycles + 1} of ${expedition.maxCycles}`}</strong>
                    <span className="research-banner-pct">{Math.round(progress * 100)}%</span>
                </div>
                <div className="research-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                    <div className="research-progress-fill" style={{ width: `${Math.max(6, progress * 100)}%` }} />
                </div>
                <div className="research-pipeline">
                    {PIPELINE_STAGES.map((item, index) => {
                        const state = stage.index > index ? 'done' : stage.index === index ? 'current' : '';
                        return (
                            <div key={item.id} className={`research-stage ${state}`}>
                                <span className="research-stage-dot" />
                                <span className="research-stage-label">{item.label}</span>
                            </div>
                        );
                    })}
                </div>
                <div className="research-banner-meta">
                    {stage.label}
                    {' · '}{accepted} source{accepted === 1 ? '' : 's'}
                    {' · '}{claims.length} claim{claims.length === 1 ? '' : 's'}
                    {' · '}{expedition.notesCreated} note{expedition.notesCreated === 1 ? '' : 's'}
                </div>
            </div>
        </div>
    );
}

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

    const selectedLens = lenses.find((lens) => lens.id === effectiveLens);
    const depthOptions = (['focused', 'standard', 'deep'] as const).map((option) => ({
        id: option,
        budgets: lensesQuery.data?.depths?.[option] as DepthBudgets | undefined
    }));

    return (
        <Modal onClose={onClose} className="expedition-modal">
            <h2>New expedition</h2>
            <p className="hint expedition-lead">
                Goobster researches a topic on its own: gathering sources, extracting
                evidence, and growing connected notes in your Spitball.
            </p>

            <div className="field">
                <div className="field-head">
                    <label htmlFor="exp-seed">Topic</label>
                    <span className="field-count">{seed.length}/200</span>
                </div>
                <input
                    id="exp-seed"
                    className="input"
                    placeholder="What should Goobster research?"
                    value={seed}
                    maxLength={200}
                    autoFocus
                    onChange={(e) => setSeed(e.target.value)}
                />
            </div>

            <div className="field">
                <label htmlFor="exp-lens">Lens</label>
                <select
                    id="exp-lens"
                    className="select"
                    value={effectiveLens}
                    onChange={(e) => setLensId(e.target.value)}
                >
                    {lenses.map((lens) => (
                        <option key={lens.id} value={lens.id}>{lens.name}</option>
                    ))}
                </select>
                {selectedLens && (
                    <div className="lens-blurb">
                        {selectedLens.description}
                        {selectedLens.sourcePreferences.length > 0 && (
                            <div className="row-meta">
                                Prefers {selectedLens.sourcePreferences.slice(0, 4).map((item) => item.replace(/_/g, ' ')).join(', ')}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className="field">
                <label id="exp-depth-label">Depth</label>
                <div className="depth-cards" role="tablist" aria-labelledby="exp-depth-label">
                    {depthOptions.map(({ id, budgets: optionBudgets }) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={effectiveDepth === id}
                            className={`depth-card${effectiveDepth === id ? ' active' : ''}`}
                            onClick={() => setDepth(id)}
                        >
                            <strong>{id[0].toUpperCase() + id.slice(1)}</strong>
                            <span>{DEPTH_COPY[id]}</span>
                            {optionBudgets && (
                                <em>
                                    {optionBudgets.maxCycles} cycle{optionBudgets.maxCycles === 1 ? '' : 's'}
                                    {' · '}{optionBudgets.maxSources} sources
                                    {' · '}{optionBudgets.maxNotes} notes
                                </em>
                            )}
                        </button>
                    ))}
                </div>
                {budgets && (
                    <div className="hint">
                        This run will stop after {budgets.maxCycles} cycle{budgets.maxCycles === 1 ? '' : 's'},
                        {' '}{budgets.maxSources} sources, or {budgets.maxNotes} notes — whichever comes first.
                    </div>
                )}
            </div>

            <div className="field">
                <div className="field-head">
                    <label htmlFor="exp-intent">Intent <span className="optional">optional</span></label>
                    <span className="field-count">{intent.length}/1000</span>
                </div>
                <textarea
                    id="exp-intent"
                    className="input"
                    placeholder="What do you want from this research? e.g. “a map of open questions, not a summary”"
                    value={intent}
                    rows={3}
                    maxLength={1000}
                    onChange={(e) => setIntent(e.target.value)}
                />
            </div>

            {advanced ? (
                <div className="field">
                    <div className="field-head">
                        <label htmlFor="exp-lens-text">Extra lens context <span className="optional">optional</span></label>
                        <span className="field-count">{lensText.length}/500</span>
                    </div>
                    <textarea
                        id="exp-lens-text"
                        className="input"
                        placeholder="e.g. “emphasize information-theory interpretations over engineering ones”"
                        value={lensText}
                        rows={2}
                        maxLength={500}
                        onChange={(e) => setLensText(e.target.value)}
                    />
                </div>
            ) : (
                <button type="button" className="btn subtle expedition-advanced" onClick={() => setAdvanced(true)}>
                    Add extra lens context…
                </button>
            )}

            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn primary"
                    disabled={create.isPending || seed.trim().length === 0}
                    onClick={() => create.mutate()}
                >
                    {create.isPending ? 'Starting…' : 'Start expedition'}
                </button>
            </div>
        </Modal>
    );
}

function ContinuationProposalBanner({
    proposal,
    onExtend
}: {
    proposal: ContinuationProposal;
    onExtend: (cycles?: number) => void;
}) {
    const cycles = proposal.suggestedCycles || 0;
    const uncovered = proposal.uncoveredUnits || [];
    const gaps = proposal.remainingGaps || [];
    return (
        <div className="continuation-banner" role="status">
            <div className="continuation-banner-body">
                <strong>More cycles would finish this</strong>
                <div className="row-meta">
                    {proposal.summary
                        || (proposal.varietyTarget
                            ? `Covered ${proposal.coveredCount ?? 0} of ~${proposal.varietyTarget} distinct topics the intent implied.`
                            : 'The original intent is not fully covered yet.')}
                </div>
                {(uncovered.length > 0 || gaps.length > 0) && (
                    <ul className="continuation-gaps">
                        {uncovered.slice(0, 6).map((unit) => (
                            <li key={unit}>{unit}</li>
                        ))}
                        {uncovered.length === 0 && gaps.slice(0, 4).map((gap) => (
                            <li key={gap}>{gap}</li>
                        ))}
                    </ul>
                )}
            </div>
            {proposal.extendable && cycles > 0 ? (
                <button
                    type="button"
                    className="btn primary"
                    onClick={() => onExtend(cycles)}
                >
                    Continue for {cycles} more cycle{cycles === 1 ? '' : 's'}
                </button>
            ) : (
                <div className="row-meta">Cycle ceiling reached — start a new expedition to go further.</div>
            )}
        </div>
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
        enabled: Boolean(detail.data),
        refetchInterval: () => {
            const status = detail.data?.expedition?.status;
            return status && ACTIVE_STATUSES.has(status) ? 4000 : false;
        }
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

    async function act(action: 'pause' | 'continue' | 'cancel' | 'extend', extraCycles?: number) {
        try {
            if (action === 'pause') await api.spitballPauseExpedition(id);
            if (action === 'continue') await api.spitballContinueExpedition(id);
            if (action === 'extend') await api.spitballExtendExpedition(id, extraCycles);
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

            {active && (
                <ResearchingBanner
                    expedition={expedition}
                    cycles={cycles}
                    sources={sources}
                    claims={claimsQuery.data?.claims || []}
                />
            )}

            <div className="list-card">
                <div className="list-row">
                    <div className="row-body">
                        <strong>{expedition.seed}</strong>
                        <div className="row-meta">
                            {expedition.lens?.name || expedition.lensId || 'General'} lens · {expedition.depth}
                            {expedition.researchBrief?.shape ? ` · ${expedition.researchBrief.shape.replace(/_/g, ' ')}` : ''}
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

            {expedition.status === 'COMPLETED' && expedition.continuationProposal?.needed && (
                <ContinuationProposalBanner
                    proposal={expedition.continuationProposal}
                    onExtend={(cycles) => act('extend', cycles)}
                />
            )}

            <div className="section-title">Cycles</div>
            {cycles.length === 0 && <div className="empty">No cycles yet.</div>}
            {cycles.length > 0 && (
                <div className="list-card">
                    {cycles.map((cycle) => (
                        <div key={cycle.id} className="list-row">
                            <div className="row-body">
                                <span className={`badge${cycle.status === 'RUNNING' ? ' researching' : ''}`}>
                                    {STATUS_ICONS[cycle.status]} cycle {cycle.cycleNumber}
                                </span>
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
                        <div key={expedition.id} className={`list-row list-row-click${ACTIVE_STATUSES.has(expedition.status) ? ' is-researching' : ''}`} onClick={() => setOpenId(expedition.id)}>
                            <div className="row-body">
                                <span className={`badge${ACTIVE_STATUSES.has(expedition.status) ? ' researching' : ''}`}>
                                    {STATUS_ICONS[expedition.status]} {expedition.status.toLowerCase()}
                                </span>
                                <strong>{expedition.seed}</strong>
                                <div className="row-meta">
                                    {expedition.lens?.name || 'General'} · {expedition.depth}
                                    {' · '}cycle {expedition.currentCycle}/{expedition.maxCycles}
                                    {' · '}{expedition.notesCreated} notes · {expedition.edgesCreated} connections
                                    {stopLabel(expedition) ? ` · ${stopLabel(expedition)}` : ''}
                                    {expedition.continuationProposal?.needed ? ' · more cycles suggested' : ''}
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
