import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import type { BriefBlock, BriefClaimMark, BriefDetail, BriefQualityStatus, BriefSummary, Expedition } from '../lib/types';

/**
 * Research brief (#254, documentation/research_brief.md): a private artifact
 * written from one Expedition's stored evidence. The generated text is
 * immutable; the owner's edits are an overlay, kept distinguishable and
 * classified wording / factual; the owner's review applies #267's four-part
 * bar; acceptance and actual use are explicit actions. Nothing here infers
 * quality from a blank review.
 */

const QUALITY_COPY: Record<BriefQualityStatus, { label: string; hint: string }> = {
    'unreviewed': { label: 'Unreviewed', hint: 'Not yet judged - this is not a quality pass.' },
    'not-ready': { label: 'Not ready to show', hint: 'Fails the four-part bar for showing a second person.' },
    'ready-to-show': { label: 'Ready to show a second person', hint: 'Owner-judged: no unsupported claims, weak evidence labelled, both sides present, wording-only edits.' }
};

const MARKS: BriefClaimMark[] = ['supported', 'unsupported', 'missing a qualification'];
const GATE_COPY: Array<{ id: 'noUnsupportedClaims' | 'weakEvidenceLabelled' | 'disagreementRepresented'; label: string }> = [
    { id: 'noUnsupportedClaims', label: 'No unsupported claims' },
    { id: 'weakEvidenceLabelled', label: 'Weak evidence is labelled uncertain' },
    { id: 'disagreementRepresented', label: 'Both positions present where sources disagree' }
];

function when(text?: string | null): string {
    if (!text) return '';
    const date = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? text : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Cites({ numbers }: { numbers?: number[] }) {
    if (!numbers || numbers.length === 0) return null;
    return (
        <span className="brief-cites">
            {numbers.map((n) => <a key={n} href={`#brief-source-${n}`} className="brief-cite">[{n}]</a>)}
        </span>
    );
}

/** One editable passage: effective text, the edit marker, and the original when edited. */
function EditableBlock({
    block,
    target,
    label,
    onSave,
    saving
}: {
    block: BriefBlock;
    target: string;
    label?: string;
    onSave: (edit: { target: string; text: string; type: 'wording' | 'factual'; note: string | null } | { target: string; text: '' }) => Promise<unknown>;
    saving: boolean;
}) {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(block.text);
    const [type, setType] = useState<'wording' | 'factual'>(block.editType || 'wording');
    const [note, setNote] = useState(block.editNote || '');
    const [showOriginal, setShowOriginal] = useState(false);

    async function save() {
        await onSave({ target, text: text.trim(), type, note: note.trim() || null });
        setEditing(false);
    }
    async function remove() {
        await onSave({ target, text: '' });
        setEditing(false);
        setText(block.generated);
    }

    return (
        <div className={`brief-block${block.edited ? ' is-edited' : ''}`} data-target={target}>
            {label ? <span className="badge">{label}</span> : null}
            {block.cited === false ? <span className="badge danger">no stored claim cited</span> : null}
            {!editing && (
                <>
                    <div className="brief-text">
                        {block.text}
                        <Cites numbers={block.citations} />
                    </div>
                    <div className="row-meta brief-block-meta">
                        {block.edited ? (
                            <>
                                <span className="brief-edit-marker">✎ edited ({block.editType})</span>
                                {block.editNote ? ` · ${block.editNote}` : ''}
                                {' · '}
                                <button type="button" className="btn subtle small" onClick={() => setShowOriginal(!showOriginal)}>
                                    {showOriginal ? 'hide original' : 'show original'}
                                </button>
                            </>
                        ) : <span className="brief-generated-marker">generated text</span>}
                        {' · '}
                        <button type="button" className="btn subtle small" onClick={() => { setText(block.text); setEditing(true); }}>Edit</button>
                    </div>
                    {block.edited && showOriginal && (
                        <blockquote className="brief-original">
                            <span className="row-meta">Original generated text (unchanged):</span>
                            <div>{block.generated}</div>
                        </blockquote>
                    )}
                </>
            )}
            {editing && (
                <div className="brief-editor">
                    <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Edit ${target}`} />
                    <div className="brief-editor-row" role="radiogroup" aria-label="Edit type">
                        <label><input type="radio" name={`type-${target}`} checked={type === 'wording'} onChange={() => setType('wording')} /> Wording only</label>
                        <label><input type="radio" name={`type-${target}`} checked={type === 'factual'} onChange={() => setType('factual')} /> Factual correction</label>
                    </div>
                    <input className="input" placeholder="Why (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} aria-label="Edit note" />
                    <div className="brief-editor-row">
                        <button type="button" className="btn small primary" disabled={saving || !text.trim() || text.trim() === block.generated} onClick={save}>Save edit</button>
                        {block.edited && <button type="button" className="btn small" disabled={saving} onClick={remove}>Remove edit</button>}
                        <button type="button" className="btn small" onClick={() => setEditing(false)}>Cancel</button>
                    </div>
                    <div className="hint">The generated text stays as it is; your edit is stored separately and shown in its place.</div>
                </div>
            )}
        </div>
    );
}

function ReviewPanel({ detail, onSave, saving }: { detail: BriefDetail; onSave: (body: { marks: Record<string, string | null>; rationale: Record<string, string>; gates: Record<string, boolean | null>; notes: string | null }) => Promise<void>; saving: boolean }) {
    const review = detail.review;
    const findings = detail.rendered?.findings || [];
    const [marks, setMarks] = useState<Record<string, string | null>>(() => Object.fromEntries(findings.map((f) => [f.id, review?.marks?.[f.id] || null])));
    const [rationale, setRationale] = useState<Record<string, string>>(() => ({ ...(review?.rationale || {}) }));
    const [gates, setGates] = useState<Record<string, boolean | null>>(() => ({
        noUnsupportedClaims: review?.gates?.noUnsupportedClaims ?? null,
        weakEvidenceLabelled: review?.gates?.weakEvidenceLabelled ?? null,
        disagreementRepresented: review?.gates?.disagreementRepresented ?? null
    }));
    const [notes, setNotes] = useState(review?.notes || '');
    const quality = detail.quality;

    return (
        <div className="list-card brief-review">
            <div className="list-row"><div className="row-body">
                <strong>Owner review</strong>
                <div className="row-meta">Mark every finding against its sources, then judge the three gates. The fourth part - edits wording-only - is read from your edits. A blank field is unreviewed, never a pass.</div>
            </div></div>
            {findings.map((f) => (
                <div className="list-row" key={f.id}><div className="row-body brief-review-row">
                    <label htmlFor={`mark-${f.id}`}><strong>{f.id}</strong> <span className="row-meta">{f.text.slice(0, 120)}{f.text.length > 120 ? '…' : ''}</span></label>
                    <select id={`mark-${f.id}`} className="select" value={marks[f.id] || ''} onChange={(e) => setMarks({ ...marks, [f.id]: e.target.value || null })}>
                        <option value="">unreviewed</option>
                        {MARKS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <input className="input" placeholder="Rationale (optional)" value={rationale[f.id] || ''} maxLength={500} onChange={(e) => setRationale({ ...rationale, [f.id]: e.target.value })} aria-label={`Rationale for ${f.id}`} />
                </div></div>
            ))}
            {GATE_COPY.map((gate) => (
                <div className="list-row" key={gate.id}><div className="row-body brief-review-row">
                    <label htmlFor={`gate-${gate.id}`}>{gate.label}</label>
                    <select id={`gate-${gate.id}`} className="select" value={gates[gate.id] === null ? '' : gates[gate.id] ? 'yes' : 'no'} onChange={(e) => setGates({ ...gates, [gate.id]: e.target.value === '' ? null : e.target.value === 'yes' })}>
                        <option value="">unreviewed</option>
                        <option value="yes">yes</option>
                        <option value="no">no</option>
                    </select>
                </div></div>
            ))}
            <div className="list-row"><div className="row-body brief-review-row">
                <label htmlFor="review-notes">Notes</label>
                <textarea id="review-notes" className="input" rows={2} value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} />
            </div></div>
            <div className="list-row"><div className="row-body">
                <button type="button" className="btn small primary" disabled={saving} onClick={() => onSave({ marks, rationale, gates, notes: notes.trim() || null })}>Save review</button>
                {quality && (
                    <span className="row-meta">
                        {' '}Edits: {quality.editType}{quality.parts.editsWordingOnly ? '' : ' - a factual correction fails the bar'}.
                        {quality.reviewedAt ? ` Reviewed ${when(quality.reviewedAt)}.` : ''}
                    </span>
                )}
            </div></div>
        </div>
    );
}

export function BriefView({ briefId, onBack }: { briefId: number; onBack: () => void }) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [useNote, setUseNote] = useState('');
    const query = useQuery({
        queryKey: keys.spitballBrief(briefId),
        queryFn: () => api.spitballBrief(briefId),
        refetchInterval: (q) => (q.state.data?.brief.status === 'GENERATING' ? 3000 : false)
    });
    const refresh = (next?: BriefDetail) => {
        if (next) queryClient.setQueryData(keys.spitballBrief(briefId), next);
        else queryClient.invalidateQueries({ queryKey: keys.spitballBrief(briefId) });
        if (next?.brief.expeditionId) queryClient.invalidateQueries({ queryKey: keys.spitballBriefs(next.brief.expeditionId) });
    };
    const fail = (error: unknown) => toast((error as Error).message, true);

    const overlay = useMutation({
        mutationFn: async (edit: { target: string; text: string; type?: 'wording' | 'factual'; note?: string | null }) => {
            const current = query.data!;
            const others = current.overlay.edits.filter((e) => e.target !== edit.target)
                .map((e) => ({ target: e.target, text: e.text, type: e.type, note: e.note }));
            const edits = edit.text
                ? [...others, { target: edit.target, text: edit.text, type: edit.type || 'wording', note: edit.note ?? null }]
                : others;
            return api.spitballBriefOverlay(briefId, { edits, expectedRevision: current.brief.overlayRevision });
        },
        onSuccess: (next) => { refresh(next); toast('Edit saved separately from the generated text.'); },
        onError: fail
    });
    const review = useMutation({
        mutationFn: (body: { marks: Record<string, string | null>; rationale: Record<string, string>; gates: Record<string, boolean | null>; notes: string | null }) =>
            api.spitballBriefReview(briefId, { ...body, expectedRevision: query.data!.brief.reviewRevision }),
        onSuccess: (next) => { refresh(next); toast('Review saved.'); },
        onError: fail
    });
    const accept = useMutation({
        mutationFn: (accepted: boolean) => api.spitballBriefAccept(briefId, accepted),
        onSuccess: (next) => { refresh(next); toast(next.brief.acceptedAt ? 'Brief accepted.' : 'Acceptance withdrawn.'); },
        onError: fail
    });
    const used = useMutation({
        mutationFn: ({ flag, note }: { flag: boolean; note?: string }) => api.spitballBriefUse(briefId, flag, note),
        onSuccess: (next) => { refresh(next); toast(next.brief.usedAt ? 'Recorded that you used this brief.' : 'Use record cleared.'); },
        onError: fail
    });

    if (query.isPending) return <div className="empty">Loading…</div>;
    if (query.isError) return <div className="empty">{(query.error as Error).message}</div>;
    const detail = query.data;
    const { brief, rendered, quality } = detail;
    const saving = overlay.isPending || review.isPending;

    return (
        <div className="mtab brief-view">
            <div className="hint usage-legend">
                <button type="button" className="btn small" onClick={onBack}>← Expedition</button>
                <span className="key">Brief #{brief.id} · {brief.status.toLowerCase()}{brief.generatedAt ? ` · ${when(brief.generatedAt)}` : ''}</span>
                {brief.status === 'READY' && (
                    <a className="btn small" href={api.spitballBriefExportUrl(brief.id)} download>Export Markdown</a>
                )}
                <button type="button" className="btn small" onClick={() => refresh()}>Refresh</button>
            </div>

            {brief.status === 'FAILED' && (
                <div className="list-card"><div className="list-row"><div className="row-body">
                    <span className="badge danger">⚠️ generation failed</span> {brief.errorCode}
                    {brief.lastError ? <div className="row-meta">{brief.lastError}</div> : null}
                    <div className="row-meta">This attempt stays on record and counts toward the expedition's cost.</div>
                </div></div></div>
            )}
            {brief.status === 'GENERATING' && <div className="empty">Writing the brief from the expedition's evidence…</div>}

            {brief.status === 'READY' && rendered && quality && (
                <>
                    <div className="list-card brief-status">
                        <div className="list-row"><div className="row-body">
                            <span className={`badge brief-quality ${quality.status}`} title={QUALITY_COPY[quality.status].hint}>{QUALITY_COPY[quality.status].label}</span>
                            <span className={`badge${brief.acceptedAt ? ' state-verified' : ''}`}>{brief.acceptedAt ? `accepted ${when(brief.acceptedAt)}` : 'not accepted'}</span>
                            <span className={`badge${brief.usedAt ? ' state-verified' : ''}`}>{brief.usedAt ? `used ${when(brief.usedAt)}` : 'not used yet'}</span>
                            <span className="badge">edits: {rendered.editType}</span>
                            {detail.integrity === 'mismatch' && <span className="badge danger">generated text integrity mismatch</span>}
                            <div className="row-meta">
                                {QUALITY_COPY[quality.status].hint}
                                {quality.reasons.length > 0 ? ` (${quality.reasons.join('; ')})` : ''}
                                {quality.unreviewed.length > 0 ? ` Outstanding: ${quality.unreviewed.join('; ')}.` : ''}
                            </div>
                            <div className="row-meta">
                                Acceptance and use are your explicit records; neither is implied by a finished generation or by the quality bar.
                                {brief.model.provider ? ` Model ${brief.model.provider}${brief.model.name ? `/${brief.model.name}` : ''}.` : ''}
                            </div>
                            <div className="brief-actions">
                                <button type="button" className="btn small" disabled={accept.isPending} onClick={() => accept.mutate(!brief.acceptedAt)}>
                                    {brief.acceptedAt ? 'Withdraw acceptance' : 'Accept this brief'}
                                </button>
                                {brief.usedAt ? (
                                    <button type="button" className="btn small" disabled={used.isPending} onClick={() => used.mutate({ flag: false })}>Clear use record</button>
                                ) : (
                                    <>
                                        <input className="input brief-use-note" placeholder="What did it inform? (optional)" value={useNote} maxLength={500} onChange={(e) => setUseNote(e.target.value)} aria-label="Use note" />
                                        <button type="button" className="btn small" disabled={used.isPending} onClick={() => used.mutate({ flag: true, note: useNote.trim() || undefined })}>Mark as used</button>
                                    </>
                                )}
                            </div>
                            {brief.useNote ? <div className="row-meta">Used for: {brief.useNote}</div> : null}
                        </div></div>
                    </div>

                    <div className="section-title">Summary</div>
                    <div className="list-card"><div className="list-row"><div className="row-body">
                        <EditableBlock block={rendered.summary} target="summary" onSave={(edit) => overlay.mutateAsync(edit)} saving={saving} />
                    </div></div></div>

                    <div className="section-title">Key findings</div>
                    <div className="list-card">
                        {rendered.findings.map((f) => (
                            <div className="list-row" key={f.id}><div className="row-body">
                                <EditableBlock block={f} target={`finding:${f.id}`} label={f.id} onSave={(edit) => overlay.mutateAsync(edit)} saving={saving} />
                                {detail.review?.marks?.[f.id] ? <div className="row-meta">owner mark: {detail.review.marks[f.id]}</div> : null}
                            </div></div>
                        ))}
                    </div>

                    <div className="section-title">Limitations</div>
                    <div className="list-card">
                        {rendered.limitations.length === 0 && rendered.evidenceNotes.length === 0 && <div className="empty">None stated.</div>}
                        {rendered.limitations.map((l) => (
                            <div className="list-row" key={l.id}><div className="row-body">
                                <EditableBlock block={l} target={`limitation:${l.id}`} label={(l.kind || 'other').replace(/_/g, ' ')} onSave={(edit) => overlay.mutateAsync(edit)} saving={saving} />
                            </div></div>
                        ))}
                        {rendered.evidenceNotes.map((note, index) => (
                            <div className="list-row brief-evidence-note" key={`${note.kind}-${index}`}><div className="row-body">
                                <span className="badge">{note.kind.replace(/_/g, ' ')}</span> {note.text}
                                <div className="row-meta">Derived from the stored evidence, not written by the model.</div>
                            </div></div>
                        ))}
                    </div>

                    <div className="section-title">Sources</div>
                    <div className="list-card">
                        {rendered.citations.length === 0 && <div className="empty">No stored claim was cited.</div>}
                        {rendered.citations.map((c) => (
                            <div className="list-row" key={c.n} id={`brief-source-${c.n}`}><div className="row-body">
                                <strong>[{c.n}]</strong> {c.claimText}
                                <div className="row-meta">
                                    {c.sourceTitle ? (c.url ? <a href={c.url} target="_blank" rel="noreferrer noopener">{c.sourceTitle}</a> : c.sourceTitle) : `source #${c.sourceId}`}
                                    {c.publisher ? ` · ${c.publisher}` : ''}
                                    {` · claim ${c.claimId} · confidence ${c.confidence.toFixed(2)}`}
                                    {c.publishedAt ? ` · published ${c.publishedAt.slice(0, 10)}` : ' · no publication date'}
                                    {c.retrievedAt ? ` · retrieved ${c.retrievedAt.slice(0, 10)}` : ''}
                                </div>
                            </div></div>
                        ))}
                    </div>

                    <div className="section-title">Review</div>
                    <ReviewPanel key={brief.reviewRevision} detail={detail} onSave={(body) => review.mutateAsync(body).then(() => undefined)} saving={saving} />
                </>
            )}
        </div>
    );
}

/** The Briefs section on an expedition's detail view: list, write, open. */
export function ExpeditionBriefs({ expedition, onOpen }: { expedition: Expedition; onOpen: (briefId: number) => void }) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const list = useQuery({
        queryKey: keys.spitballBriefs(expedition.id),
        queryFn: () => api.spitballBriefs(expedition.id),
        refetchInterval: (q) => ((q.state.data?.briefs || []).some((b) => b.status === 'GENERATING') ? 3000 : false)
    });
    const generate = useMutation({
        mutationFn: () => api.spitballGenerateBrief(expedition.id),
        onSuccess: (detail) => {
            queryClient.invalidateQueries({ queryKey: keys.spitballBriefs(expedition.id) });
            queryClient.setQueryData(keys.spitballBrief(detail.brief.id), detail);
            if (detail.brief.status === 'FAILED') toast(`The brief could not be written (${detail.brief.errorCode}). The attempt is kept on record.`, true);
            else toast('Brief written from the expedition\'s evidence.');
            onOpen(detail.brief.id);
        },
        onError: (error) => toast((error as Error).message, true)
    });
    const active = ['QUEUED', 'RUNNING'].includes(expedition.status);
    const briefs: BriefSummary[] = list.data?.briefs || [];

    return (
        <>
            <div className="section-title">Briefs</div>
            <div className="hint usage-legend">
                <span className="key">A private brief written from this expedition's stored sources and claims. Your edits stay separate from the generated text.</span>
                <button type="button" className="btn small primary" disabled={active || generate.isPending} title={active ? 'Wait for the expedition to stop' : undefined} onClick={() => generate.mutate()}>
                    {generate.isPending ? 'Writing…' : 'Write brief'}
                </button>
            </div>
            {list.isPending && <div className="empty">Loading…</div>}
            {list.data && briefs.length === 0 && <div className="empty">No brief yet.</div>}
            {briefs.length > 0 && (
                <div className="list-card">
                    {briefs.map((b) => (
                        <div key={b.id} className="list-row list-row-click" onClick={() => onOpen(b.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(b.id); }}>
                            <div className="row-body">
                                <span className="badge">{b.status === 'READY' ? '📄' : b.status === 'FAILED' ? '⚠️' : '⏳'} brief #{b.id}</span>
                                {b.status === 'READY' && b.quality ? <span className={`badge brief-quality ${b.quality}`}>{QUALITY_COPY[b.quality].label}</span> : null}
                                {b.acceptedAt ? <span className="badge state-verified">accepted</span> : null}
                                {b.usedAt ? <span className="badge state-verified">used</span> : null}
                                <div className="row-meta">
                                    {b.status === 'READY' ? `${b.findings} finding${b.findings === 1 ? '' : 's'} · edits: ${b.editType}` : b.status === 'FAILED' ? `failed: ${b.errorCode}` : 'writing…'}
                                    {' · '}{when(b.generatedAt || b.createdAt)}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}
