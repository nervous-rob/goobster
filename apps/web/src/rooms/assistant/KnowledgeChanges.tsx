import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { useDateLabel } from '../../hooks/useDateLabel';
import type { KnowledgeChange } from '../../lib/types';

/**
 * What delegated runs proposed, changed and archived in the person's own
 * notes, with the ways to undo it (documentation/delegated_knowledge.md).
 *
 * A proposal is decided where every request is (Home and the Inbox); it is
 * listed here so it is not lost. Undo and Restore are the person's own
 * actions and always work: a change stays reversible after the pilot closes.
 */

const KIND_TEXT: Record<KnowledgeChange['kind'], string> = {
    saved_note_edit: 'Suggested change',
    direct_change: 'Changed directly',
    source_retraction: 'Source review'
};

/** A change the person made by giving feedback on a finding (documentation/delegated_feedback.md). */
const FEEDBACK_TEXT: Record<string, string> = {
    FEEDBACK_WRONG: 'You said this was wrong',
    FEEDBACK_KEEP: 'You kept this wording'
};

const STATUS_TEXT: Record<KnowledgeChange['status'], string> = {
    PROPOSED: 'Waiting for you',
    APPLIED: 'Applied',
    REJECTED: 'Dismissed',
    STALE: 'Out of date',
    REVERTED: 'Undone'
};

export function KnowledgeChanges() {
    const toast = useToast();
    const confirm = useConfirm();
    const whenLabel = useDateLabel();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const query = useQuery({ queryKey: keys.assistantKnowledge, queryFn: () => api.assistantKnowledge(), retry: false });
    const data = query.data;
    if (!data) return null;
    const empty = !data.proposals.length && !data.changes.length && !data.archived.length && !data.retractedLinks.length;
    if (empty) return null;

    async function run(key: string, action: () => Promise<unknown>, message: string) {
        setBusy(key);
        try {
            await action();
            toast(message);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.assistantKnowledge }),
                queryClient.invalidateQueries({ queryKey: ['knowledge'] }),
                queryClient.invalidateQueries({ queryKey: keys.home }),
                queryClient.invalidateQueries({ queryKey: ['inbox'] })
            ]);
            setBusy(null);
        }
    }

    async function undo(change: KnowledgeChange) {
        if (!await confirm(`Undo this change to "${change.label || 'your note'}"? It is put back as it was, if you have not edited it since.`)) return;
        await run(`change-${change.id}`, () => api.revertKnowledgeChange(change.id), 'Put back.');
    }

    return (
        <section className="list-card" style={{ marginTop: 22 }} aria-labelledby="knowledge-changes-title" data-testid="knowledge-changes">
            <h2 id="knowledge-changes-title">Changes to your notes</h2>
            {data.proposals.length > 0 && (
                <div data-testid="knowledge-proposals">
                    <p className="hint">
                        {data.proposals.length === 1 ? 'One suggestion is' : `${data.proposals.length} suggestions are`} waiting for you.
                        Apply or dismiss {data.proposals.length === 1 ? 'it' : 'them'} from <Link to="/">Home</Link> or the Inbox; nothing changes until you do.
                    </p>
                    <ul>
                        {data.proposals.map((change) => (
                            <li key={change.id} data-testid="knowledge-proposal">
                                <strong>{KIND_TEXT[change.kind]}</strong>{change.label ? `: ${change.label}` : ''}
                                {change.rationale && <span className="hint"> - {change.rationale}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {data.changes.length > 0 && (
                <ul data-testid="knowledge-change-list">
                    {data.changes.map((change) => (
                        <li key={change.id} data-testid="knowledge-change" data-status={change.status}>
                            <strong>{FEEDBACK_TEXT[change.policy || ''] || KIND_TEXT[change.kind]}</strong>{change.label ? `: ${change.label}` : ''}
                            {' '}<span className="hint">{STATUS_TEXT[change.status]} {whenLabel(change.decidedAt || change.createdAt)}</span>
                            {change.claimStatus && <span className="hint"> (marked {change.claimStatus.to})</span>}
                            {change.kept && <span className="hint"> (kept as yours)</span>}
                            {change.impact && (
                                <span className="hint"> - {change.impact.notes.length + change.impact.moreNotes} notes and {change.impact.assumptions.length} project assumptions rest on this source; it is unverifiable, not false</span>
                            )}
                            {change.revertible && (
                                <button type="button" className="btn small subtle" style={{ marginLeft: 8 }} disabled={busy !== null}
                                    onClick={() => void undo(change)} data-testid="knowledge-undo">
                                    {busy === `change-${change.id}` ? 'Working…' : 'Undo'}
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {data.archived.length > 0 && (
                <div data-testid="knowledge-archived">
                    <h3>Archived notes</h3>
                    <ul>
                        {data.archived.map((note) => (
                            <li key={note.id} data-testid="knowledge-archived-note">
                                {note.label}{' '}
                                <span className="hint">
                                    {note.mergedInto ? `merged into ${note.mergedInto.label || 'another note'}` : note.archivedBy === 'run' ? 'archived by an assistant run' : 'archived'}
                                    {note.connections ? `, ${note.connections} connection${note.connections === 1 ? '' : 's'}` : ''}
                                </span>
                                <button type="button" className="btn small subtle" style={{ marginLeft: 8 }} disabled={busy !== null}
                                    onClick={() => void run(`note-${note.id}`, () => api.restoreKnowledgeNote(note.id), 'Restored.')}
                                    data-testid="knowledge-restore-note">
                                    {busy === `note-${note.id}` ? 'Working…' : 'Restore'}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {data.retractedLinks.length > 0 && (
                <div data-testid="knowledge-retracted-links">
                    <h3>Retracted connections</h3>
                    <ul>
                        {data.retractedLinks.map((link) => (
                            <li key={link.id}>
                                {link.from} <span className="hint">{link.relation}</span> {link.to}
                                <button type="button" className="btn small subtle" style={{ marginLeft: 8 }} disabled={busy !== null}
                                    onClick={() => void run(`link-${link.id}`, () => api.restoreKnowledgeConnection(link.id), 'Restored.')}
                                    data-testid="knowledge-restore-link">
                                    {busy === `link-${link.id}` ? 'Working…' : 'Restore'}
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}
