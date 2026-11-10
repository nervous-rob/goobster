import { useId, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import type { GateDecisionCard, GateDecisionOption, GateSurface } from '../lib/types';

/**
 * The decision buttons of one request, wherever it is shown
 * (documentation/assistant_home.md, "Deciding a request where it is shown").
 *
 * Home and the Inbox render the card the server described and post the
 * choice with the card's occurrence and revision; the service that owns the
 * request decides. Nothing here knows what a kind means. A card that has
 * changed since it was shown is refused by the server: the refusal says what
 * the request is now, and the refetch below shows it.
 */

/** Other places that show a request of this kind, refetched once it is settled. */
const ALSO_REFRESH: Record<string, QueryKey[]> = {
    friend_request: [keys.friends],
    access_request: [['admin-accounts'], ['admin-access-requests']],
    project_approve: [['project-mission'], ['project-needs-you'], ['project-now']],
    note_proposal: [keys.assistantKnowledge, ['knowledge']],
    source_retraction: [keys.assistantKnowledge, ['knowledge']]
};

export function GateDecision({ card, surface }: { card: GateDecisionCard; surface: GateSurface }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const detailId = useId();
    const [busy, setBusy] = useState<string | null>(null);
    if (card.state !== 'open' || card.options.length === 0) return null;
    const diff = card.diff || [];

    const refresh = () => Promise.all(
        [['inbox'], keys.home, keys.me, ...(ALSO_REFRESH[card.kind] || [])]
            .map((queryKey) => queryClient.invalidateQueries({ queryKey }))
    );

    async function decide(option: GateDecisionOption) {
        if (option.danger && !(await confirm(`${option.label}? ${option.effect || card.detail || ''}`.trim()))) return;
        setBusy(option.id);
        try {
            const { decided } = await api.decideGate(card, option.id, surface);
            toast(decided.message);
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            await refresh();
            setBusy(null);
        }
    }

    return (
        <div className="gate-decision" role="group" aria-label={card.title} data-testid="gate-decision" data-gate-kind={card.kind}>
            {diff.length > 0 && (
                <div className="gate-diff" data-testid="gate-diff" role="group" aria-label="What would change">
                    {diff.map((entry, index) => (
                        <div key={index} className={`gate-diff-line gate-diff-${entry.op}`} data-op={entry.op}>
                            <span aria-hidden="true">{entry.op === 'add' ? '+ ' : entry.op === 'del' ? '- ' : '  '}</span>
                            <span className="sr-only">{entry.op === 'add' ? 'Added: ' : entry.op === 'del' ? 'Removed: ' : entry.op === 'skip' ? '' : 'Unchanged: '}</span>
                            {entry.text}
                        </div>
                    ))}
                </div>
            )}
            {card.options.map((option, index) => (
                <button key={option.id} type="button"
                    className={`btn small${option.danger ? ' danger' : index === 0 ? ' primary' : ''}`}
                    disabled={busy !== null} title={option.effect || undefined}
                    aria-describedby={card.detail ? detailId : undefined}
                    onClick={() => void decide(option)}>
                    {busy === option.id ? 'Working…' : option.label}
                </button>
            ))}
            {card.detail && <span id={detailId} className="hint">{card.detail}</span>}
        </div>
    );
}
