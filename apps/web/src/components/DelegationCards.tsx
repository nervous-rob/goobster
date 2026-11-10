import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { useDateLabel } from '../hooks/useDateLabel';
import { useMe } from '../hooks/useSession';
import { describeGrants, describeListening, describeSharing, externalOperationsPerDay, reachesGitHub, type Project } from '../rooms/assistant/grants';
import { GateDecision } from './GateDecision';
import type { Responsibility } from '../lib/types';

/**
 * Delegation cards under a chat reply (documentation/delegated_conversation.md).
 *
 * A reply carries only a reference: the id of a draft the conversation
 * proposed, or the references of open requests. Each card reads the record
 * with the person's own session and shows that, never the reply's wording.
 * Turning a draft on, or deciding a request, first asks the server for a
 * single-use confirmation of exactly what is on the card, then spends it.
 * Only a press here does that: nothing in a reply can.
 */

const STATUS_TEXT: Record<string, string> = {
    ACTIVE: 'on', PAUSED: 'paused', NEEDS_REVIEW: 'waiting for your review', COMPLETED: 'completed',
    REVOKED: 'revoked', EXPIRED: 'expired', ARCHIVED: 'archived', DRAFT: 'a draft'
};

const proposalKey = (id: number) => ['assistant-responsibility', id] as const;
const gateKey = (ref: string) => ['assistant-gate', ref] as const;

export function ProposalCard({ id }: { id: number }) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const whenLabel = useDateLabel();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const [discarded, setDiscarded] = useState(false);
    const draft = useQuery({
        queryKey: proposalKey(id),
        queryFn: () => api.responsibility(id),
        retry: false,
        enabled: !discarded
    });
    const item: Responsibility | undefined = draft.data?.responsibility;
    const needsProjects = Boolean(item?.operations.some((entry) => entry.resource.kind === 'project'));
    const projectsQ = useQuery({
        queryKey: keys.observatory,
        queryFn: () => api.observatoryProjects() as Promise<{ projects: Project[] }>,
        enabled: needsProjects
    });
    const projects = new Map((projectsQ.data?.projects || []).map((project) => [String(project.id), project]));

    const refresh = () => Promise.all([
        queryClient.invalidateQueries({ queryKey: proposalKey(id) }),
        queryClient.invalidateQueries({ queryKey: keys.responsibilities }),
        queryClient.invalidateQueries({ queryKey: keys.home })
    ]);

    async function run(name: string, work: () => Promise<void>) {
        setBusy(name);
        try {
            await work();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            await refresh();
            setBusy(null);
        }
    }

    const turnOn = (shown: Responsibility) => run('activate', async () => {
        // The confirmation is for the revision on this card: a draft that
        // changed since is refused here, and the card reloads.
        const confirmation = await api.confirmResponsibility(shown.id, 'activate', shown.revision, 'chat');
        await api.responsibilityAction(shown.id, 'activate', shown.revision, confirmation.receipt);
        toast(`"${shown.title}" is on.`);
    });
    const keep = (shown: Responsibility) => run('keep', async () => {
        await api.proposalAction(shown.id, 'keep', shown.revision);
        toast('Kept as a draft in Responsibilities.');
    });
    const discard = (shown: Responsibility) => run('discard', async () => {
        if (!await confirm(`Discard the draft "${shown.title}"? It never ran, and it is deleted.`)) return;
        await api.proposalAction(shown.id, 'discard', shown.revision);
        setDiscarded(true);
    });

    const frame = (body: React.ReactNode, state = '') => (
        <div className={`tool-card tool-card-proposal${state}`} data-testid="proposal-card" data-proposal-id={id}>{body}</div>
    );

    if (discarded) return frame(<div className="hint" data-testid="proposal-state">Discarded. Nothing was turned on.</div>);
    if (draft.isPending) return frame(<div className="hint">Loading the draft…</div>);
    if (draft.isError || !item) {
        const gone = draft.error instanceof ApiError && draft.error.status === 404;
        return frame(
            <div className="hint" data-testid="proposal-state">
                {gone ? 'This draft is gone: it was discarded, or it was never confirmed and has been removed. Nothing was turned on.'
                    : (draft.error as Error | null)?.message || 'This draft could not be loaded.'}
            </div>
        );
    }

    const head = (
        <div className="tool-card-head">
            <strong>{item.title}</strong>{' '}
            <span className="badge" data-testid="proposal-status">{item.status === 'DRAFT' ? 'draft · not on' : STATUS_TEXT[item.status] || item.status.toLowerCase()}</span>
        </div>
    );

    if (item.status !== 'DRAFT') {
        return frame(
            <>
                {head}
                <div className="hint" data-testid="proposal-state">
                    This responsibility is {STATUS_TEXT[item.status] || item.status.toLowerCase()}.{' '}
                    <Link to="/assistant" hash={`responsibility-${item.id}`}>Manage it in Responsibilities →</Link>
                </div>
            </>,
            item.status === 'ACTIVE' ? ' is-success' : ''
        );
    }

    const grants = describeGrants(item.operations, projects);
    // Where it would take requests from is part of what is being turned on.
    const listening = describeListening(item, me.assistant.name);
    const sharing = describeSharing(item);
    return frame(
        <>
            {head}
            {item.outcome && <div className="tool-card-row">{item.outcome}</div>}
            <div className="tool-card-row">If you turn this on, {me.assistant.name} may, as you:</div>
            <ul className="assistant-grants" data-testid="proposal-grants">
                {grants.map((line) => <li key={line}>{line}</li>)}
                {listening && <li data-testid="proposal-listens">{listening}; only your own messages are read for this</li>}
                {sharing && <li data-testid="proposal-shares">{sharing}</li>}
            </ul>
            <div className="hint">
                {item.rules?.autoStart ? 'It would start proposed work by itself, within its daily budgets.' : 'Each piece of work waits for you to press Start.'}{' '}
                {reachesGitHub(item.operations) && `Pushes and pull requests would go to GitHub as you and cannot be undone from here; at most ${externalOperationsPerDay(item.budgets)} a day. `}
                {item.expiresAt ? `It ends ${whenLabel(item.expiresAt)}.` : 'It has no end date.'}{' '}
                Nothing is running, and it allows nothing until you turn it on. You can pause or revoke it at any time.
            </div>
            <div className="tool-card-actions" role="group" aria-label={`Draft responsibility: ${item.title}`}>
                <button type="button" className="btn small primary" disabled={busy !== null} onClick={() => void turnOn(item)}>
                    {busy === 'activate' ? 'Turning on…' : 'Turn on'}
                </button>
                {!item.proposal?.keptAt && (
                    <button type="button" className="btn small" disabled={busy !== null} onClick={() => void keep(item)}>Keep as draft</button>
                )}
                <button type="button" className="btn small subtle" disabled={busy !== null} onClick={() => void discard(item)}>Discard</button>
                <Link to="/assistant" hash={`responsibility-${item.id}`} className="btn small subtle">Review or edit</Link>
            </div>
            {item.proposal?.keptAt && <div className="hint" data-testid="proposal-state">Kept as a draft in Responsibilities.</div>}
        </>
    );
}

function RequestCard({ gateRef }: { gateRef: string }) {
    const gate = useQuery({ queryKey: gateKey(gateRef), queryFn: () => api.gateCard(gateRef), retry: false });
    if (gate.isPending) return <div className="tool-card"><div className="hint">Loading the request…</div></div>;
    const card = gate.data?.card;
    if (gate.isError || !card) {
        return (
            <div className="tool-card" data-testid="request-card">
                <div className="hint">This request is no longer open.</div>
            </div>
        );
    }
    return (
        <div className={`tool-card tool-card-request${card.state === 'resolved' ? ' is-success' : ''}`} data-testid="request-card" data-gate-ref={card.ref}>
            <div className="tool-card-head"><strong>{card.title}</strong></div>
            {card.state === 'open'
                ? <GateDecision card={card} surface="chat" />
                : <div className="hint">{card.outcome || 'This request has been settled.'}</div>}
        </div>
    );
}

export function RequestsCard({ refs }: { refs: string[] }) {
    return <>{refs.slice(0, 8).map((ref) => <RequestCard key={ref} gateRef={ref} />)}</>;
}
