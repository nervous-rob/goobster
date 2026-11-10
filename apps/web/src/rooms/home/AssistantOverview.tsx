import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { formatRelativeTime } from '../../lib/atmosphere';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { GateDecision } from '../../components/GateDecision';
import type {
    AssistantAction, AssistantBriefItem, AssistantComponent, AssistantHome, AssistantNeedsYouItem
} from '../../lib/types';

/**
 * The assistant overview at the top of Home (documentation/assistant_home.md).
 *
 * Everything here is read from records: the status line is derived from
 * counts, never generated. Loading or scrolling this marks nothing read;
 * "Mark reviewed" acknowledges exactly the revisions it lists and never
 * resolves a request. A request whose kind can be decided in place carries
 * its decision card, rendered by <GateDecision> exactly as the Inbox renders
 * it; any other request links to where it is decided. Unseen updates, open
 * requests, running work and blocked processes are separate,
 * separately-labelled numbers. A process that is blocked or running with a
 * problem stays on its card after the update about it was reviewed: its
 * health is judged, not read. A count the server could not read is shown as
 * unknown, not as zero.
 */

const COMPONENT_META: Record<AssistantComponent['id'], { label: string; mark: string; to: string; hash?: string; what: string }> = {
    knowledge: { label: 'Knowledge', mark: '🧠', to: '/knowledge', what: 'What changed in what you keep' },
    research: { label: 'Research', mark: '🧭', to: '/knowledge', what: 'Questions looked into and what was found' },
    projects: { label: 'Projects', mark: '🔭', to: '/projects', what: 'Work carried forward' },
    processes: { label: 'Processes', mark: '🗓️', to: '/assistant', hash: 'processes', what: 'Recurring work: is it working, and is it still needed' },
    conversations: { label: 'Conversations', mark: '💬', to: '/chat', what: 'Threads worth picking up' }
};

const STATE_TEXT: Record<AssistantComponent['state'], { text: string; mark: string }> = {
    needs_you: { text: 'Needs you', mark: '◆' },
    blocked: { text: 'Blocked', mark: '■' },
    degraded: { text: 'Running with a problem', mark: '▲' },
    working: { text: 'Working', mark: '▶' },
    updates: { text: 'New updates', mark: '●' },
    quiet: { text: 'Up to date', mark: '○' },
    unknown: { text: 'Status unknown', mark: '?' },
    unavailable: { text: 'Unavailable here', mark: '–' }
};

const REQUEST_LABEL: Record<string, string> = {
    access_request: 'Someone is asking to join',
    friend_request: 'Friend request',
    project_approve: 'Plan to approve',
    project_review: 'Work to review',
    project_unblock: 'Blocked work',
    project_answer: 'A question for you',
    process_repair: 'Repair to review',
    process_retirement: 'Still needed?',
    responsibility_review: 'Responsibility to review',
    connector_request: 'An outside action to approve'
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where a typed, server-derived action leads. Navigation grants nothing. */
function actionPath(action: AssistantAction | undefined): { to: string; hash?: string } | null {
    if (!action) return null;
    if (action.kind === 'open_project' || action.kind === 'open_review') {
        const [owner, slug] = String(action.id).split('/');
        return { to: owner && slug ? `/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}` : '/projects' };
    }
    if (action.kind === 'open_responsibility' || action.kind === 'open_initiative') return { to: '/assistant' };
    if (action.kind === 'open_process') return { to: '/assistant', hash: 'processes' };
    if (action.kind === 'open_conversation') return { to: /^\d+$/.test(String(action.id)) ? `/discussions/${action.id}` : '/discussions' };
    if (action.kind === 'open_chat') return { to: /^\d+$/.test(String(action.id)) ? `/chat/${action.id}` : '/chat' };
    return null;
}

/** The conversation an update came from, when it names one and that is not already where "Open" leads. */
function conversationPath(actions: AssistantAction[] | undefined): string | null {
    const index = (actions || []).findIndex((action) => action.kind === 'open_conversation' || action.kind === 'open_chat');
    return index > 0 ? actionPath(actions?.[index])?.to ?? null : null;
}

function statusLine(assistant: AssistantHome): string {
    const counts = assistant.responsibilities.counts;
    if (assistant.hostPaused && assistant.availability !== 'unavailable') {
        return 'The host has stopped all delegated work for now. Nothing is lost; it continues when they resume it.';
    }
    switch (assistant.availability) {
        case 'unavailable': return 'Delegated work is turned off on this installation.';
        case 'attention_off': return 'Attention is off, so nothing is delegated and no new work starts.';
        case 'none_delegated': return 'Nothing delegated yet.';
        case 'paused': return counts ? `${plural(counts.paused + counts.needsReview, 'responsibility', 'responsibilities')} paused or waiting for review. Nothing is running.` : 'Paused.';
        case 'unknown': return 'Could not read the current state. Try again in a moment.';
        default: return counts ? `Looking after ${plural(counts.active, 'responsibility', 'responsibilities')}` : 'Looking after your responsibilities';
    }
}

function ComponentCard({ component }: { component: AssistantComponent }) {
    const meta = COMPONENT_META[component.id];
    const state = STATE_TEXT[component.state];
    const signals: string[] = [];
    if (component.needsAction) signals.push(`${component.needsAction} needs you`);
    if (component.blocked) signals.push(`${component.blocked} not working`);
    if (component.degraded) signals.push(`${component.degraded} with a problem`);
    if (component.unseen) signals.push(plural(component.unseen, 'new update'));
    if (component.running) signals.push(`${component.running} working`);
    const detail = signals.length ? signals.join(' · ') : state.text;
    return (
        <Link to={meta.to as never} hash={meta.hash} className={`assistant-component is-${component.state}`} data-testid={`assistant-component-${component.id}`}
            aria-label={`${meta.label}: ${detail}. ${meta.what}.`}>
            <span className="assistant-component-name"><span aria-hidden="true">{meta.mark}</span> {meta.label}</span>
            <span className="assistant-component-state"><span aria-hidden="true">{state.mark}</span> {detail}</span>
        </Link>
    );
}

function NeedsYouRow({ item }: { item: AssistantNeedsYouItem }) {
    const target = actionPath(item.update?.actions?.[0]);
    return (
        <li className="assistant-row" data-testid="assistant-needs-you-item">
            <div className="assistant-row-main">
                <span className="badge">{(item.request && REQUEST_LABEL[item.request]) || 'Needs you'}</span>{' '}
                <strong>{item.title}</strong>
                {!item.read && <span className="inbox-dot" aria-label="unread" />}
                {/* A decision states what it changes; the notice's own text would say it twice. */}
                {item.body && !item.decision?.detail && <div className="hint">{item.body}</div>}
                {item.decision && <GateDecision card={item.decision} surface="home" />}
            </div>
            <div className="assistant-row-actions">
                {target && <Link to={target.to as never} hash={target.hash} className="btn subtle">Open →</Link>}
                <Link to="/activity/inbox" hash={`inbox-${item.inboxItemId}`} className="btn subtle">In Inbox</Link>
            </div>
        </li>
    );
}

function BriefRow({ item, onReviewed, busy }: { item: AssistantBriefItem; onReviewed: (items: AssistantBriefItem[]) => void; busy: boolean }) {
    const target = actionPath(item.actions?.[0]);
    const conversation = conversationPath(item.actions);
    return (
        <li className="assistant-row" data-testid="assistant-brief-item">
            <div className="assistant-row-main">
                <strong>{item.title}</strong>
                {item.summary && <div className="hint">{item.summary}</div>}
                {item.audience?.kind === 'project' && (
                    <div className="hint" data-testid="assistant-brief-producer">
                        Shared with this project
                        {item.producer && (item.producer.you ? ' by you' : ` by ${item.producer.name ? `${item.producer.name}'s` : 'a member\'s'} assistant`)}
                    </div>
                )}
                <div className="row-meta">
                    {item.componentIds.map((id) => COMPONENT_META[id as AssistantComponent['id']]?.label).filter(Boolean).join(' · ')}
                    {' · '}<span title={item.happenedAt}>{formatRelativeTime(`${item.happenedAt.replace(' ', 'T')}Z`)}</span>
                </div>
            </div>
            <div className="assistant-row-actions">
                {target && <Link to={target.to as never} hash={target.hash} className="btn subtle">Open →</Link>}
                {conversation && <Link to={conversation as never} className="btn subtle" data-testid="assistant-brief-conversation">Conversation</Link>}
                <button type="button" className="btn subtle" disabled={busy} onClick={() => onReviewed([item])}>Mark reviewed</button>
            </div>
        </li>
    );
}

export function AssistantOverview({ assistant }: { assistant: AssistantHome | null | undefined }) {
    const me = useMe();
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    if (!assistant) {
        return (
            <section className="assistant-overview" aria-labelledby="assistant-overview-title" data-testid="assistant-overview">
                <h2 id="assistant-overview-title" className="assistant-title">{me.assistant.name}</h2>
                <p className="hint" role="status">The assistant overview could not be loaded. The rest of Home still works.</p>
            </section>
        );
    }

    const refresh = () => Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.home }),
        queryClient.invalidateQueries({ queryKey: ['inbox'] }),
        queryClient.invalidateQueries({ queryKey: keys.me }),
        queryClient.invalidateQueries({ queryKey: keys.responsibilities })
    ]);

    async function markReviewed(items: AssistantBriefItem[]) {
        setBusy(true);
        try {
            // Exactly the revisions shown: a newer revision stays unseen.
            await api.acknowledgeUpdates(items.map((item) => ({ id: item.id, revision: item.revision })));
            await refresh();
        } catch (error) { toast((error as Error).message, true); } finally { setBusy(false); }
    }

    async function pauseAll() {
        const active = assistant!.responsibilities.items.filter((item) => item.status === 'ACTIVE');
        if (!active.length) return;
        const ok = await confirm(
            `Pause ${plural(active.length, 'active responsibility', 'active responsibilities')}? Nothing new starts until you resume each one. Nothing is deleted.`
        );
        if (!ok) return;
        setBusy(true);
        try {
            for (const item of active) await api.responsibilityAction(item.id, 'pause', item.revision);
            toast('Paused.');
        } catch (error) { toast((error as Error).message, true); } finally {
            await refresh();
            setBusy(false);
        }
    }

    const { counts, availability } = assistant;
    const on = availability !== 'unavailable';
    const hasActive = (assistant.responsibilities.counts?.active || 0) > 0;
    const needsCount = counts.needsAction;
    return (
        <section className="assistant-overview" aria-labelledby="assistant-overview-title" data-testid="assistant-overview">
            <header className="assistant-head">
                <div>
                    <h2 id="assistant-overview-title" className="assistant-title">{me.assistant.name}</h2>
                    <p className="assistant-status" data-testid="assistant-status">
                        {statusLine(assistant)}
                        {needsCount ? ` · ${needsCount} ${needsCount === 1 ? 'needs' : 'need'} you` : ''}
                        {counts.running ? ` · ${counts.running} working` : ''}
                    </p>
                    {assistant.freshness.state !== 'current' && on && availability !== 'none_delegated' && availability !== 'attention_off' && (
                        <p className="hint" data-testid="assistant-freshness">
                            {assistant.freshness.lastPassAt
                                ? `Last checked ${formatRelativeTime(assistant.freshness.lastPassAt)}; this may be out of date.`
                                : 'Not checked yet since this installation started.'}
                        </p>
                    )}
                    {assistant.partial.length > 0 && (
                        <p className="hint" role="status" data-testid="assistant-partial">Some of this could not be read just now and is shown as unknown.</p>
                    )}
                </div>
                <div className="assistant-head-actions">
                    <Link to="/chat" className="btn primary">Ask {me.assistant.name}</Link>
                    {hasActive && <button type="button" className="btn" disabled={busy} onClick={() => void pauseAll()}>Pause assistant work</button>}
                </div>
            </header>

            <section aria-labelledby="assistant-needs-you-title" className="assistant-section">
                <div className="assistant-section-head">
                    <h3 id="assistant-needs-you-title">Needs you{needsCount ? ` (${needsCount})` : ''}</h3>
                    <Link to="/activity/inbox" hash="needs-you" className="assistant-more">View all in Inbox →</Link>
                </div>
                {needsCount === null && <p className="hint">Could not read your requests just now.</p>}
                {needsCount === 0 && <p className="hint" data-testid="assistant-needs-you-empty">Nothing is waiting on you.</p>}
                {assistant.needsYou.length > 0 && (
                    <ul className="assistant-list">{assistant.needsYou.map((item) => <NeedsYouRow key={item.inboxItemId} item={item} />)}</ul>
                )}
            </section>

            {on && (
                <section aria-labelledby="assistant-brief-title" className="assistant-section">
                    <div className="assistant-section-head">
                        <h3 id="assistant-brief-title">What changed</h3>
                        {assistant.brief.length > 1 && (
                            <button type="button" className="btn subtle" disabled={busy} onClick={() => void markReviewed(assistant.brief)}>Mark all reviewed</button>
                        )}
                    </div>
                    {assistant.brief.length === 0
                        ? <p className="hint" data-testid="assistant-brief-empty">{counts.unseen === null ? 'Could not read updates just now.' : 'No important changes.'}</p>
                        : <ul className="assistant-list">{assistant.brief.map((item) => <BriefRow key={item.id} item={item} busy={busy} onReviewed={(items) => void markReviewed(items)} />)}</ul>}
                </section>
            )}

            {on && (
                <nav aria-label="Assistant components" className="assistant-components">
                    {assistant.components.map((component) => <ComponentCard key={component.id} component={component} />)}
                </nav>
            )}

            <section aria-labelledby="assistant-looking-after-title" className="assistant-section">
                <div className="assistant-section-head">
                    <h3 id="assistant-looking-after-title">Looking after</h3>
                    {on && <Link to="/assistant" className="assistant-more">Responsibilities →</Link>}
                </div>
                {!on && <p className="hint">The host has not turned on delegated work here.</p>}
                {on && availability === 'attention_off' && (
                    <p className="hint" data-testid="assistant-attention-off">
                        A responsibility can only run while Attention is on. Turn it on in{' '}
                        <Link to="/activity/attention">Activity → Attention</Link>; turning it on does not start anything by itself.
                    </p>
                )}
                {on && assistant.responsibilities.items.length === 0 && (
                    <p className="hint" data-testid="assistant-none-delegated">
                        Nothing delegated yet. A responsibility is a bounded job you hand over, such as keeping a project moving
                        or its notes current. Nothing starts until you write one and activate it.{' '}
                        <Link to="/assistant">Draft one →</Link>
                    </p>
                )}
                {assistant.responsibilities.items.length > 0 && (
                    <ul className="assistant-list">
                        {assistant.responsibilities.items.map((item) => {
                            const work = item.initiatives;
                            const parts = [
                                work.running ? `${work.running} working` : '',
                                work.review ? `${work.review} to review` : '',
                                work.waiting ? `${work.waiting} waiting` : '',
                                work.queued ? `${work.queued} queued` : '',
                                work.proposed ? `${work.proposed} proposed` : ''
                            ].filter(Boolean);
                            return (
                                <li key={item.id} className="assistant-row" data-testid="assistant-responsibility">
                                    <div className="assistant-row-main">
                                        <Link to="/assistant" hash={`responsibility-${item.id}`}><strong>{item.title}</strong></Link>
                                        {' '}<span className="badge">{item.status === 'NEEDS_REVIEW' ? 'needs review' : item.status.toLowerCase()}</span>
                                        <div className="row-meta">{parts.length ? parts.join(' · ') : 'No open work'}</div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
        </section>
    );
}
